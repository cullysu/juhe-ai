import assert from 'node:assert/strict'
import type { Request } from 'express'

import {
  defaultOpenAIEndpointModes,
  normalizeOpenAIEndpointModesForWrite
} from '../../domain/openai-endpoint-modes.js'
import type { AccountSummary, AccountSupportedEndpointMode } from '../../domain/types.js'
import { mergeAccountCredentialsForUpdate } from '../../modules/accounts/account-credential-update.js'
import { filterGatewayAccountsByRequestCapability } from '../../modules/gateway/dispatch/account-capability-filter.js'
import type { UpstreamAccount } from '../../modules/gateway/protocols/openai-v1/route-helpers.js'

assert.deepEqual(
  defaultOpenAIEndpointModes({ providerCode: 'openai', accountType: 'api_key' }),
  ['chat_json', 'chat_sse', 'responses_json', 'responses_sse'],
  'OpenAI-compatible API keys should default to Chat and Responses JSON/SSE'
)
assert.deepEqual(
  defaultOpenAIEndpointModes({ providerCode: 'openai', accountType: 'api_key', clientCompatibility: 'codex_responses' }),
  ['chat_json', 'chat_sse', 'responses_json', 'responses_sse'],
  'Codex Responses compatibility should include Responses SSE by default'
)
assert.deepEqual(
  defaultOpenAIEndpointModes({ providerCode: 'gpt', accountType: 'api_key' }),
  ['chat_json', 'chat_sse', 'responses_json', 'responses_sse'],
  'GPT API Key default enables all OpenAI v1 endpoint modes'
)
assert.deepEqual(
  defaultOpenAIEndpointModes({ providerCode: 'gpt', accountType: 'oauth' }),
  ['responses_json', 'responses_sse'],
  'GPT OAuth should default to Responses JSON/SSE'
)
assert.throws(
  () => normalizeOpenAIEndpointModesForWrite(['chat_json', 'bad_mode'], { providerCode: 'openai', accountType: 'api_key' }),
  /bad_mode/,
  'Endpoint mode writes must reject unknown enum values'
)
assert.deepEqual(
  mergeAccountCredentialsForUpdate({
    type: 'api_key',
    credentials: {
      api_key: 'sk-old',
      base_url: 'https://example.com/v1',
      supported_endpoint_modes: ['chat_json']
    }
  } as AccountSummary, {
    api_key: 'sk-new'
  }).supported_endpoint_modes,
  ['chat_json'],
  'Partial credential updates must preserve existing endpoint mode limits'
)

const chatOnly = account('chat-only', ['chat_json', 'chat_sse'])
const responsesOnly = account('responses-only', ['responses_json', 'responses_sse'])
const jsonOnly = account('json-only', ['chat_json', 'responses_json'])

assert.deepEqual(
  filterGatewayAccountsByRequestCapability(request('/v1/chat/completions', true), [chatOnly, responsesOnly, jsonOnly]).accounts.map((item) => item.id),
  ['chat-only'],
  'Chat SSE requests should only hit accounts that support chat_sse'
)
assert.deepEqual(
  filterGatewayAccountsByRequestCapability(request('/v1/responses', false), [chatOnly, responsesOnly, jsonOnly]).accounts.map((item) => item.id),
  ['responses-only', 'json-only'],
  'Responses JSON requests should only hit accounts that support responses_json'
)
assert.deepEqual(
  filterGatewayAccountsByRequestCapability(request('/v1/embeddings', false), [chatOnly]).accounts.map((item) => item.id),
  ['chat-only'],
  'Unknown OpenAI v1 paths should still pass through for API key accounts'
)
assert.deepEqual(
  filterGatewayAccountsByRequestCapability(request('/v1/chat/completions', false), [oauthAccount('oauth')]).accounts.map((item) => item.id),
  [],
  'OAuth accounts should not handle Chat Completions paths'
)
assert.deepEqual(
  filterGatewayAccountsByRequestCapability(request('/v1/responses', false), [oauthAccount('oauth-json-only', ['responses_json'])]).accounts.map((item) => item.id),
  [],
  'OAuth normal Responses requests should be filtered by effective SSE capability'
)

console.log('OpenAI endpoint mode capability regression passed')

function request(path: string, stream: boolean): Request {
  return {
    method: 'POST',
    path,
    originalUrl: path,
    body: { stream }
  } as Request
}

function account(id: string, modes: AccountSupportedEndpointMode[]): UpstreamAccount {
  return {
    id,
    type: 'api_key',
    providerCode: 'openai',
    providerProtocolProfileId: 'profile_openai_openai_v1',
    protocolCode: 'openai',
    protocolVersion: 'v1',
    baseUrl: 'https://example.com/v1',
    supportedEndpointModes: modes,
    credentials: { supported_endpoint_modes: modes },
    clientCompatibility: 'openai_standard'
  } as unknown as UpstreamAccount
}

function oauthAccount(id: string, modes: AccountSupportedEndpointMode[] = ['responses_json', 'responses_sse']): UpstreamAccount {
  return {
    ...account(id, modes),
    type: 'oauth',
    providerCode: 'gpt',
    providerProtocolProfileId: 'profile_gpt_openai_v1',
    clientCompatibility: 'codex_responses'
  } as unknown as UpstreamAccount
}
