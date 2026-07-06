import type { AccountImportResult, AccountImportOptions } from './account-import.service.js'
import {
  accountImportProtocolType,
  accountImportProtocolVersion,
  executeAccountImport,
  previewAccountImport
} from './account-import.service.js'
import type { AccessScope } from '../../storage/access-scope.js'
import {
  findAccountSummary,
  findApiKeySummary,
  findGroupSummary,
  listGroupOptions,
  listProviders,
  updateApiKey
} from '../../storage/repositories.js'

const maxSubscriptionBytes = 1024 * 1024
const subscriptionFetchTimeoutMs = 10000

export interface AccountImportSubscriptionInput {
  url: string
  headers?: Record<string, string>
}

export interface LoadedAccountImportSubscription {
  data: unknown
  meta: {
    origin: string
    pathname: string
    fetchedAt: string
    bytes: number
    normalized: boolean
  }
}

export interface AccountImportSubscriptionApiKeyBindingResult {
  apiKeyId: string
  apiKeyName?: string
  action: 'updated' | 'skipped' | 'failed'
  addedGroupIds: string[]
  messages: string[]
}

export interface AccountImportSubscriptionExecuteResult {
  subscription: LoadedAccountImportSubscription['meta']
  import: AccountImportResult
  apiKeyBindings: AccountImportSubscriptionApiKeyBindingResult[]
}

export async function loadAccountImportSubscription(input: AccountImportSubscriptionInput): Promise<LoadedAccountImportSubscription> {
  const url = normalizedSubscriptionUrl(input.url)
  const response = await fetch(url, {
    method: 'GET',
    headers: subscriptionHeaders(input.headers),
    redirect: 'follow',
    signal: AbortSignal.timeout(subscriptionFetchTimeoutMs)
  })
  if (!response.ok) {
    throw new Error(`订阅拉取失败：HTTP ${response.status}`)
  }

  const contentLength = Number(response.headers.get('content-length') ?? 0)
  if (contentLength > maxSubscriptionBytes) {
    throw new Error(`订阅内容过大，最大支持 ${maxSubscriptionBytes} 字节`)
  }
  const bytes = await readResponseBody(response)
  const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes).replace(/^\uFEFF/, '')
  const parsed = parseSubscriptionJson(text)
  const normalized = normalizeSubscriptionData(parsed)
  return {
    data: normalized.data,
    meta: {
      origin: url.origin,
      pathname: url.pathname,
      fetchedAt: new Date().toISOString(),
      bytes: bytes.byteLength,
      normalized: normalized.normalized
    }
  }
}

export function previewLoadedAccountImportSubscription(
  loaded: LoadedAccountImportSubscription,
  options: AccountImportOptions = {},
  access?: AccessScope
): AccountImportSubscriptionExecuteResult {
  return {
    subscription: loaded.meta,
    import: previewAccountImport(loaded.data, options, access),
    apiKeyBindings: []
  }
}

export function executeLoadedAccountImportSubscription(
  loaded: LoadedAccountImportSubscription,
  options: AccountImportOptions = {},
  access: AccessScope,
  bindApiKeyIds: string[] = []
): AccountImportSubscriptionExecuteResult {
  const importResult = executeAccountImport(loaded.data, options, access)
  const groupIds = importResult.imported
    ? collectImportGroupIds(loaded.data, importResult, access)
    : []
  const apiKeyBindings = appendGroupsToApiKeys(bindApiKeyIds, groupIds, access)
  return {
    subscription: loaded.meta,
    import: importResult,
    apiKeyBindings
  }
}

function normalizedSubscriptionUrl(value: string): URL {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error('订阅 URL 无效')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('订阅 URL 仅支持 http/https')
  }
  if (!url.hostname) {
    throw new Error('订阅 URL 缺少主机')
  }
  return url
}

function subscriptionHeaders(input?: Record<string, string>): Headers {
  const headers = new Headers({ accept: 'application/json, text/plain;q=0.9' })
  for (const [rawName, rawValue] of Object.entries(input ?? {})) {
    const name = rawName.trim().toLowerCase()
    const value = rawValue.trim()
    if (!name || !value) continue
    if (!/^[a-z0-9!#$%&'*+.^_`|~-]+$/.test(name)) {
      throw new Error(`订阅请求 Header 名称无效：${rawName}`)
    }
    if (name === 'host' || name === 'content-length' || name === 'transfer-encoding') {
      throw new Error(`订阅请求不允许设置 Header：${rawName}`)
    }
    headers.set(name, value)
  }
  return headers
}

async function readResponseBody(response: Response): Promise<Uint8Array> {
  if (!response.body) {
    return new Uint8Array()
  }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    if (!value) continue
    total += value.byteLength
    if (total > maxSubscriptionBytes) {
      throw new Error(`订阅内容过大，最大支持 ${maxSubscriptionBytes} 字节`)
    }
    chunks.push(value)
  }
  const output = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    output.set(chunk, offset)
    offset += chunk.byteLength
  }
  return output
}

function parseSubscriptionJson(text: string): unknown {
  const trimmed = text.trim()
  if (!trimmed) {
    throw new Error('订阅内容为空')
  }
  const direct = tryParseJson(trimmed)
  if (direct.success) return direct.data

  const decoded = tryDecodeBase64(trimmed)
  if (decoded !== undefined) {
    const parsed = tryParseJson(decoded)
    if (parsed.success) return parsed.data
  }
  throw new Error('订阅内容必须是 JSON，或 base64(JSON)')
}

function tryParseJson(text: string): { success: true; data: unknown } | { success: false } {
  try {
    return { success: true, data: JSON.parse(text) as unknown }
  } catch {
    return { success: false }
  }
}

