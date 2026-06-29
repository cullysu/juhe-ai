import type { Request, Response } from 'express'

import type { GroupUsageAccessMetadata } from '../../../storage/repositories.js'
import type { AuditCaptureContext } from '../audit/capture.service.js'
import {
  filterGatewayAccountsByRequestCapability
} from './account-capability-filter.js'
import {
  filterGatewayAccountsByRequestedModel,
  gatewayModelFilterFailureMessage
} from './model-filter.js'
import { sendGatewayFailureResponse } from '../response/failure-response.js'
import { gatewayErrorPayload } from '../response/responses.js'
import type { UpstreamAccount } from '../protocols/openai-v1/route-helpers.js'
import { requestModel } from '../request/metadata.js'
import type { GatewayFailureUsageContext } from '../usage/records.js'
import { recordClientIpRequestErrorSample } from '../request/local-request-errors.js'
import type { OpenAIGatewayDispatchContext } from '../request/preflight.js'
import {
  filterGatewayDispatchAccountsByInvariant,
  gatewayDispatchAccountInvariantAuditMetadata,
  gatewayDispatchAccountInvariantFailureMessage
} from './account-invariant.js'

export interface RequestCandidateFallbackResult {
  attempted: boolean
  context?: OpenAIGatewayDispatchContext
}

export type RequestCandidateFilterResult =
  | { outcome: 'accounts'; accounts: UpstreamAccount[] }
  | { outcome: 'fallback'; context?: OpenAIGatewayDispatchContext }
  | { outcome: 'completed' }

