import type { ProviderDefinition } from '@/types/domain'
import { defaultProviderProtocolProfileId, preferredDefaultProviderCode } from '../../shared/providerProtocol'
import { defaultAccountEndpointModes } from '../../views/accounts/accountEndpointModes'
import { defaultAccountForm } from '../../views/accounts/accountFormDefaults'
import { providerDisplayName } from '../../shared/providerDisplay'
import {
  FALLBACK_PROVIDERS,
  GPT_PROVIDER,
  MD_PROVIDER,
  OPENAI_COMPATIBLE_PROVIDER
} from '../../views/accounts/accountOptions'
import {
  OPENAI_CHAT_COMPLETIONS_FAMILY,
  OPENAI_PROTOCOL_CODE,
  OPENAI_PROTOCOL_VERSION,
  OPENAI_RESPONSES_FAMILY
} from '../../shared/providerProtocol'

const ACME_PROVIDER_CODE = 'acme'
const ACME_PROFILE_ID = 'profile_acme_openai_v1'

const ACME_PROVIDER: ProviderDefinition = {
  id: ACME_PROVIDER_CODE,
  code: ACME_PROVIDER_CODE,
  name: 'ACME',
  enabled: true,
  defaultProtocolProfileId: ACME_PROFILE_ID,
  protocolCode: OPENAI_PROTOCOL_CODE,
  protocolVersion: OPENAI_PROTOCOL_VERSION,
  baseUrl: 'https://acme.example/v1',
  defaultTestModel: 'acme-default',
  accountTypes: ['api_key'],
  capabilities: ['responses', 'chat', 'passthrough'],
  protocolProfiles: [
    {
      id: ACME_PROFILE_ID,
      providerCode: ACME_PROVIDER_CODE,
      name: 'ACME / OpenAI v1',
      enabled: true,
      protocolCode: OPENAI_PROTOCOL_CODE,
      protocolVersion: OPENAI_PROTOCOL_VERSION,
      baseUrl: 'https://acme.example/v1',
      defaultTestModel: 'acme-default',
      accountTypes: ['api_key'],
      capabilities: ['responses', 'chat', 'passthrough'],
      endpointFamilies: [
        { code: OPENAI_CHAT_COMPLETIONS_FAMILY, name: 'Chat Completions' },
        { code: OPENAI_RESPONSES_FAMILY, name: 'Responses' }
      ]
    }
  ]
}

const expectedEndpointModes = ['chat_json', 'chat_sse', 'responses_json', 'responses_sse']

assertEqual(preferredDefaultProviderCode([ACME_PROVIDER]), ACME_PROVIDER_CODE, 'synthetic provider should become the default when it is the only available provider')
assertEqual(defaultProviderProtocolProfileId(ACME_PROVIDER), ACME_PROFILE_ID, 'synthetic provider should keep its default profile id')
assertEqual(providerDisplayName(ACME_PROVIDER_CODE, [ACME_PROVIDER]), 'ACME', 'provider display names should resolve synthetic providers from real options')
assertDeepEqual(defaultAccountEndpointModes(ACME_PROVIDER_CODE, 'api_key', 'openai_standard'), expectedEndpointModes, 'synthetic API key providers should expose the full endpoint mode set')

const defaultForm = defaultAccountForm('', '', [ACME_PROVIDER])
assertEqual(defaultForm.providerCode, ACME_PROVIDER_CODE, 'default account form should select the synthetic provider once real options are available')
assertEqual(defaultForm.providerProtocolProfileId, ACME_PROFILE_ID, 'default account form should select the synthetic profile')
assertEqual(defaultForm.type, 'api_key', 'default account form should select the synthetic provider account type')
assertEqual(defaultForm.baseUrl, 'https://acme.example/v1', 'default account form should inherit the synthetic provider base url')
assertEqual(defaultForm.clientCompatibility, 'openai_standard', 'synthetic providers should stay on openai_standard compatibility')
assertDeepEqual(defaultForm.supportedEndpointModes, expectedEndpointModes, 'default account form should keep endpoint modes aligned for synthetic providers')

const explicitForm = defaultAccountForm(ACME_PROVIDER_CODE, 'api_key', [ACME_PROVIDER])
assertEqual(explicitForm.providerCode, ACME_PROVIDER_CODE, 'explicit synthetic provider selection should remain stable')
assertEqual(explicitForm.providerProtocolProfileId, ACME_PROFILE_ID, 'explicit synthetic provider selection should keep the synthetic profile')

assertEqual(
  preferredDefaultProviderCode(FALLBACK_PROVIDERS),
  OPENAI_COMPATIBLE_PROVIDER.code,
  'built-in fallback providers should prefer the generic openai provider'
)

const fallbackForm = defaultAccountForm('', '', FALLBACK_PROVIDERS)
assertEqual(fallbackForm.providerCode, OPENAI_COMPATIBLE_PROVIDER.code, 'built-in fallback providers should select openai on create')
assertEqual(fallbackForm.clientCompatibility, 'openai_standard', 'built-in fallback providers should keep openai_standard compatibility')
assertDeepEqual(fallbackForm.supportedEndpointModes, expectedEndpointModes, 'built-in fallback providers should keep the full endpoint mode set')

assertEqual(
  preferredDefaultProviderCode([GPT_PROVIDER, MD_PROVIDER]),
  MD_PROVIDER.code,
  'md should outrank GPT when no generic openai provider is available'
)

const mdFallbackForm = defaultAccountForm('', '', [GPT_PROVIDER, MD_PROVIDER])
assertEqual(mdFallbackForm.providerCode, MD_PROVIDER.code, 'md should be selected when only GPT and md are available')
assertEqual(mdFallbackForm.clientCompatibility, 'openai_standard', 'md should stay on openai_standard compatibility')
assertDeepEqual(mdFallbackForm.supportedEndpointModes, expectedEndpointModes, 'md should keep the full endpoint mode set')

console.log('generic provider selection regression passed')

function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (!Object.is(actual, expected)) {
    throw new Error(`${message}; got ${String(actual)}, expected ${String(expected)}`)
  }
}

function assertDeepEqual(actual: unknown, expected: unknown, message: string): void {
  const actualJson = JSON.stringify(actual)
  const expectedJson = JSON.stringify(expected)
  if (actualJson !== expectedJson) {
    throw new Error(`${message}; got ${actualJson}, expected ${expectedJson}`)
  }
}
