import { defaultAccountForm } from '../../views/accounts/accountFormDefaults'
import { defaultAccountEndpointModes } from '../../views/accounts/accountEndpointModes'
import { FALLBACK_PROVIDERS, GPT_PROVIDER, MD_PROVIDER } from '../../views/accounts/accountOptions'
import { providerDisplayName } from '../../shared/providerDisplay'
import { preferredDefaultProviderCode } from '../../shared/providerProtocol'

assertEqual(FALLBACK_PROVIDERS.some((provider) => provider.code === 'md'), true, 'fallback providers should include md')
assertEqual(providerDisplayName('md'), 'MD', 'provider display names should resolve md without a provider list')
assertEqual(providerDisplayName('md', FALLBACK_PROVIDERS), 'MD', 'provider display names should resolve md from fallback providers')
assertEqual(preferredDefaultProviderCode([MD_PROVIDER]), 'md', 'md should be the preferred default when it is the only available provider')
assertEqual(preferredDefaultProviderCode([GPT_PROVIDER, MD_PROVIDER]), 'md', 'md should outrank GPT when both are available')

const expectedEndpointModes = ['chat_json', 'chat_sse', 'responses_json', 'responses_sse']
assertDeepEqual(
  defaultAccountEndpointModes('md', 'api_key', 'openai_standard'),
  expectedEndpointModes,
  'md api_key accounts should expose the full endpoint mode set'
)

const mdOnlyForm = defaultAccountForm('', '', [MD_PROVIDER])
assertEqual(mdOnlyForm.providerCode, 'md', 'default account form should choose md when md is the only provider')
assertEqual(mdOnlyForm.providerProtocolProfileId, 'profile_md_openai_v1', 'default account form should choose the md OpenAI v1 profile')
assertEqual(mdOnlyForm.type, 'api_key', 'default account form should choose md api_key accounts')
assertEqual(mdOnlyForm.clientCompatibility, 'openai_standard', 'md should stay on openai_standard compatibility')
assertDeepEqual(mdOnlyForm.supportedEndpointModes, expectedEndpointModes, 'md should keep the full endpoint mode set')

const explicitMdForm = defaultAccountForm('md', 'api_key', [MD_PROVIDER])
assertEqual(explicitMdForm.providerCode, 'md', 'explicit md provider selection should remain md')
assertEqual(explicitMdForm.providerProtocolProfileId, 'profile_md_openai_v1', 'explicit md provider selection should use the md profile')
assertDeepEqual(explicitMdForm.supportedEndpointModes, expectedEndpointModes, 'explicit md provider selection should keep the full endpoint mode set')

console.log('md provider selection regression passed')

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
