import { defaultAccountEndpointModes, accountEndpointModeOptions } from '../../views/accounts/accountEndpointModes'
import { defaultAccountForm } from '../../views/accounts/accountFormDefaults'
import { OPENAI_COMPATIBLE_PROVIDER } from '../../views/accounts/accountOptions'

const expectedEndpointModes = accountEndpointModeOptions.map((item) => item.value)

const defaultModes = defaultAccountEndpointModes(
  OPENAI_COMPATIBLE_PROVIDER.code,
  'api_key',
  'openai_standard'
)

assertDeepEqual(
  defaultModes,
  expectedEndpointModes,
  'OpenAI-compatible API key defaults should expose every supported endpoint mode'
)
assert(
  defaultModes.some((mode) => mode.startsWith('responses_')),
  'OpenAI-compatible API key defaults must include responses modes'
)
assert(
  !defaultModes.every((mode) => mode.startsWith('chat_')),
  'OpenAI-compatible API key defaults must not be chat-only'
)

const defaultForm = defaultAccountForm(
  OPENAI_COMPATIBLE_PROVIDER.code,
  'api_key',
  [OPENAI_COMPATIBLE_PROVIDER]
)

assertEqual(defaultForm.clientCompatibility, 'openai_standard', 'OpenAI-compatible API key defaults should stay on openai_standard compatibility')
assertDeepEqual(
  defaultForm.supportedEndpointModes,
  defaultModes,
  'Default account form should keep endpoint modes aligned with the routing helper'
)

console.log('account default endpoint modes regression passed')

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message)
  }
}

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
