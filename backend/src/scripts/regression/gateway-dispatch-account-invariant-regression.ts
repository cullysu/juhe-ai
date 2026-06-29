import { strict as assert } from 'node:assert'

import {
  GPT_OPENAI_V1_PROFILE_ID,
  GPT_VENDOR_CODE,
  MD_VENDOR_CODE,
  OPENAI_PROTOCOL_CODE,
  OPENAI_PROTOCOL_VERSION
} from '../../domain/provider-protocol.js'
import type { GroupUsageAccessMetadata, OpenAIAccountSecret } from '../../storage/repositories.js'
import {
  filterGatewayDispatchAccountsByInvariant,
  gatewayDispatchAccountInvariantFailureReason
} from '../../modules/gateway/dispatch/account-invariant.js'

const groupAccess: GroupUsageAccessMetadata = {
  groupOwnerSystemAccountId: 'sys_owner',
  providerCode: GPT_VENDOR_CODE,
  providerProtocolProfileId: GPT_OPENAI_V1_PROFILE_ID,
  protocolCode: OPENAI_PROTOCOL_CODE,
  protocolVersion: OPENAI_PROTOCOL_VERSION,
  groupAccessType: 'owner'
}

const validAccount = account()
const mixed = filterGatewayDispatchAccountsByInvariant({
  groupAccess,
  accounts: [
    account({ id: '' }),
    validAccount,
    account({ id: validAccount.id, name: 'duplicate account' }),
    account({ id: 'acct_md_wrong_provider', providerCode: MD_VENDOR_CODE }),
    account({ id: 'acct_wrong_profile', providerProtocolProfileId: 'profile_wrong' }),
    account({ id: 'acct_no_key', apiKey: '' })
  ]
})

assert.deepEqual(mixed.accounts.map((item) => item.id), [validAccount.id], 'only invariant-safe accounts should remain dispatch candidates')
assert.deepEqual(
  mixed.dropped.map((item) => item.reason),
  [
    'missing_account_id',
    'duplicate_account_id',
    'provider_mismatch',
    'provider_profile_mismatch',
    'missing_api_key'
  ],
  'invalid dispatch accounts should be rejected with explicit reasons'
)

assert.equal(
  gatewayDispatchAccountInvariantFailureReason(account({ accountAccessType: 'account_authorized', accountAuthorizationId: undefined }), groupAccess),
  'missing_account_authorization',
  'account-authorized candidates must keep the account authorization id'
)

const authorizedGroupAccess: GroupUsageAccessMetadata = {
  ...groupAccess,
  groupAccessType: 'authorized',
  groupAuthorizationId: 'auth_group'
}

assert.equal(
  gatewayDispatchAccountInvariantFailureReason(account({ groupAccessType: 'authorized', groupAuthorizationId: undefined }), authorizedGroupAccess),
  'missing_group_authorization',
  'authorized-group candidates must keep the group authorization id'
)

const authorizedGroupCandidate = account({
  id: 'acct_authorized_group_valid',
  groupAccessType: 'authorized',
  groupAuthorizationId: 'auth_group'
})
assert.equal(
  gatewayDispatchAccountInvariantFailureReason(authorizedGroupCandidate, authorizedGroupAccess),
  undefined,
  'authorized-group candidates should pass when the group authorization context is present'
)

console.log('gateway dispatch account invariant regression passed')

function account(overrides: Partial<OpenAIAccountSecret> = {}): OpenAIAccountSecret {
  return {
    id: 'acct_valid_dispatch_invariant',
    providerCode: GPT_VENDOR_CODE,
    providerProtocolProfileId: GPT_OPENAI_V1_PROFILE_ID,
    protocolCode: OPENAI_PROTOCOL_CODE,
    protocolVersion: OPENAI_PROTOCOL_VERSION,
    systemAccountId: 'sys_owner',
    accountOwnerSystemAccountId: 'sys_owner',
    groupOwnerSystemAccountId: 'sys_owner',
    accountAccessType: 'owner',
    groupAccessType: 'owner',
    name: 'dispatch invariant account',
    type: 'api_key',
    status: 'active',
    concurrencyLimit: 1,
    priority: 0,
    superPriorityEnabled: false,
    fallbackEnabled: false,
    clientCompatibility: 'openai_standard',
    baseUrl: 'https://example.com/v1',
    apiKey: 'sk-dispatch-invariant',
    streamFailureCount: 0,
    credentials: {},
    ...overrides
  }
}
