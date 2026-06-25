import { strict as assert } from 'node:assert'
import { mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { SQLInputValue } from 'node:sqlite'

import { runtimeConfig } from '../../config/runtime.js'
import {
  MD_OPENAI_V1_PROFILE_ID,
  MD_VENDOR_CODE
} from '../../domain/provider-protocol.js'
import { logger } from '../../shared/logger.js'

const tempRoot = resolve(tmpdir(), `juhe-ai-md-single-select-routing-${Date.now()}-${Math.random().toString(16).slice(2)}`)
runtimeConfig.databasePath = join(tempRoot, 'business.sqlite3')
runtimeConfig.datasetDatabasePath = join(tempRoot, 'dataset.sqlite3')
runtimeConfig.statsDatabasePath = join(tempRoot, 'stats.sqlite3')
runtimeConfig.secret = 'md-single-select-routing-secret'
runtimeConfig.log.consoleEnabled = false
runtimeConfig.log.fileEnabled = false
mkdirSync(tempRoot, { recursive: true })
logger.level = 'silent'

const [
  databaseModule,
  repositories,
  defaultGroupRepository,
  { seedDefaults }
] = await Promise.all([
  import('../../storage/database.js'),
  import('../../storage/repositories.js'),
  import('../../storage/default-group.repository.js'),
  import('../../storage/schema/seed-defaults.js')
])

try {
  const database = databaseModule.getBusinessDatabase()

  const beforeReseed = readMdSeedState(database)
  seedDefaults(database)
  const afterReseed = readMdSeedState(database)
  assert.deepEqual(afterReseed, beforeReseed, 'md seed rows should stay stable across reseed')

  const mdProvider = repositories.listProviders().find((provider) => provider.code === MD_VENDOR_CODE)
  assert(mdProvider, 'md provider should be listed')
  assert.equal(mdProvider.defaultProtocolProfileId, MD_OPENAI_V1_PROFILE_ID, 'md provider should default to its OpenAI v1 profile')
  assert.equal(mdProvider.protocolProfiles.length, 1, 'md provider should expose exactly one built-in profile')
  assert.equal(mdProvider.protocolProfiles[0]?.endpointFamilies.length, 2, 'md profile should expose both OpenAI v1 endpoint families')

  const adminMdGroupId = defaultGroupRepository.defaultGroupIdForSystemAccount(MD_OPENAI_V1_PROFILE_ID, 'sys_admin')
  assert.equal(adminMdGroupId, 'grp_default_md_sys_admin', 'sys_admin should get the built-in md default group')

  const owner = repositories.createSystemAccount({
    username: `md_single_select_${Date.now()}`,
    displayName: 'MD_single_select_owner',
    password: 'password',
    role: 'user',
    status: 'active',
    mustChangePassword: false
  })

  const ownerMdGroupId = defaultGroupRepository.defaultGroupIdForSystemAccount(MD_OPENAI_V1_PROFILE_ID, owner.id)
  assert(ownerMdGroupId, 'new users should receive a built-in md default group')

  const account = repositories.createAccount({
    name: 'MD single select account',
    providerCode: MD_VENDOR_CODE,
    providerProtocolProfileId: MD_OPENAI_V1_PROFILE_ID,
    groupId: ownerMdGroupId,
    type: 'api_key',
    status: 'active',
    concurrencyLimit: 1,
    priority: 10,
    clientCompatibility: 'openai_standard',
    credentials: {
      api_key: 'sk-md-single-select',
      base_url: 'https://example.invalid/v1',
      supported_endpoint_modes: ['chat_json', 'chat_sse', 'responses_json', 'responses_sse']
    }
  }, { systemAccountId: owner.id, role: 'user' })

  const selection = repositories.listOpenAIAccountsForGroupResult(ownerMdGroupId, owner.id)
  assert(selection.diagnostics, 'md selection should provide diagnostics')
  assert.equal(selection.accounts.length, 1, 'md group should resolve exactly one eligible account')
  assert.equal(selection.diagnostics?.finalAccountCount, 1, 'md group diagnostics should report one final account')
  assert.equal(selection.accounts[0]?.id, account.id, 'md selection should return the created account')
  assert.equal(selection.accounts[0]?.providerCode, MD_VENDOR_CODE, 'md selection should keep the md provider code')
  assert.equal(selection.accounts[0]?.providerProtocolProfileId, MD_OPENAI_V1_PROFILE_ID, 'md selection should keep the md profile id')
  assert.equal(repositories.selectOpenAIAccountForGroup(ownerMdGroupId, owner.id)?.id, account.id, 'single-select helper should return the md account')

  console.log('md supplier single-select routing regression passed')
} finally {
  try {
    databaseModule.getBusinessDatabase().close()
    databaseModule.closeStorageDatabases()
  } catch {
  }
  rmSync(tempRoot, { recursive: true, force: true })
}

function readMdSeedState(database: ReturnType<typeof databaseModule.getBusinessDatabase>): {
  providerCount: number
  profileCount: number
  profileFamilyCount: number
  defaultGroupCount: number
} {
  return {
    providerCount: readCount(database, 'SELECT COUNT(*) AS count FROM providers WHERE code = ?', [MD_VENDOR_CODE]),
    profileCount: readCount(database, 'SELECT COUNT(*) AS count FROM provider_protocol_profiles WHERE id = ?', [MD_OPENAI_V1_PROFILE_ID]),
    profileFamilyCount: readCount(database, 'SELECT COUNT(*) AS count FROM provider_protocol_profile_families WHERE profile_id = ?', [MD_OPENAI_V1_PROFILE_ID]),
    defaultGroupCount: readCount(
      database,
      'SELECT COUNT(*) AS count FROM groups WHERE system_account_id = ? AND provider_protocol_profile_id = ? AND is_default = 1',
      ['sys_admin', MD_OPENAI_V1_PROFILE_ID]
    )
  }
}

function readCount(database: ReturnType<typeof databaseModule.getBusinessDatabase>, sql: string, params: SQLInputValue[]): number {
  const row = database.prepare(sql).get(...params) as { count?: number } | undefined
  return Number(row?.count ?? 0)
}
