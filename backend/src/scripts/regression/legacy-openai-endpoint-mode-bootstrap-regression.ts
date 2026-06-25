import assert from 'node:assert/strict'
import { mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { runtimeConfig } from '../../config/runtime.js'
import {
  MD_OPENAI_V1_PROFILE_ID,
  MD_VENDOR_CODE
} from '../../domain/provider-protocol.js'
import { logger } from '../../shared/logger.js'
import { decryptJson } from '../../storage/crypto.js'
import { filterGatewayAccountsByRequestCapability } from '../../modules/gateway/dispatch/account-capability-filter.js'
import type { UpstreamAccount } from '../../modules/gateway/protocols/openai-v1/route-helpers.js'

const tempRoot = resolve(tmpdir(), `juhe-ai-legacy-openai-endpoint-mode-bootstrap-${Date.now()}-${Math.random().toString(16).slice(2)}`)
runtimeConfig.databasePath = join(tempRoot, 'business.sqlite3')
runtimeConfig.datasetDatabasePath = join(tempRoot, 'dataset.sqlite3')
runtimeConfig.statsDatabasePath = join(tempRoot, 'stats.sqlite3')
runtimeConfig.secret = 'legacy-openai-endpoint-mode-bootstrap-secret'
runtimeConfig.log.consoleEnabled = false
runtimeConfig.log.fileEnabled = false
mkdirSync(tempRoot, { recursive: true })
logger.level = 'silent'

const [
  databaseModule,
  repositories,
  defaultGroupRepository
] = await Promise.all([
  import('../../storage/database.js'),
  import('../../storage/repositories.js'),
  import('../../storage/default-group.repository.js')
])

try {
  const access = { systemAccountId: 'sys_admin', role: 'admin' as const }
  const database = databaseModule.getBusinessDatabase()

  const owner = repositories.createSystemAccount({
    username: `legacy_md_bootstrap_${Date.now()}`,
    displayName: 'Legacy_MD_bootstrap_owner',
    password: 'password',
    role: 'user',
    status: 'active',
    mustChangePassword: false
  })
  const mdGroupId = defaultGroupRepository.defaultGroupIdForSystemAccount(MD_OPENAI_V1_PROFILE_ID, owner.id)
  assert(mdGroupId, 'new users should receive an md default group before bootstrap')

  const mdAccount = repositories.createAccount({
    providerCode: MD_VENDOR_CODE,
    providerProtocolProfileId: MD_OPENAI_V1_PROFILE_ID,
    name: 'legacy md bootstrap account',
    type: 'api_key',
    status: 'active',
    concurrencyLimit: 1,
    priority: 10,
    clientCompatibility: 'openai_standard',
    groupId: mdGroupId,
    credentials: {
      api_key: 'sk-legacy-md-bootstrap',
      base_url: 'https://example.invalid/v1',
      supported_endpoint_modes: ['chat_json', 'chat_sse']
    }
  }, access)

  const beforeModes = readSupportedEndpointModes(database, mdAccount.id)
  assert.deepEqual(beforeModes, ['chat_json', 'chat_sse'], 'legacy md account should start chat-only before bootstrap')
  assert.equal(
    filterGatewayAccountsByRequestCapability(request('/v1/responses') as never, [upstreamAccount(database, mdAccount.id)]).accounts.length,
    0,
    'legacy md account should not pass responses routing before bootstrap'
  )

  databaseModule.getBusinessDatabase().close()
  databaseModule.closeStorageDatabases()

  const reopenedDatabase = databaseModule.getBusinessDatabase()
  const afterModes = readSupportedEndpointModes(reopenedDatabase, mdAccount.id)
  assert.deepEqual(
    afterModes,
    ['chat_json', 'chat_sse', 'responses_json', 'responses_sse'],
    'bootstrap should backfill legacy md endpoint modes on startup'
  )
  assert.equal(
    filterGatewayAccountsByRequestCapability(request('/v1/responses') as never, [upstreamAccount(reopenedDatabase, mdAccount.id)]).accounts.length,
    1,
    'backfilled md account should pass responses routing after bootstrap'
  )

  console.log('legacy openai endpoint mode bootstrap regression passed')
} finally {
  try {
    databaseModule.getBusinessDatabase().close()
    databaseModule.closeStorageDatabases()
  } catch {
  }
  rmSync(tempRoot, { recursive: true, force: true })
}

function readSupportedEndpointModes(database: ReturnType<typeof databaseModule.getBusinessDatabase>, accountId: string): string[] {
  const row = database
    .prepare('SELECT credentials_encrypted FROM accounts WHERE id = ?')
    .get(accountId) as { credentials_encrypted?: string } | undefined
  assert(row?.credentials_encrypted, `account ${accountId} should exist`)
  const credentials = decryptJson<Record<string, unknown>>(row.credentials_encrypted)
  return normalizeModes(credentials.supported_endpoint_modes)
}

function upstreamAccount(database: ReturnType<typeof databaseModule.getBusinessDatabase>, accountId: string): UpstreamAccount {
  const row = database
    .prepare(`
      SELECT
        accounts.id,
        accounts.provider_code,
        accounts.provider_protocol_profile_id,
        accounts.protocol_code,
        accounts.protocol_version,
        accounts.type,
        accounts.client_compatibility,
        accounts.credentials_encrypted,
        provider_protocol_profiles.base_url
      FROM accounts
      INNER JOIN provider_protocol_profiles
        ON provider_protocol_profiles.id = accounts.provider_protocol_profile_id
      WHERE accounts.id = ?
    `)
    .get(accountId) as {
      id?: string
      provider_code?: string
      provider_protocol_profile_id?: string
      protocol_code?: string
      protocol_version?: string
      type?: string
      client_compatibility?: string
      credentials_encrypted?: string
      base_url?: string
    } | undefined
  assert(row?.id, `account ${accountId} should exist`)
  const credentials = decryptJson<Record<string, unknown>>(row.credentials_encrypted ?? '{}')
  return {
    id: row.id,
    type: row.type === 'oauth' ? 'oauth' : 'api_key',
    providerCode: row.provider_code ?? MD_VENDOR_CODE,
    providerProtocolProfileId: row.provider_protocol_profile_id ?? MD_OPENAI_V1_PROFILE_ID,
    protocolCode: row.protocol_code ?? 'openai',
    protocolVersion: row.protocol_version ?? 'v1',
    baseUrl: row.base_url ?? 'https://example.com/v1',
    supportedEndpointModes: normalizeModes(credentials.supported_endpoint_modes),
    credentials,
    clientCompatibility: (row.client_compatibility ?? 'openai_standard') as 'openai_standard'
  } as UpstreamAccount
}

function request(path: string): { method: string; path: string; originalUrl: string; body: { stream: boolean } } {
  return {
    method: 'POST',
    path,
    originalUrl: path,
    body: { stream: true }
  }
}

function normalizeModes(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  const output: string[] = []
  for (const item of value) {
    if (typeof item !== 'string') continue
    const mode = item.trim()
    if (!mode) continue
    if (mode !== 'chat_json' && mode !== 'chat_sse' && mode !== 'responses_json' && mode !== 'responses_sse') {
      continue
    }
    if (seen.has(mode)) continue
    seen.add(mode)
    output.push(mode)
  }
  return output
}