export async function filterOpenAIGatewayRequestCandidateAccounts(input: {
  req: Request
  res: Response
  auditCapture: AuditCaptureContext
  usageContext: GatewayFailureUsageContext
  startedAt: number
  rawCandidateAccounts: UpstreamAccount[]
  groupAccess: GroupUsageAccessMetadata
  systemAccountId: string
  apiKeyId?: string
  groupId: string
  clientIp?: string
  endpoint: string
  allowedAccountStatuses?: readonly UpstreamAccount['status'][]
  explicitFailureAccountId?: string
  attemptFallback: (reason: string) => Promise<RequestCandidateFallbackResult>
}): Promise<RequestCandidateFilterResult> {
  const invariantFilter = filterGatewayDispatchAccountsByInvariant({
    accounts: input.rawCandidateAccounts,
    groupAccess: input.groupAccess,
    allowedAccountStatuses: input.allowedAccountStatuses
  })
  if (invariantFilter.dropped.length > 0) {
    input.auditCapture.addGatewayMetadata({
      label: 'dispatch_account_invariant',
      metadata: gatewayDispatchAccountInvariantAuditMetadata(invariantFilter)
    })
  }
  if (input.rawCandidateAccounts.length > 0 && invariantFilter.accounts.length === 0) {
    const fallback = await input.attemptFallback('dispatch_account_invariant_failed')
    if (fallback.attempted) {
      return { outcome: 'fallback', context: fallback.context }
    }
    const statusCode = 503
    const message = gatewayDispatchAccountInvariantFailureMessage()
    const responsePayload = gatewayErrorPayload(message, 'service_unavailable', 'dispatch_account_invariant_failed')
    sendGatewayFailureResponse({
      req: input.req,
      res: input.res,
      auditCapture: input.auditCapture,
      usageContext: input.usageContext,
      startedAt: input.startedAt,
      statusCode,
      responsePayload,
      usageAccountId: input.explicitFailureAccountId,
      audit: {
        outcome: 'gateway_failed',
        errorPhase: 'dispatch',
        errorCode: 'dispatch_account_invariant_failed',
        errorMessage: message
      }
    })
    return { outcome: 'completed' }
  }

  const capabilityFilter = filterGatewayAccountsByRequestCapability(input.req, invariantFilter.accounts)
  if (capabilityFilter.skippedCount > 0) {
    input.auditCapture.addGatewayMetadata({
      label: 'account_request_capability_filter',
      metadata: {
        skippedCount: capabilityFilter.skippedCount,
        remainingCount: capabilityFilter.accounts.length,
        reason: capabilityFilter.reason
      }
    })
  }
  if (invariantFilter.accounts.length > 0 && capabilityFilter.accounts.length === 0) {
    const fallback = await input.attemptFallback('request_capability_mismatch')
    if (fallback.attempted) {
      return { outcome: 'fallback', context: fallback.context }
    }
    const statusCode = 400
    const reason = capabilityFilter.reason ?? 'request_capability_mismatch'
    const message = requestCapabilityMismatchMessage(reason)
    const responsePayload = gatewayErrorPayload(message, 'invalid_request_error', reason)
    recordClientIpRequestErrorSample({
      auditCapture: input.auditCapture,
      systemAccountId: input.systemAccountId,
      apiKeyId: input.apiKeyId,
      groupId: input.groupId,
      clientIp: input.clientIp,
      endpoint: input.endpoint,
      reason: 'request_capability_mismatch',
      signature: reason === 'request_capability_mismatch'
        ? `${input.req.method.toUpperCase()} ${input.req.path || input.req.originalUrl.split('?')[0] || '/'}`
        : reason
    })
    sendGatewayFailureResponse({
      req: input.req,
      res: input.res,
      auditCapture: input.auditCapture,
      usageContext: input.usageContext,
      startedAt: input.startedAt,
      statusCode,
      responsePayload,
      usageAccountId: input.explicitFailureAccountId,
      audit: {
        outcome: 'gateway_failed',
        errorPhase: 'request_validation',
        errorCode: reason,
        errorMessage: message
      }
    })
    return { outcome: 'completed' }
  }

  const modelFilter = filterGatewayAccountsByRequestedModel(capabilityFilter.accounts, requestModel(input.req))
  if (modelFilter.skippedCount > 0 || modelFilter.mappingMatchedCount > 0) {
    input.auditCapture.addGatewayMetadata({
      label: 'account_model_filter',
      metadata: {
        requestedModel: modelFilter.requestedModel,
        skippedCount: modelFilter.skippedCount,
        limitedAccountCount: modelFilter.limitedAccountCount,
        directMatchedCount: modelFilter.directMatchedCount,
        mappingMatchedCount: modelFilter.mappingMatchedCount,
        remainingCount: modelFilter.accounts.length,
        reason: modelFilter.reason
      }
    })
  }
  if (capabilityFilter.accounts.length > 0 && modelFilter.accounts.length === 0) {
    const fallback = await input.attemptFallback(modelFilter.reason ?? 'unsupported_model')
    if (fallback.attempted) {
      return { outcome: 'fallback', context: fallback.context }
    }
    const statusCode = 400
    const message = gatewayModelFilterFailureMessage(modelFilter)
    const responsePayload = gatewayErrorPayload(message, 'invalid_request_error')
    recordClientIpRequestErrorSample({
      auditCapture: input.auditCapture,
      systemAccountId: input.systemAccountId,
      apiKeyId: input.apiKeyId,
      groupId: input.groupId,
      clientIp: input.clientIp,
      endpoint: input.endpoint,
      reason: 'unsupported_model',
      signature: modelFilter.reason ?? modelFilter.requestedModel ?? 'unsupported_model'
    })
    sendGatewayFailureResponse({
      req: input.req,
      res: input.res,
      auditCapture: input.auditCapture,
      usageContext: input.usageContext,
      startedAt: input.startedAt,
      statusCode,
      responsePayload,
      usageAccountId: input.explicitFailureAccountId,
      audit: {
        outcome: 'gateway_failed',
        errorPhase: 'request_validation',
        errorCode: modelFilter.reason ?? 'unsupported_model',
        errorMessage: message
      }
    })
    return { outcome: 'completed' }
  }

  return { outcome: 'accounts', accounts: modelFilter.accounts }
}

function requestCapabilityMismatchMessage(reason: string): string {
  return '当前分组无账户支持请求路径或客户端协议'
}
