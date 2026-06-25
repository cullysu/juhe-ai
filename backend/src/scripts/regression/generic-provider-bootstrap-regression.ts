import { strict as assert } from 'node:assert'
import { mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { runtimeConfig } from '../../config/runtime.js'
import {
  OPENAI_CHAT_COMPLETIONS_FAMILY,
  OPENAI_PROTOCOL_CODE,
  OPENAI_PROTOCOL_VERSION,
  OPENAI_RESPONSES_FAMILY
} from '../../domain/provider-protocol.js'
import { logger } from '../../shared/logger.js'
import { defaultGroupIdForSystemAccount, ensureDefaultGroupsForAllSystemAccounts } from '../../storage/default-group.repository.js'
import { listProviders } from '../../storage/provider.repository.js'
import { seedDefaults } from '../../storage/schema/seed-defaults.js'

const ACME_PROVIDER_CODE = 'acme'
const ACME_PROFILE_ID = 'profile_acme_openai_v1'

const tempRoot = resolve(tmpdir(), `juhe-ai-generic-provider-bootstrap-${Date.now()}-${Math.random().toString(16).slice(2)}`)
runtimeConfig.databasePath = join(tempRoot, 'business.sqlite3')
runtimeConfig.datasetDatabasePath = join(tempRoot, 'dataset.sqlite3')
runtimeConfig.statsDatabasePath = join(tempRoot, 'stats.sqlite3')
runtimeConfig.secret = 'generic-provider-bootstrap-secret'
runtimeConfig.log.consoleEnabled = false
runtimeConfig.log.fileEnabled = false
mkdirSync(tempRoot, { recursive: true })
logger.level = 'silent'

const [databaseModule] = await Promise.all([
  import('../../storage/database.js')
])

try {
  const database = databaseModule.getBusinessDatabase()
  const now = new Date().toISOString()

  seedDefaults(database)
  insertSystemAccount(database, 'sys_acme_owner', 'acme_owner', now)
  insertSyntheticProvider(database, now)
  ensureDefaultGroupsForAllSystemAccounts(now, database)

  const providers = listProviders()
  const acmeProvider = providers.find((provider) => provider.code === ACME_PROVIDER_CODE)
  assert(acmeProvider, 'synthetic provider should be visible through listProviders()')
  assert.equal(acmeProvider.defaultProtocolProfileId, ACME_PROFILE_ID, 'synthetic provider should keep its default profile')
  assert.equal(acmeProvider.protocolProfiles.length, 1, 'synthetic provider should expose exactly one profile')
  assert.equal(acmeProvider.protocolProfiles[0]?.endpointFamilies.length, 2, 'synthetic profile should expose both OpenAI endpoint families')

  const ownerGroupId = defaultGroupIdForSystemAccount(ACME_PROFILE_ID, 'sys_acme_owner', database)
  assert(ownerGroupId, 'synthetic provider should receive a default group for its owner')
  const ownerGroup = readGroup(database, ownerGroupId)
  assert.equal(ownerGroup.system_account_id, 'sys_acme_owner', 'default group should belong to the synthetic owner')
  assert.equal(ownerGroup.provider_code, ACME_PROVIDER_CODE, 'default group should keep the synthetic provider code')
  assert.equal(ownerGroup.provider_protocol_profile_id, ACME_PROFILE_ID, 'default group should keep the synthetic profile id')
  assert.equal(ownerGroup.protocol_code, OPENAI_PROTOCOL_CODE, 'default group should remain OpenAI-compatible')
  assert.equal(ownerGroup.protocol_version, OPENAI_PROTOCOL_VERSION, 'default group should remain on OpenAI v1')
  assert.equal(ownerGroup.is_default, 1, 'default group should be marked as default')
  assert(ownerGroup.name.includes('ACME'), 'default group name should derive from the synthetic provider name')

  const sysAdminGroupId = defaultGroupIdForSystemAccount(ACME_PROFILE_ID, 'sys_admin', database)
  assert(sysAdminGroupId, 'synthetic provider should also backfill the admin account')

  const beforeRepeatCount = countGroups(database, 'sys_acme_owner', ACME_PROFILE_ID)
  ensureDefaultGroupsForAllSystemAccounts(now, database)
  const afterRepeatCount = countGroups(database, 'sys_acme_owner', ACME_PROFILE_ID)
  assert.equal(afterRepeatCount, beforeRepeatCount, 'default-group backfill should be idempotent')

  console.log('generic provider bootstrap regression passed')
} finally {
  try {
    databaseModule.getBusinessDatabase().close()
    databaseModule.closeStorageDatabases()
  } catch {
  }
  rmSync(tempRoot, { recursive: true, force: true })
}

function insertSystemAccount(database: ReturnType<typeof databaseModule.getBusinessDatabase>, id: string, username: string, now: string): void {
  database
    .prepare(`
      INSERT INTO system_accounts (
        id, username, display_name, description, role, status,
        password_hash, must_change_password, image_generation_enabled,
        created_at, updated_at
      )
      VALUES (?, ?, ?, '', 'user', 'active', 'hash', 0, 0, ?, ?)
    `)
    .run(id, username, username, now, now)
}

function insertSyntheticProvider(database: ReturnType<typeof databaseModule.getBusinessDatabase>, now: string): void {
  database
    .prepare(`
      INSERT INTO providers (
        id, code, name, description, parent_code, enabled, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `)
    .run(
      ACME_PROVIDER_CODE,
      ACME_PROVIDER_CODE,
      'ACME',
      'Synthetic provider for regression coverage',
      'openai',
      1,
      now,
      now
    )

  database
    .prepare(`
      INSERT INTO provider_protocol_profiles (
        id, provider_code, name, description, enabled, protocol_code, protocol_version,
        base_url, default_test_model, account_types_json, capabilities_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    .run(
      ACME_PROFILE_ID,
      ACME_PROVIDER_CODE,
      'ACME / OpenAI v1',
      'Synthetic profile for regression coverage',
      OPENAI_PROTOCOL_CODE,
      OPENAI_PROTOCOL_VERSION,
      'https://acme.example/v1',
      'acme-default',
      JSON.stringify(['api_key']),
      JSON.stringify(['responses', 'chat', 'passthrough']),
      now,
      now
    )

  const familyStatement = database.prepare(`
    INSERT INTO provider_protocol_profile_families (
      profile_id, family_code, enabled, capabilities_json, created_at, updated_at
    ) VALUES (?, ?, 1, '[]', ?, ?)
  `)
  familyStatement.run(ACME_PROFILE_ID, OPENAI_CHAT_COMPLETIONS_FAMILY, now, now)
  familyStatement.run(ACME_PROFILE_ID, OPENAI_RESPONSES_FAMILY, now, now)
}

function readGroup(database: ReturnType<typeof databaseModule.getBusinessDatabase>, id: string): {
  system_account_id: string
  provider_code: string
  provider_protocol_profile_id: string
  protocol_code: string
  protocol_version: string
  is_default: number
  name: string
} {
  const row = database
    .prepare(`
      SELECT system_account_id, provider_code, provider_protocol_profile_id, protocol_code, protocol_version, is_default, name
      FROM groups
      WHERE id = ?
    `)
    .get(id) as {
      system_account_id?: string
      provider_code?: string
      provider_protocol_profile_id?: string
      protocol_code?: string
      protocol_version?: string
      is_default?: number
      name?: string
    } | undefined
  assert(row, `group ${id} should exist`)
  return {
    system_account_id: row.system_account_id ?? '',
    provider_code: row.provider_code ?? '',
    provider_protocol_profile_id: row.provider_protocol_profile_id ?? '',
    protocol_code: row.protocol_code ?? '',
    protocol_version: row.protocol_version ?? '',
    is_default: row.is_default ?? 0,
    name: row.name ?? ''
  }
}

function countGroups(database: ReturnType<typeof databaseModule.getBusinessDatabase>, systemAccountId: string, providerProtocolProfileId: string): number {
  const row = database
    .prepare('SELECT COUNT(*) AS count FROM groups WHERE system_account_id = ? AND provider_protocol_profile_id = ? AND is_default = 1')
    .get(systemAccountId, providerProtocolProfileId) as { count?: number } | undefined
  return Number(row?.count ?? 0)
}
