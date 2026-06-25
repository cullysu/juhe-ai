import { strict as assert } from 'node:assert'
import { pathToFileURL } from 'node:url'

import { runtimeConfig } from '../../config/runtime.js'
import type { AccountSummary, AccountSupportedEndpointMode } from '../../domain/types.js'
import { defaultOpenAIEndpointModes } from '../../domain/openai-endpoint-modes.js'
import { isOpenAIProtocolProfile } from '../../domain/provider-protocol.js'
import * as repositories from '../../storage/repositories.js'
import { mergeAccountCredentialsForUpdate } from '../../modules/accounts/account-credential-update.js'

export interface OpenAIEndpointModeBackfillCandidate {
  id: string
  name: string
  providerCode: string
  accountType: string
  clientCompatibility: string
  currentModes: AccountSupportedEndpointMode[]
  nextModes: AccountSupportedEndpointMode[]
  reason: string
}

export interface OpenAIEndpointModeBackfillResult {
  scannedCount: number
  candidateCount: number
  updatedCount: number
  skippedCount: number
  candidates: OpenAIEndpointModeBackfillCandidate[]
}

export interface OpenAIEndpointModeBackfillOptions {
  apply?: boolean
}

const expectedModes = defaultOpenAIEndpointModes({
  providerCode: 'openai',
  accountType: 'api_key',
  clientCompatibility: 'openai_standard'
})

const argvPath = process.argv[1]
if (argvPath && import.meta.url === pathToFileURL(argvPath).href) {
  main()
}

export function runOpenAIEndpointModeBackfill(options: OpenAIEndpointModeBackfillOptions = {}): OpenAIEndpointModeBackfillResult {
  const candidates = loadOpenAIEndpointModeBackfillCandidates()
  const result: OpenAIEndpointModeBackfillResult = {
    scannedCount: candidates.length,
    candidateCount: candidates.length,
    updatedCount: 0,
    skippedCount: 0,
    candidates
  }

  if (!options.apply) {
    return result
  }

  const access = { systemAccountId: 'sys_admin', role: 'admin' as const }
  for (const candidate of candidates) {
    const account = assertAccountSummary(repositories.findAccountSummary(candidate.id, access), candidate.id)
    const updated = repositories.updateAccount(candidate.id, {
      credentials: mergeAccountCredentialsForUpdate(account, { supported_endpoint_modes: candidate.nextModes })
    }, access)
    if (updated) {
      result.updatedCount += 1
    } else {
      result.skippedCount += 1
    }
  }
  return result
}

export function loadOpenAIEndpointModeBackfillCandidates(): OpenAIEndpointModeBackfillCandidate[] {
  const access = { systemAccountId: 'sys_admin', role: 'admin' as const }
  const accounts = repositories.listAccounts(access, { page: 1, pageSize: 50_000 })
  return accounts
    .filter((account) => isLegacyOpenAIAccount(account))
    .map((account) => toCandidate(account))
}

function isLegacyOpenAIAccount(account: AccountSummary): boolean {
  if (account.type !== 'api_key') return false
  if (!isOpenAIProtocolProfile(account)) return false
  if (account.clientCompatibility !== 'openai_standard') return false
  const credentials = account.credentials as Record<string, unknown> | undefined
  const currentModes = normalizeModes(credentials?.supported_endpoint_modes)
  if (!currentModes.length) return false
  if (currentModes.length >= expectedModes.length) return false
  if (!currentModes.every((mode) => mode === 'chat_json' || mode === 'chat_sse')) return false
  return true
}

function toCandidate(account: AccountSummary): OpenAIEndpointModeBackfillCandidate {
  const credentials = account.credentials as Record<string, unknown> | undefined
  const currentModes = normalizeModes(credentials?.supported_endpoint_modes)
  return {
    id: account.id,
    name: account.name,
    providerCode: account.providerCode,
    accountType: account.type,
    clientCompatibility: account.clientCompatibility,
    currentModes,
    nextModes: expectedModes,
    reason: 'legacy_chat_only'
  }
}

function normalizeModes(value: unknown): AccountSupportedEndpointMode[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<AccountSupportedEndpointMode>()
  const output: AccountSupportedEndpointMode[] = []
  for (const item of value) {
    if (typeof item !== 'string') continue
    if (item !== 'chat_json' && item !== 'chat_sse' && item !== 'responses_json' && item !== 'responses_sse') continue
    if (seen.has(item)) continue
    seen.add(item)
    output.push(item)
  }
  return output
}

function assertAccountSummary(account: AccountSummary | undefined, accountId: string): AccountSummary {
  assert(account, `无法重新读取账号 ${accountId}`)
  return account
}

function printResult(result: OpenAIEndpointModeBackfillResult, apply: boolean): void {
  console.log(`OpenAI endpoint mode backfill ${apply ? 'apply' : 'dry-run'} complete`)
  console.log(`scanned=${result.scannedCount} candidates=${result.candidateCount} updated=${result.updatedCount} skipped=${result.skippedCount}`)
  for (const candidate of result.candidates) {
    console.log(`${candidate.id} ${candidate.name}: ${candidate.currentModes.join(',') || '(empty)'} -> ${candidate.nextModes.join(',')}`)
  }
}

function main(): void {
  const apply = process.argv.includes('--apply')
  const result = runOpenAIEndpointModeBackfill({ apply })
  printResult(result, apply)
  if (!apply) {
    console.log('Run again with --apply to persist changes.')
  }
  void runtimeConfig
}
