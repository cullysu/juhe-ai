import { strict as assert } from 'node:assert'
import { mkdirSync, rmSync } from 'node:fs'
import http from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import express from 'express'

import { runtimeConfig } from '../../config/runtime.js'
import { captureGatewayRawBody } from '../../modules/gateway/request/body-middleware.js'
import { logger } from '../../shared/logger.js'
import { seedDefaults } from '../../storage/schema/seed-defaults.js'

const tempRoot = resolve(tmpdir(), `juhe-ai-api-key-provider-bound-route-${Date.now()}-${Math.random().toString(16).slice(2)}`)
runtimeConfig.databasePath = join(tempRoot, 'business.sqlite3')
runtimeConfig.datasetDatabasePath = join(tempRoot, 'dataset.sqlite3')
runtimeConfig.statsDatabasePath = join(tempRoot, 'stats.sqlite3')
runtimeConfig.usageShardRoot = join(tempRoot, 'usage-shards')
runtimeConfig.secret = 'api-key-provider-bound-route-secret'
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
  usageRecordQueue,
  auditLogQueue
] = await Promise.all([
  import('../../modules/gateway/routes.js'),
  import('../../shared/request-context.js'),
  import('../../storage/database.js'),
  import('../../storage/repositories.js'),
  import('../../modules/gateway/runtime/runtime-cache.service.js'),
  import('../../modules/gateway/usage/record-queue.service.js'),
  import('../../modules/audit-logs/audit-log-queue.service.js')
])

const access = { systemAccountId: 'sys_admin', role: 'admin' as const }
const traceId = 'trace_api_key_provider_bound_route_regression'
let foreignUpstreamHitCount = 0

const app = express()
app.use(requestContextMiddleware)
app.use('/v1', express.raw({ type: () => true, limit: '8mb' }), captureGatewayRawBody, openAIGatewayRouter)

try {
  usageRecordQueue.setDbServiceUsageRecordLocalWriteAllowedForTest(true)
  auditLogQueue.setDbServiceAuditLogLocalWriteAllowedForTest(true)
  gatewayCache.clearGatewayRuntimeCache()

  let foreignUpstreamServer: http.Server | undefined
  let appServer: http.Server | undefined
  try {
    foreignUpstreamServer = createForeignUpstream()
    await listen(foreignUpstreamServer)
    const foreignBaseUrl = `http://127.0.0.1:${serverAddress(foreignUpstreamServer).port}/v1`

    const database = databaseModule.getBusinessDatabase()
    seedDefaults(database)

    const primaryGroup = repositories.createGroup({
      name: 'Provider-bound primary group',
      providerCode: 'gpt',
      enabled: true
    }, access)
    const foreignGroup = repositories.createGroup({
      name: 'Provider-bound foreign group',
      providerCode: 'md',
      enabled: true
    }, access)
    const foreignAccount = repositories.createAccount({
      providerCode: 'md',
      name: 'Provider-bound foreign account',
      type: 'api_key',
      clientCompatibility: 'openai_standard',
      credentials: {
        api_key: 'sk-provider-bound-foreign-upstream',
        base_url: foreignBaseUrl,
        supported_endpoint_modes: ['chat_json', 'chat_sse', 'responses_json', 'responses_sse']
      },
      groupId: foreignGroup.id,
      status: 'active',
      schedulable: true
    }, access)
    const apiKey = repositories.createApiKeyRecord({
      name: 'Provider-bound route key',
      groupBindings: [{ groupId: primaryGroup.id, priority: 1, status: 'active' }],
      status: 'active'
    }, access)
    assert(apiKey.key, 'gateway API key should be available')

    database
      .prepare(`
        INSERT INTO api_key_group_bindings (id, api_key_id, system_account_id, group_id, priority, weight, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        `akgb_legacy_cross_provider_${Date.now()}`,
        apiKey.id,
        access.systemAccountId,
        foreignGroup.id,
        2,
        1,
        'active',
        new Date().toISOString(),
        new Date().toISOString()
      )

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
        input: 'provider boundary check',
        stream: false
      })
    })
    const responseText = await response.text()
    assert.equal(response.status, 503, `provider boundary should keep the request on the empty primary group, got HTTP ${response.status}: ${responseText}`)
    assert.match(responseText, /service_unavailable|没有可用的上游账户/, 'gateway response should explain that no upstream account is available')
    assert.equal(foreignUpstreamHitCount, 0, 'foreign provider upstream must not be called by automatic API key group fallback')

    usageRecordQueue.flushAllUsageRecordQueue()
    const usageRecords = repositories.listUsageRecords(undefined, { traceId, page: 1, pageSize: 20 })
    assert.equal(usageRecords.items.length, 1, 'traceId lookup should return exactly one failure usage record')
    const record = usageRecords.items[0]
    assert(record, 'failure usage record should exist')
    assert.equal(record.accountId, undefined, 'provider-bound failure should not attach a foreign account id')
    assert.equal(record.accountName, '无目标账户', 'provider-bound failure should display the no-target account label')
    assert.equal(record.groupId, primaryGroup.id, 'failure record should stay on the originally selected provider group')
    assert.equal(record.providerCode, 'gpt', 'failure record should keep the original provider code')
    assert.equal(record.errorCode, 'service_unavailable', 'failure record should keep the real dispatch error code')
    assert.match(record.errorMessage ?? '', /没有可用的上游账户/, 'failure record should keep the dispatch reason')
    assert.notEqual(record.accountId, foreignAccount.id, 'failure record must not point at the foreign provider account')

    console.log('api key provider-bound route regression passed')
  } finally {
    usageRecordQueue.flushAllUsageRecordQueue()
    usageRecordQueue.clearUsageRecordQueueForTest()
    auditLogQueue.clearAuditLogQueueForTest()
    auditLogQueue.setDbServiceAuditLogLocalWriteAllowedForTest(false)
    usageRecordQueue.setDbServiceUsageRecordLocalWriteAllowedForTest(false)
    await closeServer(appServer)
    await closeServer(foreignUpstreamServer)
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

function createForeignUpstream(): http.Server {
  return http.createServer((_req, res) => {
    foreignUpstreamHitCount += 1
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({
      id: 'resp-provider-bound-foreign',
      status: 'completed',
      output_text: 'foreign provider should not be used',
      usage: {
        input_tokens: 1,
        output_tokens: 1,
        total_tokens: 2
      }
    }))
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
