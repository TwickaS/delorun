/**
 * The host half of the guide's key test: the {@link KEY_TEST_PATH} route tests each usable model provider route's key
 * with the provider's free model listing, never a completion, so it spends no tokens. A route whose adapter registered a
 * model discovery (every pi-ai route) is asked through upstream's `llm.discoverModels`, which supplies the stored key
 * inside the harness; the official DeepSeek route, which registers none, is asked through its own listing request
 * with the key its credential reference resolves to. The answer names each route and its result, never a key, an
 * address or a provider's message.
 * @module @delo/plugin-onboarding/key-test
 */
import type { KeyResult, KeyTestAnswer } from './wire.ts'
import { MAX_PROVIDERS } from './wire.ts'

/** The official DeepSeek route, which `@deepseek-ai/dsh-llm-deepseek-api-key` registers. */
export const DEEPSEEK_ROUTE = 'deepseek-official'

/** What the test reads and calls in the harness. */
export interface KeyTestDeps {
  /** @returns the usable provider routes, in the harness's order. */
  readonly providers: () => readonly { readonly id: string; readonly name: string }[]
  /** @returns the routes a settings page can configure, with the namespace whose discovery serves each. */
  readonly configurable: () => readonly { readonly provider: string; readonly settingsNs: string }[]
  /**
   * Ask a route's discovery for its models, with the stored key.
   * @param settingsNs - the namespace whose discovery serves the route.
   * @param provider - the route.
   * @param signal - the deadline.
   * @throws the discovery's failure, an error whose `code` names it.
   */
  readonly discover: (settingsNs: string, provider: string, signal: AbortSignal) => Promise<void>
  /**
   * Ask the official DeepSeek route's listing with its key.
   * @param signal - the deadline.
   * @returns the result.
   */
  readonly deepseek: (signal: AbortSignal) => Promise<KeyResult>
  /** The most time one route's test may take, in milliseconds. */
  readonly timeoutMs: number
}

/**
 * @param error - a failure.
 * @returns its `code` as text, or empty.
 */
function codeOf(error: unknown): string {
  const code: unknown = Reflect.get(Object(error), 'code')
  return typeof code === 'string' ? code : ''
}

/**
 * A discovery's failure as a result. Upstream's pi-ai discovery reports a refused key and an unreachable endpoint with
 * the same code, so those read as `failed`.
 * @param error - what the discovery threw.
 * @returns the result.
 */
export function discoveryResult(error: unknown): KeyResult {
  switch (codeOf(error)) {
    case 'MISSING_CREDENTIAL': return 'no-key'
    case 'NO_DISCOVERY':
    case 'DISCOVERY_UNSUPPORTED':
    case 'INVALID_DISCOVERY': return 'untested'
    case 'ABORTED':
    case 'TIMEOUT': return 'unreachable'
    default: return 'failed'
  }
}

/**
 * The official DeepSeek listing's failure as a result.
 * @param error - what the listing request threw.
 * @returns the result.
 */
export function listingResult(error: unknown): KeyResult {
  const code = codeOf(error)
  // The listing client reports INVALID_RESPONSE only for an answer with a success status, so the key was accepted.
  if (code === 'INVALID_RESPONSE') return 'works'
  if (code === 'HTTP_401' || code === 'HTTP_403') return 'rejected'
  if (code === 'TRANSPORT' || code === 'TIMEOUT' || code === 'ABORTED') return 'unreachable'
  if (code === 'MISSING_CREDENTIAL') return 'no-key'
  return 'failed'
}

/**
 * Test one route.
 * @param deps - the harness's parts.
 * @param provider - the route.
 * @returns the result.
 */
async function testRoute(deps: KeyTestDeps, provider: string): Promise<KeyResult> {
  const signal = AbortSignal.timeout(deps.timeoutMs)
  const namespace = deps.configurable().find(each => each.provider === provider)?.settingsNs
  if (namespace !== undefined) {
    try {
      await deps.discover(namespace, provider, signal)
      return 'works'
    } catch (error) {
      const result = discoveryResult(error)
      if (result !== 'untested' || provider !== DEEPSEEK_ROUTE) return result
    }
  }
  return provider === DEEPSEEK_ROUTE ? deps.deepseek(signal) : 'untested'
}

/**
 * Test every usable route, at most {@link MAX_PROVIDERS}, all at once.
 * @param deps - the harness's parts.
 * @returns each route with its name and result.
 */
export async function testKeys(deps: KeyTestDeps): Promise<KeyTestAnswer> {
  const routes = deps.providers().slice(0, MAX_PROVIDERS)
  const results = await Promise.all(routes.map(route => testRoute(deps, route.id).catch((): KeyResult => 'failed')))
  return { providers: routes.map((route, index) => ({ provider: route.id, name: route.name, result: results[index] as KeyResult })) }
}