function tryDecodeBase64(text: string): string | undefined {
  if (!/^[A-Za-z0-9+/=_-]+$/.test(text.replace(/\s+/g, ''))) return undefined
  try {
    return Buffer.from(text.replace(/\s+/g, ''), 'base64').toString('utf8')
  } catch {
    return undefined
  }
}

function normalizeSubscriptionData(data: unknown): { data: unknown; normalized: boolean } {
  if (Array.isArray(data)) {
    return {
      normalized: true,
      data: {
        type: accountImportProtocolType,
        version: accountImportProtocolVersion,
        accounts: data
      }
    }
  }
  if (!isRecord(data)) {
    throw new Error('订阅内容必须是对象或账号数组')
  }
  if (isRecord(data.data)) {
    const nested = normalizeSubscriptionData(data.data)
    return { data: nested.data, normalized: true }
  }
  if (data.type === accountImportProtocolType && data.version === accountImportProtocolVersion) {
    return { data, normalized: false }
  }
  if (Array.isArray(data.accounts)) {
    return {
      normalized: true,
      data: {
        ...data,
        type: accountImportProtocolType,
        version: accountImportProtocolVersion
      }
    }
  }
  throw new Error(`订阅内容缺少 ${accountImportProtocolType} 导入结构`)
}

function collectImportGroupIds(data: unknown, result: AccountImportResult, access: AccessScope): string[] {
  const groupIds = new Set<string>()
  for (const item of result.accounts) {
    if (!item.accountId) continue
    const account = findAccountSummary(item.accountId, access)
    if (account?.boundGroupId) groupIds.add(account.boundGroupId)
  }
  for (const account of rawImportAccounts(data)) {
    const groupId = textField(account, 'groupId')
    if (groupId && findGroupSummary(groupId, access)) {
      groupIds.add(groupId)
      continue
    }
    const groupName = textField(account, 'groupName')
    const providerCode = textField(account, 'providerCode')
    if (!groupName || !providerCode) continue
    const providerProtocolProfileId = resolveProviderProtocolProfileId(providerCode, textField(account, 'providerProtocolProfileId'))
    if (!providerProtocolProfileId) continue
    const group = listGroupOptions(access, {
      providerCode,
      providerProtocolProfileId,
      keyword: groupName,
      manageableOnly: true,
      limit: 50
    }).find((item) => item.providerProtocolProfileId === providerProtocolProfileId && sameText(item.name, groupName))
    if (group) groupIds.add(group.id)
  }
  return [...groupIds]
}

function appendGroupsToApiKeys(
  apiKeyIds: string[],
  groupIds: string[],
  access: AccessScope
): AccountImportSubscriptionApiKeyBindingResult[] {
  const targets = [...new Set(apiKeyIds.map((item) => item.trim()).filter(Boolean))]
  if (!targets.length) return []
  const uniqueGroupIds = [...new Set(groupIds)]
  return targets.map((apiKeyId) => {
    const current = findApiKeySummary(apiKeyId, access)
    if (!current) {
      return {
        apiKeyId,
        action: 'failed',
        addedGroupIds: [],
        messages: ['API Key 不存在或无权修改']
      }
    }
    const existingIds = new Set(current.groupBindings.map((binding) => binding.groupId))
    const missingGroupIds = uniqueGroupIds.filter((groupId) => !existingIds.has(groupId))
    if (!missingGroupIds.length) {
      return {
        apiKeyId,
        apiKeyName: current.name,
        action: 'skipped',
        addedGroupIds: [],
        messages: ['API Key 已包含订阅分组']
      }
    }
    const maxPriority = Math.max(0, ...current.groupBindings.map((binding) => binding.priority))
    const nextBindings = [
      ...current.groupBindings.map((binding) => ({
        groupId: binding.groupId,
        priority: binding.priority,
        weight: binding.weight,
        status: binding.status
      })),
      ...missingGroupIds.map((groupId, index) => ({
        groupId,
        priority: maxPriority + index + 1,
        weight: 1,
        status: 'active' as const
      }))
    ]
    try {
      const updated = updateApiKey(apiKeyId, { groupBindings: nextBindings }, access)
      if (!updated) {
        return {
          apiKeyId,
          apiKeyName: current.name,
          action: 'failed',
          addedGroupIds: [],
          messages: ['API Key 不存在或无权修改']
        }
      }
      return {
        apiKeyId,
        apiKeyName: updated.name,
        action: 'updated',
        addedGroupIds: missingGroupIds,
        messages: [`已追加绑定 ${missingGroupIds.length} 个订阅分组`]
      }
    } catch (error) {
      return {
        apiKeyId,
        apiKeyName: current.name,
        action: 'failed',
        addedGroupIds: [],
        messages: [error instanceof Error ? error.message : 'API Key 绑定订阅分组失败']
      }
    }
  })
}

function rawImportAccounts(data: unknown): Record<string, unknown>[] {
  if (!isRecord(data) || !Array.isArray(data.accounts)) return []
  return data.accounts.filter(isRecord)
}

function resolveProviderProtocolProfileId(providerCode: string, input?: string): string | undefined {
  const provider = listProviders().find((item) => item.code === providerCode)
  if (!provider) return undefined
  if (input) {
    const profile = provider.protocolProfiles.find((item) => item.id === input)
    return profile?.id
  }
  return provider.defaultProtocolProfileId
    ?? provider.protocolProfiles.find((item) => item.enabled)?.id
    ?? provider.protocolProfiles[0]?.id
}

function textField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key]
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function sameText(left: string, right: string): boolean {
  return left.trim().toLowerCase() === right.trim().toLowerCase()
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
