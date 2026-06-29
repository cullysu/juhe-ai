import { strict as assert } from 'node:assert'
import { mkdirSync, rmSync } from 'node:fs'
import http from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import express from 'express'

import { runtimeConfig } from '../../config/runtime.js'
import {
  OPENAI_CHAT_COMPLETIONS_FAMILY,
  OPENAI_PROTOCOL_CODE,
  OPENAI_PROTOCOL_VERSION,
  OPENAI_RESPONSES_FAMILY
} from '../../domain/provider-protocol.js'
import { captureGatewayRawBody } from '../../modules/gateway/request/body-middleware.js'
import { logger } from '../../shared/logger.js'
import { seedDefaults } from '../../storage/schema/seed-defaults.js'

const CCSWITCH_PROVIDER_CODE = 'ccswitch'
const CCSWITCH_PROFILE_ID = 'profile_ccswitch_openai_v1'

const tempRoot = resolve(tmpdir(), `juhe-ai-ccswitch-openai-v1-usage-account-${Date.now()}-${Math.random().toString(16).slice(2)}`)
runtimeConfig.databasePath = join(tempRoot, 'business.sqlite3')
runtimeConfig.datasetDatabasePath = join(tempRoot, 'dataset.sqlite3')
runtimeConfig.statsDatabasePath = join(tempRoot, 'stats.sqlite3')
runtimeConfig.usageShardRoot = join(tempRoot, 'usage-shards')
runtimeConfig.secret = 'ccswitch-openai-v1-usage-account-secret'
runtimeConfig.log.consoleEnabled = false
runtimeConfig.log.fileEnabled = false
runtimeConfig.processRole = 'db-service'
runtimeConfig.upstreamUrlSecurity.allowPrivateBaseUrls = true
mkdirSync(tempRoot, { recursive: true })
logger.level = 'silent'

const [
  { openAIGatewayRouter },
  { requestContextMiddleware },
  databaseModule,
  repositories,
  gatewayCache,
  accountSideEffects,
  usageRecordQueue,
  auditLogQueue
] = await Promise.all([
  import('../../modules/gateway/routes.js'),
  import('../../shared/request-context.js'),
  import('../../storage/database.js'),
  import('../../storage/repositories.js'),
  import('../../modules/gateway/runtime/runtime-cache.service.js'),
  import('../../modules/gateway/runtime/account-side-effects.service.js'),
  import('../../modules/gateway/usage/record-queue.service.js'),
  import('../../modules/audit-logs/audit-log-queue.service.js')
])

const access = { systemAccountId: 'sys_admin', role: 'admin' as const }
const traceId = 'trace_ccswitch_openai_v1_usage_account_regression'

let upstreamHitCount = 0
let upstreamAuthorization = ''
let upstreamPath = ''
let upstreamRequestBody = ''

const app = express()
app.use(requestContextMiddleware)
app.use('/v1', express.raw({ type: () => true, limit: '8mb' }), captureGatewayRawBody, openAIGatewayRouter)

