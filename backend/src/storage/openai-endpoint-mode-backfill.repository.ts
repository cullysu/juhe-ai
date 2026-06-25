import type { DatabaseSync } from 'node:sqlite'

import { decryptJson, encryptJson } from './crypto.js'
import { defaultOpenAIEndpointModes } from '../domain/openai-endpoint-modes.js'
import { isOpenAIProtocolProfile } from '../domain/provider-protocol.js'

export interface LegacyOpenAIEndpointModeBackfillResult {
  scannedCount: number
  candidateCount: number
  updatedCount: number
  skippedCount: number
}

export function applyLegacyOpenAIEndpointModeBackfill(database: DatabaseSync): LegacyOpenAIEndpointModeBackfillResult {
  const timestamp = new Date().toISOString()
  const rows = database
    .prepare(`
      SELECT
        accounts.id,
        accounts.provider_code,
        accounts.provider_protocol_profile_id,
        accounts.type,
        accounts.client_compatibility,
        accounts.credentials_encrypted,
        provider_protocol_profiles.protocol_code,
        provider_protocol_profiles.protocol_version
      FROM accounts
      INNER JOIN provider_protocol_profiles
        ON provider_protocol_profiles.id = accounts.provider_protocol_profile_id
      WHERE accounts.deleted_at IS NULL
        AND accounts.type = 'api_key'
        AND provider_protocol_profiles.protocol_code = 'openai'
        AND provider_protocol_profiles.protocol_version = 'v1'
      ORDER BY accounts.id ASC
    `)
    .all() as unknown as Array<{
      id?: string
      provider_code?: string
      provider_protocol_profile_id?: string
      type?: string
      client_compatibility?: string | null
      credentials_encrypted?: string
      protocol_code?: string
      protocol_version?: string
    }>

  const result: LegacyOpenAIEndpointModeBackfillResult = {
    scannedCount: rows.length,
    candidateCount: 0,
    updatedCount: 0,
    skippedCount: 0
  }
  const expectedModes = defaultOpenAIEndpointModes({
    accountType: 'api_key'
  })

  for (const row of rows) {
    const id = row.id?.trim()
    const credentialsEncrypted = row.credentials_encrypted?.trim()
    if (!id || !credentialsEncrypted) {
      continue
    }
    if (!isOpenAIProtocolProfile({
      protocolCode: row.protocol_code,
      protocolVersion: row.protocol_version
    })) {
      continue
    }
    const credentials = tryDecryptCredentials(credentialsEncrypted)
    if (!credentials) {
      continue
    }
    const currentModes = normalizeModes(credentials.supported_endpoint_modes)
    if (!isLegacyChatOnlyModes(currentModes, expectedModes.length)) {
      continue
    }
    result.candidateCount += 1
    const nextCredentials = {
      ...credentials,
      supported_endpoint_modes: expectedModes
    }
    database
      .prepare('UPDATE accounts SET credentials_encrypted = ?, updated_at = ? WHERE id = ?')
      .run(encryptJson(nextCredentials), timestamp, id)
    result.updatedCount += 1
  }

  result.skippedCount = result.scannedCount - result.candidateCount
  return result
}

function tryDecryptCredentials(value: string): Record<string, unknown> | undefined {
  try {
    return decryptJson<Record<string, unknown>>(value)
  } catch {
    return undefined
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

function isLegacyChatOnlyModes(currentModes: string[], expectedModeCount: number): boolean {
  if (!currentModes.length) return false
  if (currentModes.length >= expectedModeCount) return false
  return currentModes.every((mode) => mode === 'chat_json' || mode === 'chat_sse')
}
