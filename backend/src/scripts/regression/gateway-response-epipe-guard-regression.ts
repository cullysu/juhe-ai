import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { setTimeout as sleep } from 'node:timers/promises'

import type { Response } from 'express'
import type { Logger } from 'pino'

import {
  attachGatewayResponseErrorGuard,
  isDownstreamTransportWriteError,
  writeResponseChunk
} from '../../modules/gateway/upstream/body.js'
import { createTraceId, withRequestContext, type RequestContext } from '../../shared/request-context.js'
import { isIgnorableProcessTransportError } from '../../shared/logger.js'

interface LogEntry {
  level: 'warn' | 'error'
  fields: Record<string, unknown>
  message: string
}

class EpipeAfterWriteResponse extends EventEmitter {
  locals: Record<string, unknown> = {}
  writableEnded = false
  destroyed = false
  headersSent = true
  writableLength = 0
  writableHighWaterMark = 16 * 1024

  write(): boolean {
    queueMicrotask(() => {
      const error = Object.assign(new Error('write EPIPE'), {
        code: 'EPIPE',
        syscall: 'write'
      })
      this.emit('error', error)
    })
    return true
  }

  end(): void {
    this.writableEnded = true
  }
}

const logs: LogEntry[] = []
const testLogger = {
  warn(fields: Record<string, unknown>, message: string) {
    logs.push({ level: 'warn', fields, message })
  },
  error(fields: Record<string, unknown>, message: string) {
    logs.push({ level: 'error', fields, message })
  }
} as unknown as Logger

function context(): RequestContext {
  return {
    traceId: createTraceId(),
    startedAt: Date.now(),
    method: 'POST',
    path: '/responses',
    originalUrl: '/responses',
    logger: testLogger
  }
}

let uncaught: unknown
const onUncaught = (error: unknown) => {
  uncaught = error
}
process.once('uncaughtException', onUncaught)

await withRequestContext(context(), async () => {
  const res = new EpipeAfterWriteResponse() as unknown as Response
  attachGatewayResponseErrorGuard(res)
  attachGatewayResponseErrorGuard(res)
  assert.equal((res as unknown as EventEmitter).listenerCount('error'), 1, 'response error guard should be attached once')

  const result = await writeResponseChunk(res, Buffer.from('ok'))
  assert.equal(result.backpressure, false)
  await sleep(1)
})

process.off('uncaughtException', onUncaught)

assert.equal(uncaught, undefined, 'response write EPIPE must stay request-scoped, not process-level')
assert.equal(logs.length, 1)
assert.equal(logs[0]?.level, 'warn')
assert.equal(logs[0]?.fields.event, 'gateway_response_transport_error')
assert.equal(logs[0]?.fields.errorCode, 'EPIPE')

const epipe = Object.assign(new Error('write EPIPE'), { code: 'EPIPE', syscall: 'write' })
const econnreset = Object.assign(new Error('write ECONNRESET'), { code: 'ECONNRESET', syscall: 'write' })
const other = Object.assign(new Error('listen EADDRINUSE'), { code: 'EADDRINUSE', syscall: 'listen' })

assert.equal(isDownstreamTransportWriteError(epipe), true)
assert.equal(isDownstreamTransportWriteError(econnreset), true)
assert.equal(isDownstreamTransportWriteError(other), false)
assert.equal(isIgnorableProcessTransportError(epipe), true)
assert.equal(isIgnorableProcessTransportError(econnreset), true)
assert.equal(isIgnorableProcessTransportError(other), false)

console.log('gateway response EPIPE guard regression passed')