try {
  usageRecordQueue.setDbServiceUsageRecordLocalWriteAllowedForTest(true)
  auditLogQueue.setDbServiceAuditLogLocalWriteAllowedForTest(true)
  gatewayCache.clearGatewayRuntimeCache()

  let upstreamServer: http.Server | undefined
  let appServer: http.Server | undefined
  try {
    upstreamServer = createMockOpenAIResponsesUpstream()
    await listen(upstreamServer)
    const upstreamBaseUrl = `http://127.0.0.1:${serverAddress(upstreamServer).port}`

    const database = databaseModule.getBusinessDatabase()
    seedDefaults(database)
    insertSyntheticProvider(database, new Date().toISOString())

    const provider = repositories.listProviders().find((item) => item.code === CCSWITCH_PROVIDER_CODE)
    assert(provider, 'ccswitch provider should be visible after seeding')
    assert.equal(provider.defaultProtocolProfileId, CCSWITCH_PROFILE_ID, 'ccswitch provider should keep its OpenAI v1 default profile')
    assert.equal(provider.protocolProfiles.length, 1, 'ccswitch provider should expose exactly one profile')
    assert.equal(provider.protocolProfiles[0]?.endpointFamilies.length, 2, 'ccswitch profile should expose both OpenAI endpoint families')

    const group = repositories.createGroup({
      name: 'CCSwitch OpenAI v1 单选分组',
      providerCode: CCSWITCH_PROVIDER_CODE,
      enabled: true
    }, access)
    const account = repositories.createAccount({
      providerCode: CCSWITCH_PROVIDER_CODE,
      name: 'CCSwitch OpenAI v1 上游账号',
      type: 'api_key',
      clientCompatibility: 'openai_standard',
      credentials: {
        api_key: 'sk-ccswitch-upstream',
        base_url: upstreamBaseUrl,
        supported_endpoint_modes: ['chat_json', 'chat_sse', 'responses_json', 'responses_sse']
      },
      groupId: group.id,
      status: 'active',
      schedulable: true,
      priority: 10
    }, access)

    const selection = repositories.listOpenAIAccountsForGroupResult(group.id, access.systemAccountId)
    assert(selection.diagnostics, 'single-select diagnostics should be available')
    assert.equal(selection.accounts.length, 1, 'ccswitch group should resolve exactly one eligible account')
    assert.equal(selection.diagnostics?.candidateRowCount, 1, 'ccswitch group diagnostics should report one candidate row')
    assert.equal(selection.diagnostics?.finalAccountCount, 1, 'ccswitch group diagnostics should report one final account')
    assert.equal(selection.accounts[0]?.id, account.id, 'single-select helper should return the ccswitch account')
    assert.equal(selection.accounts[0]?.providerCode, CCSWITCH_PROVIDER_CODE, 'single-select helper should keep the synthetic provider code')
    assert.equal(selection.accounts[0]?.providerProtocolProfileId, CCSWITCH_PROFILE_ID, 'single-select helper should keep the synthetic profile id')
    assert.equal(repositories.selectOpenAIAccountForGroup(group.id, access.systemAccountId)?.id, account.id, 'selectOpenAIAccountForGroup should return the only ccswitch account')

    const apiKey = repositories.createApiKeyRecord({
      name: 'CCSwitch OpenAI v1 网关 Key',
      groupBindings: [{ groupId: group.id, priority: 1, status: 'active' }],
      status: 'active'
    }, access)
    assert(apiKey.key, 'gateway API key should be returned in clear text')

    appServer = http.createServer(app)
    await listen(appServer)
    const baseUrl = `http://127.0.0.1:${serverAddress(appServer).port}`

    const response = await fetch(`${baseUrl}/v1/responses`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey.key}`,
        'content-type': 'application/json',
        'x-trace-id': traceId
      },
      body: JSON.stringify({
        model: 'gpt-5.5',
        input: 'hello ccswitch',
        stream: false
      })
    })
    const responseText = await response.text()
    assert.equal(response.status, 200, `ccswitch OpenAI v1 request should succeed, got HTTP ${response.status}: ${responseText}`)
    const responseBody = JSON.parse(responseText) as {
      output_text?: string
      usage?: { input_tokens?: number; output_tokens?: number; total_tokens?: number }
    }
    assert.equal(responseBody.output_text, 'ccswitch ok', 'responses payload should come back from the mock upstream')
    assert.equal(responseBody.usage?.input_tokens, 3, 'responses payload should keep upstream usage input tokens')
    assert.equal(responseBody.usage?.output_tokens, 4, 'responses payload should keep upstream usage output tokens')
    assert.equal(upstreamHitCount, 1, 'gateway should call the mock upstream exactly once')
    assert.equal(upstreamPath, '/v1/responses', 'gateway should normalize a ccswitch base URL without /v1 to the OpenAI v1 responses path')
    assert.equal(upstreamAuthorization, 'Bearer sk-ccswitch-upstream', 'gateway should forward the synthetic account key')
    assert.match(upstreamRequestBody, /"model":"gpt-5\.5"/, 'upstream request body should keep the requested model')
    assert.match(upstreamRequestBody, /"input":"hello ccswitch"/, 'upstream request body should keep the request input')

    usageRecordQueue.flushAllUsageRecordQueue()
    const usageRecords = repositories.listUsageRecords(undefined, { traceId, page: 1, pageSize: 20 })
    assert.equal(usageRecords.items.length, 1, 'traceId lookup should return exactly one usage record')
    const record = usageRecords.items[0]
    assert(record, 'usage record should exist after flush')
    assert.equal(record.traceId, traceId, 'usage record should keep the forced trace id')
    assert.equal(record.accountId, account.id, 'usage record should keep the real ccswitch account id')
    assert.equal(record.accountName, account.name, 'usage record should keep the real ccswitch account name')
    assert.notEqual(record.accountName, '无目标账户', 'successful ccswitch usage should not fall back to 无目标账户')
    assert.equal(record.groupId, group.id, 'usage record should keep the real group id')
    assert.equal(record.apiKeyId, apiKey.id, 'usage record should keep the real API key id')
    assert.equal(record.providerCode, CCSWITCH_PROVIDER_CODE, 'usage record should keep the synthetic provider code')
    assert.equal(record.endpoint, 'POST /v1/responses', 'usage record should keep the OpenAI v1 responses endpoint')
    assert.equal(record.model, 'gpt-5.5', 'usage record should keep the requested model')
    assert.equal(record.success, true, 'usage record should be marked as successful')
    assert.equal(record.statusCode, 200, 'usage record should keep the upstream status code')
    assert.equal(record.inputTokens, 3, 'usage record should keep upstream input tokens')
    assert.equal(record.outputTokens, 4, 'usage record should keep upstream output tokens')

    console.log('ccswitch openai v1 usage account regression passed')
  } finally {
    usageRecordQueue.flushAllUsageRecordQueue()
    accountSideEffects.clearGatewayLocalAccountSuppressionsForTest()
    usageRecordQueue.clearUsageRecordQueueForTest()
    auditLogQueue.clearAuditLogQueueForTest()
    auditLogQueue.setDbServiceAuditLogLocalWriteAllowedForTest(false)
    usageRecordQueue.setDbServiceUsageRecordLocalWriteAllowedForTest(false)
    await closeServer(appServer)
    await closeServer(upstreamServer)
    try {
      databaseModule.getBusinessDatabase().close()
      databaseModule.closeStorageDatabases()
    } catch {
    }
    rmSync(tempRoot, { recursive: true, force: true })
  }
} catch (error) {
  console.error(error)
  process.exitCode = 1
}

function insertSyntheticProvider(database: ReturnType<typeof databaseModule.getBusinessDatabase>, now: string): void {
  database
    .prepare(`
      INSERT INTO providers (
        id, code, name, description, parent_code, enabled, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `)
    .run(
      CCSWITCH_PROVIDER_CODE,
      CCSWITCH_PROVIDER_CODE,
      'CCSwitch',
      'Synthetic provider for ccswitch regression coverage',
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
      CCSWITCH_PROFILE_ID,
      CCSWITCH_PROVIDER_CODE,
      'CCSwitch / OpenAI v1',
      'Synthetic OpenAI-compatible profile for regression coverage',
      OPENAI_PROTOCOL_CODE,
      OPENAI_PROTOCOL_VERSION,
      'https://ccswitch.example/v1',
      'ccswitch-default',
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
  familyStatement.run(CCSWITCH_PROFILE_ID, OPENAI_CHAT_COMPLETIONS_FAMILY, now, now)
  familyStatement.run(CCSWITCH_PROFILE_ID, OPENAI_RESPONSES_FAMILY, now, now)
}

function createMockOpenAIResponsesUpstream(): http.Server {
  return http.createServer((req, res) => {
    upstreamHitCount += 1
    upstreamPath = req.url?.split('?', 1)[0] ?? ''
    upstreamAuthorization = String(req.headers.authorization ?? '')
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      upstreamRequestBody = Buffer.concat(chunks).toString('utf8')
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({
        id: 'resp-ccswitch-openai-v1',
        status: 'completed',
        output_text: 'ccswitch ok',
        usage: {
          input_tokens: 3,
          output_tokens: 4,
          total_tokens: 7
        }
      }))
    })
  })
}

function listen(server: http.Server): Promise<void> {
  if (server.listening) return Promise.resolve()
  server.listen(0, '127.0.0.1')
  return new Promise((resolvePromise, rejectPromise) => {
    server.once('listening', resolvePromise)
    server.once('error', rejectPromise)
  })
}

function serverAddress(server: http.Server): { port: number } {
  const address = server.address()
  assert(typeof address === 'object' && address !== null, 'server should be listening')
  return { port: address.port }
}

function closeServer(server: http.Server | undefined): Promise<void> {
  if (!server || !server.listening) return Promise.resolve()
  return new Promise((resolvePromise, rejectPromise) => {
    server.close((error) => {
      if (error) rejectPromise(error)
      else resolvePromise()
    })
  })
}
