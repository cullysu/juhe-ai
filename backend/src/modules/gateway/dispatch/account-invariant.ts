import type { GroupUsageAccessMetadata } from '../../../storage/repositories.js'
import type { UpstreamAccount } from '../protocols/openai-v1/route-helpers.js'

export type GatewayDispatchAccountInvariantReason =
  | 'missing_account'
  | 'missing_account_id'
  | 'duplicate_account_id'
  | 'missing_system_account_id'
  | 'missing_owner_system_account_id'
  | 'missing_group_owner_system_account_id'
  | 'provider_mismatch'
  | 'provider_profile_mismatch'
  | 'protocol_mismatch'
  | 'group_owner_mismatch'
  | 'group_access_mismatch'
  | 'unsupported_account_type'
  | 'inactive_account'
  | 'invalid_concurrency_limit'
  | 'missing_api_key'
  | 'missing_base_url'
  | 'missing_account_authorization'
  | 'missing_group_authorization'

export interface GatewayDispatchAccountInvariantDrop {
  accountId?: string
  accountName?: string
  providerCode?: string
  providerProtocolProfileId?: string
  reason: GatewayDispatchAccountInvariantReason
}

export interface GatewayDispatchAccountInvariantResult {
  accounts: UpstreamAccount[]
  dropped: GatewayDispatchAccountInvariantDrop[]
}

export function filterGatewayDispatchAccountsByInvariant(input: {
  accounts: readonly (UpstreamAccount | undefined | null)[]
  groupAccess: GroupUsageAccessMetadata
  allowedAccountStatuses?: readonly UpstreamAccount['status'][]
}): GatewayDispatchAccountInvariantResult {
  const accounts: UpstreamAccount[] = []
  const dropped: GatewayDispatchAccountInvariantDrop[] = []
  const seenAccountIds = new Set<string>()
  const allowedAccountStatuses = new Set<UpstreamAccount['status']>(input.allowedAccountStatuses?.length ? input.allowedAccountStatuses : ['active'])
  for (const account of input.accounts) {
    const accountId = textValue(account?.id)
    if (accountId && seenAccountIds.has(accountId)) {
      dropped.push(dropFromAccount(account, 'duplicate_account_id'))
      continue
    }
    const reason = gatewayDispatchAccountInvariantFailureReason(account, input.groupAccess, allowedAccountStatuses)
    if (reason) {
      dropped.push(dropFromAccount(account, reason))
      continue
    }
    if (!account) {
      continue
    }
    seenAccountIds.add(accountId)
    accounts.push(account)
  }
  return { accounts, dropped }
}

export function gatewayDispatchAccountInvariantAuditMetadata(result: GatewayDispatchAccountInvariantResult): Record<string, unknown> {
  return {
    droppedCount: result.dropped.length,
    remainingCount: result.accounts.length,
    dropped: result.dropped.slice(0, 20)
  }
}

export function gatewayDispatchAccountInvariantFailureMessage(): string {
  return '当前分组上游账号配置不完整，请检查供应商、协议和账号绑定'
}

export function gatewayDispatchAccountInvariantFailureReason(
  account: UpstreamAccount | undefined | null,
  groupAccess: GroupUsageAccessMetadata,
  allowedAccountStatuses: ReadonlySet<UpstreamAccount['status']> = new Set<UpstreamAccount['status']>(['active'])
): GatewayDispatchAccountInvariantReason | undefined {
  if (!account) return 'missing_account'
  if (!textValue(account.id)) return 'missing_account_id'
  if (!textValue(account.systemAccountId)) return 'missing_system_account_id'
  if (!textValue(account.accountOwnerSystemAccountId)) return 'missing_owner_system_account_id'
  if (!textValue(account.groupOwnerSystemAccountId)) return 'missing_group_owner_system_account_id'
  if (account.providerCode !== groupAccess.providerCode) return 'provider_mismatch'
  if (account.providerProtocolProfileId !== groupAccess.providerProtocolProfileId) return 'provider_profile_mismatch'
  if (account.protocolCode !== groupAccess.protocolCode || account.protocolVersion !== groupAccess.protocolVersion) return 'protocol_mismatch'
  if (account.groupOwnerSystemAccountId !== groupAccess.groupOwnerSystemAccountId) return 'group_owner_mismatch'
  if (account.groupAccessType !== groupAccess.groupAccessType) return 'group_access_mismatch'
  if (account.type !== 'api_key' && account.type !== 'oauth') return 'unsupported_account_type'
  if (!allowedAccountStatuses.has(account.status)) return 'inactive_account'
  if (!Number.isFinite(account.concurrencyLimit) || account.concurrencyLimit < 1) return 'invalid_concurrency_limit'
  if (!textValue(account.apiKey)) return 'missing_api_key'
  if (account.type === 'api_key' && !textValue(account.baseUrl)) return 'missing_base_url'
  if (account.accountAccessType === 'account_authorized' && !textValue(account.accountAuthorizationId)) return 'missing_account_authorization'
  if (groupAccess.groupAccessType === 'authorized' && !textValue(account.groupAuthorizationId)) return 'missing_group_authorization'
  return undefined
}

function dropFromAccount(
  account: UpstreamAccount | undefined | null,
  reason: GatewayDispatchAccountInvariantReason
): GatewayDispatchAccountInvariantDrop {
  return {
    accountId: textValue(account?.id) || undefined,
    accountName: textValue(account?.name) || undefined,
    providerCode: textValue(account?.providerCode) || undefined,
    providerProtocolProfileId: textValue(account?.providerProtocolProfileId) || undefined,
    reason
  }
}

function textValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}
