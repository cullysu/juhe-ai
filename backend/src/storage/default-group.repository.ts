import type { DatabaseSync } from 'node:sqlite'

import { GPT_OPENAI_V1_PROFILE_ID, GPT_VENDOR_CODE, isOpenAIProtocolProfile } from '../domain/provider-protocol.js'
import type { ProviderDefinition, ProviderProtocolProfileDefinition } from '../domain/types.js'
import { getBusinessDatabase, newId, nowIso } from './database.js'
import { listProviders } from './provider.repository.js'
import { DEFAULT_BUILT_IN_GROUPS } from './schema-defaults.js'

export function defaultGptGroupIdForSystemAccount(systemAccountId: string): string | undefined {
  return defaultGroupIdForSystemAccount(GPT_OPENAI_V1_PROFILE_ID, systemAccountId)
}

export function defaultGroupIdForSystemAccount(providerProtocolProfileId: string, systemAccountId: string, database = getBusinessDatabase()): string | undefined {
  const row = database
    .prepare('SELECT id FROM groups WHERE system_account_id = ? AND provider_protocol_profile_id = ? AND is_default = 1 ORDER BY updated_at DESC, id ASC LIMIT 1')
    .get(systemAccountId, providerProtocolProfileId) as unknown as { id?: string } | undefined
  return row?.id
}

export function ensureDefaultGroupsForSystemAccount(systemAccountId: string, timestamp = nowIso(), database = getBusinessDatabase()): void {
  const statement = database.prepare(`
      INSERT INTO groups (
        id, system_account_id, name, provider_code, provider_protocol_profile_id, protocol_code, protocol_version,
        description, enabled, is_default, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 1, ?, ?)
    `)
  for (const group of defaultGroupDefinitions(systemAccountId)) {
    if (defaultGroupIdForSystemAccount(group.providerProtocolProfileId, systemAccountId, database)) {
      continue
    }
    statement.run(
      group.id,
      systemAccountId,
      group.name,
      group.providerCode,
      group.providerProtocolProfileId,
      group.protocolCode,
      group.protocolVersion,
      group.description,
      timestamp,
      timestamp
    )
  }
}

export function ensureDefaultGroupsForAllSystemAccounts(timestamp = nowIso(), database = getBusinessDatabase()): void {
  const rows = database
    .prepare('SELECT id FROM system_accounts ORDER BY id ASC')
    .all() as unknown as Array<{ id?: string }>
  for (const row of rows) {
    const systemAccountId = row.id?.trim()
    if (!systemAccountId) continue
    ensureDefaultGroupsForSystemAccount(systemAccountId, timestamp, database)
  }
}

export function ensureDefaultBuiltInGroupsForSystemAccount(systemAccountId: string, timestamp = nowIso()): void {
  ensureDefaultGroupsForSystemAccount(systemAccountId, timestamp)
}

function defaultGroupDefinitions(systemAccountId: string): Array<{
  id: string
  systemAccountId: string
  name: string
  providerCode: string
  providerProtocolProfileId: string
  protocolCode: string
  protocolVersion: string
  description: string
}> {
  const builtInGroupsByProfileId = new Map<string, (typeof DEFAULT_BUILT_IN_GROUPS)[number]>(
    DEFAULT_BUILT_IN_GROUPS.map((group) => [group.providerProtocolProfileId, group])
  )
  const output: Array<{
    id: string
    systemAccountId: string
    name: string
    providerCode: string
    providerProtocolProfileId: string
    protocolCode: string
    protocolVersion: string
    description: string
  }> = []
  for (const provider of listProviders()) {
    if (!provider.enabled) continue
    const openAIProfiles = provider.protocolProfiles.filter((profile) => profile.enabled && isOpenAIProtocolProfile(profile))
    const profileCount = openAIProfiles.length
    for (const profile of openAIProfiles) {
      const builtInGroup = builtInGroupsByProfileId.get(profile.id)
      output.push(systemAccountId === 'sys_admin' && builtInGroup ? {
        ...builtInGroup
      } : {
        id: defaultGroupIdForProfile(provider, profile, systemAccountId, profileCount),
        systemAccountId,
        name: defaultGroupNameForProvider(provider, profile, profileCount),
        providerCode: provider.code,
        providerProtocolProfileId: profile.id,
        protocolCode: profile.protocolCode,
        protocolVersion: profile.protocolVersion,
        description: profile.description?.trim() || provider.description?.trim() || ''
      })
    }
  }
  return output
}

function defaultGroupIdForProfile(
  provider: ProviderDefinition,
  profile: ProviderProtocolProfileDefinition,
  systemAccountId: string,
  profileCount: number
): string {
  if (systemAccountId !== 'sys_admin') {
    return newId('grp')
  }
  if (profileCount === 1) {
    return `grp_default_${provider.code}_sys_admin`
  }
  return `grp_default_${profile.id}_sys_admin`
}

function defaultGroupNameForProvider(
  provider: ProviderDefinition,
  profile: ProviderProtocolProfileDefinition,
  profileCount: number
): string {
  const providerName = provider.name.trim() || provider.code
  if (profileCount === 1) {
    return `默认 ${providerName} 分组`
  }
  const profileName = profile.name.trim()
  if (profileName) {
    return `默认 ${providerName} ${profileName} 分组`
  }
  return `默认 ${providerName} 分组`
}
