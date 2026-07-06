import type { Router } from 'express'
import { z } from 'zod'

import { badRequest, firstIssueMessage, ok } from '../../shared/http.js'
import { getRequestAccessScope } from '../auth/request-context.js'
import { parseRequestScopeQuery } from '../auth/request-scope-query.js'
import {
  bodyField,
  mutationGuard,
  normalizedText,
  queryField,
  sensitiveFingerprint,
  sortedTextValues
} from '../deduplication/mutation-guard.middleware.js'
import {
  operationMode,
  resolveOperationOwner,
  runLoggedOperation,
  safeChange,
  viewer
} from '../operation-logs/operation-log.service.js'
import {
  executeLoadedAccountImportSubscription,
  loadAccountImportSubscription,
  previewLoadedAccountImportSubscription,
  type AccountImportSubscriptionExecuteResult
} from './account-import-subscription.service.js'

const subscriptionHeadersSchema = z.record(
  z.string().trim().min(1).max(80),
  z.string().trim().min(1).max(2000)
).optional()

const subscriptionRequestSchema = z.object({
  url: z.string().trim().url('订阅 URL 无效').max(2000, '订阅 URL 不能超过 2000 个字符'),
  headers: subscriptionHeadersSchema,
  options: z.object({
    createMissingGroups: z.boolean().optional(),
    createMissingProxies: z.boolean().optional(),
    skipDuplicates: z.boolean().optional()
  }).strict().optional(),
  bindApiKeyIds: z.array(z.string().trim().min(1).max(120)).max(20).optional()
}).strict()

export function registerAccountImportSubscriptionRoutes(router: Router): void {
  router.post('/import/subscription/preview', async (req, res) => {
    const scopeQuery = parseRequestScopeQuery(req.query)
    if (!scopeQuery.success) {
      res.status(400).json(badRequest(scopeQuery.message))
      return
    }
    const parsed = subscriptionRequestSchema.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json(badRequest(firstIssueMessage(parsed.error, '账户订阅导入参数无效')))
      return
    }
    try {
      const requestAccess = getRequestAccessScope(scopeQuery.data.systemAccountId)
      const loaded = await loadAccountImportSubscription(parsed.data)
      res.json(ok(previewLoadedAccountImportSubscription(loaded, parsed.data.options, requestAccess)))
    } catch (error) {
      res.status(400).json(badRequest(error instanceof Error ? error.message : '账户订阅预览失败'))
    }
  })

  router.post('/import/subscription/confirm', mutationGuard({
    operationKey: 'accounts.import_subscription',
    scope: (req) => normalizedText(queryField(req, 'systemAccountId')),
    fingerprint: (req) => ({
      owner: normalizedText(queryField(req, 'systemAccountId')),
      url: sensitiveFingerprint(bodyField(req, 'url')),
      headerNames: subscriptionHeaderNames(bodyField(req, 'headers')),
      options: bodyField(req, 'options'),
      bindApiKeyIds: sortedTextValues(bodyField(req, 'bindApiKeyIds'))
    })
  }), async (req, res) => {
    const scopeQuery = parseRequestScopeQuery(req.query)
    if (!scopeQuery.success) {
      res.status(400).json(badRequest(scopeQuery.message))
      return
    }
    const parsed = subscriptionRequestSchema.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json(badRequest(firstIssueMessage(parsed.error, '账户订阅导入参数无效')))
      return
    }
    const requestAccess = getRequestAccessScope(scopeQuery.data.systemAccountId)
    if (!requestAccess) {
      res.status(401).json(badRequest('缺少系统账户上下文'))
      return
    }
    try {
      const loaded = await loadAccountImportSubscription(parsed.data)
      const result = runLoggedOperation(() => {
        const result = executeLoadedAccountImportSubscription(
          loaded,
          parsed.data.options,
          requestAccess,
          parsed.data.bindApiKeyIds
        )
        const ownerSystemAccountId = resolveOperationOwner(undefined, requestAccess)
        return {
          result,
          log: {
            operationScopeSystemAccountId: ownerSystemAccountId,
            mode: operationMode(requestAccess),
            module: 'accounts',
            action: 'import_subscription',
            operationKey: 'accounts.import_subscription',
            resourceType: 'account',
            resourceName: 'AI 账户订阅导入',
            summary: importSubscriptionSummary(result),
            changes: [
              safeChange('accountCreated', '创建账户数', undefined, result.import.summary.accounts.create),
              safeChange('accountSkipped', '跳过账户数', undefined, result.import.summary.accounts.skip),
              safeChange('accountFailed', '失败账户数', undefined, result.import.summary.accounts.failed),
              safeChange('groupCreated', '创建分组数', undefined, result.import.summary.groups.create),
              safeChange('apiKeyBindingUpdated', '追加绑定 API Key 数', undefined, result.apiKeyBindings.filter((item) => item.action === 'updated').length),
              safeChange('subscriptionOrigin', '订阅来源域名', undefined, result.subscription.origin)
            ],
            viewers: viewer(ownerSystemAccountId, 'resource_owner')
          }
        }
      }, req)
      res.json(ok(result))
    } catch (error) {
      res.status(400).json(badRequest(error instanceof Error ? error.message : '账户订阅导入失败'))
    }
  })
}

function subscriptionHeaderNames(value: unknown): string[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return []
  return Object.keys(value).map((item) => item.trim().toLowerCase()).filter(Boolean).sort()
}

function importSubscriptionSummary(result: AccountImportSubscriptionExecuteResult): string {
  const bindingUpdated = result.apiKeyBindings.filter((item) => item.action === 'updated').length
  return `通过订阅导入 AI 账户：创建 ${result.import.summary.accounts.create} 个，跳过 ${result.import.summary.accounts.skip} 个，失败 ${result.import.summary.accounts.failed} 个，追加绑定 ${bindingUpdated} 个 API Key`
}
