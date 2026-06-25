import assert from 'node:assert/strict'
import { mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { runtimeConfig } from '../../config/runtime.js'
import {
  MD_OPENAI_V1_PROFILE_ID,
  MD_VENDOR_CODE
} from '../../domain/provider-protocol.js'
import type { AccountSupportedEndpointMode } from '../../domain/types.js'
import { logger } from '../../shared/logger.js'
import { filterGatewayAccountsByRequestCapability } from '../../modules/gateway/dispatch/account-capability-filter.js'
import type { UpstreamAccount } from '../../modules/gateway/protocols/openai-v1/route-helpers.js'

const tempRoot = resolve(tmpdir(), `juhe-ai-openai-endpoint-mode-backfill-${Date.now()}-${Math.random().toString(16).slice(2)}`)
runtimeConfig.databasePath = join(tempRoot, 'business.sqlite3')
runtimeConfig.datasetDatabasePath = join(tempRoot, 'dataset.sqlite3')
runtimeConfig.statsDatabasePath = join(tempRoot, 'stats.sqlite3')
runtimeConfig.secret = 'openai-endpoint-mode-backfill-secret'
runtimeConfig.log.consoleEnabled = false
runtimeConfig.log.fileEnabled = false
runtimeConfig.processRole = 'worker'
runtimeConfig.upstreamUrlSecurity.allowPrivateBaseUrls = true
mkdirSync(tempRoot, { recursive: true })
logger.level = 'silent'

const [
  databaseModule,
  repositories,
  { runOpenAIEndpointModeBackfill }
] = await Promise.all([
  import('../../storage/database.js'),
  import('../../storage/repositories.js'),
  import('../maintenance/openai-endpoint-mode-backfill.js')
])

try {
  const access = { systemAccountId: 'sys_admin', role: 'admin' as const }
  const group = repositories.createGroup({
    name: 'endpoint mode backfill regression group',
    providerCode: 'openai',
    providerProtocolProfileId: 'profile_openai_openai_v1'
  }, access)

  const legacyAccount = repositories.createAccount({
    providerCode: 'openai',
    name: 'legacy openai api key',
    type: 'api_key',
    clientCompatibility: 'openai_standard',
    groupId: group.id,
    credentials: {
      api_key: 'sk-legacy-openai-account',
      base_url: 'https://example.com/v1',
      supported_endpoint_modes: ['chat_json', 'chat_sse']
    }
  }, access)

  const before = filterGatewayAccountsByRequestCapability({
    method: 'POST',
    path: '/v1/responses',
    originalUrl: '/v1/responses',
    body: { stream: true }
  } as never, [
    upstreamAccount(legacyAccount.id, ['chat_json', 'chat_sse'], legacyAccount.credentials)
  ])
  assert.equal(before.accounts.length, 0, 'legacy chat-only account should be filtered out before backfill')
  assert.equal(before.reason, 'request_capability_mismatch', 'legacy chat-only account should hit request_capability_mismatch before backfill')

  const mdGroup = repositories.createGroup({
    providerCode: MD_VENDOR_CODE,
    providerProtocolProfileId: MD_OPENAI_V1_PROFILE_ID,
    name: 'md legacy backfill group'
  }, access)
  const mdLegacyAccount = repositories.createAccount({
    providerCode: MD_VENDOR_CODE,
    providerProtocolProfileId: MD_OPENAI_V1_PROFILE_ID,
    name: 'legacy md api key',
    type: 'api_key',
    clientCompatibility: 'openai_standard',
    groupId: mdGroup.id,
    credentials: {
      api_key: 'sk-legacy-md-account',
      base_url: 'https://example.com/v1',
      supported_endpoint_modes: ['chat_json', 'chat_sse']
    }
  }, access)
  const mdBefore = filterGatewayAccountsByRequestCapability({
    method: 'POST',
    path: '/v1/responses',
    originalUrl: '/v1/responses',
    body: { stream: true }
  } as never, [
    upstreamAccount(mdLegacyAccount.id, ['chat_json', 'chat_sse'], mdLegacyAccount.credentials, MD_VENDOR_CODE, MD_OPENAI_V1_PROFILE_ID)
  ])
  assert.equal(mdBefore.accounts.length, 0, 'legacy md chat-only account should be filtered out before backfill')
  assert.equal(mdBefore.reason, 'request_capability_mismatch', 'legacy md chat-only account should hit request_capability_mismatch before backfill')

  const dryRun = runOpenAIEndpointModeBackfill()
  assert.equal(dryRun.candidates.length, 2, 'dry-run should find both openai and md legacy candidates')
  assert.deepEqual(dryRun.candidates[0]?.currentModes, ['chat_json', 'chat_sse'])
  assert.deepEqual(dryRun.candidates[0]?.nextModes, ['chat_json', 'chat_sse', 'responses_json', 'responses_sse'])
  assert.equal(repositories.findAccountSummary(legacyAccount.id, access)?.credentials.supported_endpoint_modes?.length, 2, 'dry-run must not mutate data')
  assert.equal(
    dryRun.candidates.some((candidate) => candidate.id === mdLegacyAccount.id),
    true,
    'dry-run should include the md legacy candidate'
  )

  const applied = runOpenAIEndpointModeBackfill({ apply: true })
  assert.equal(applied.updatedCount, 2, 'apply mode should update both legacy accounts')

  const afterAccount = repositories.findAccountSummary(legacyAccount.id, access)
  assert.deepEqual(
    afterAccount?.credentials.supported_endpoint_modes,
    ['chat_json', 'chat_sse', 'responses_json', 'responses_sse'],
    'apply mode should backfill all four endpoint modes'
  )

  const afterMdAccount = repositories.findAccountSummary(mdLegacyAccount.id, access)
  assert.deepEqual(
    afterMdAccount?.credentials.supported_endpoint_modes,
    ['chat_json', 'chat_sse', 'responses_json', 'responses_sse'],
    'apply mode should backfill md legacy account endpoint modes'
  )

  const after = filterGatewayAccountsByRequestCapability({
    method: 'POST',
    path: '/v1/responses',
    originalUrl: '/v1/responses',
    body: { stream: true }
  } as never, [
    upstreamAccount(legacyAccount.id, afterAccount?.credentials.supported_endpoint_modes ?? [], afterAccount?.credentials ?? {})
  ])
  assert.equal(after.accounts.length, 1, 'backfilled legacy account should pass capability filtering')
  assert.equal(after.reason, undefined, 'backfilled legacy account should no longer hit request_capability_mismatch')

  const mdAfter = filterGatewayAccountsByRequestCapability({
    method: 'POST',
    path: '/v1/responses',
    originalUrl: '/v1/responses',
    body: { stream: true }
  } as never, [
    upstreamAccount(mdLegacyAccount.id, afterMdAccount?.credentials.supported_endpoint_modes ?? [], afterMdAccount?.credentials ?? {}, MD_VENDOR_CODE, MD_OPENAI_V1_PROFILE_ID)
  ])
  assert.equal(mdAfter.accounts.length, 1, 'backfilled md legacy account should pass capability filtering')
  assert.equal(mdAfter.reason, undefined, 'backfilled md legacy account should no longer hit request_capability_mismatch')

  console.log('OpenAI endpoint mode backfill regression passed')
} finally {
  try {
    databaseModule.getBusinessDatabase().close()
    databaseModule.closeStorageDatabases()
  } catch {
  }
  rmSync(tempRoot, { recursive: true, force: true })
}

function upstreamAccount(
  id: string,
  supportedEndpointModes: AccountSupportedEndpointMode[],
  credentials: Record<string, unknown>,
  providerCode = 'openai',
  providerProtocolProfileId = 'profile_openai_openai_v1'
): UpstreamAccount {
  return {
    id,
    type: 'api_key',
    providerCode,
    providerProtocolProfileId,
    protocolCode: 'openai',
    protocolVersion: 'v1',
    baseUrl: 'https://example.com/v1',
    supportedEndpointModes,
    credentials,
    clientCompatibility: 'openai_standard'
  } as UpstreamAccount
}
