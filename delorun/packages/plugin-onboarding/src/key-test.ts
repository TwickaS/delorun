/**
 * The host half of the guide's key test: the {@link KEY_TEST_PATH} route tests each usable model provider route's key
 * with the provider's free model listing, never a completion, so it spends no tokens. A route that needs a key and has
 * no configured credential is `no-key` without a listing; a keyless route, such as a local model server, goes straight
 * to discovery. A route whose adapter registered a model discovery (every pi-ai route) is asked through upstream's
 * `llm.discoverModels`, which supplies the stored key inside the harness; the official DeepSeek route, which registers none, is asked through its own listing request with the key its credential reference resolves
 * to. The answer names each route and its result, never a key, an address or a provider's message.
 * @module @delorun/plugin-onboarding/key-test
 */
import type { KeyResult, KeyTestAnswer } from './wire.ts'
import { DEEPSEEK_ROUTE, MAX_PROVIDERS } from './wire.ts'

export { DEEPSEEK_ROUTE }

/** What the test reads and calls in the harness. */
export interface KeyTestDeps {
  /** @returns the usable provider routes, in the harness's order. */
  readonly providers: () => readonly { readonly id: string; readonly name: string }[]
  /** @returns the routes a settings page can configure, with the namespace whose discovery serves each. */
  readonly configurable: () => readonly { readonly provider: string; readonly settingsNs: string }[]
  /**
   * Whether a route needs an API key: its settings profile names a credential reference, or the adapter reports
   * environment variables its authentication reads. A route listed by neither, such as a local model server, is keyless.
   * @param provider - the route.
   * @returns true when the route needs a key.
   * @throws the lookup's failure, such as an unmounted settings service.
   */
  readonly needsKey: (provider: string) => boolean
  /**
   * Whether a route has a configured credential: its settings profile names a credential reference and the credentials
   * service describes that reference as configured. Reads no value, and runs before the route's listing is tried.
   * @param provider - the route.
   * @returns true when the route's credential is configured.
   * @throws the lookup's failure, such as a malformed reference.
   */
  readonly credentialConfigured: (provider: string) => Promise<boolean>
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
  /** Route ids the test leaves out of its answer, from the row's `hiddenProviders`. */
  readonly hidden: readonly string[]
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
  // INVALID_RESPONSE is a success status with a body that is not a model list, such as a captive portal's page: the key was not tested.
  if (code === 'INVALID_RESPONSE') return 'untested'
  if (code === 'HTTP_401' || code === 'HTTP_403') return 'rejected'
  if (code === 'TRANSPORT' || code === 'TIMEOUT' || code === 'ABORTED') return 'unreachable'
  if (code === 'MISSING_CREDENTIAL') return 'no-key'
  return 'failed'
}

/**
 * Test one route. A route that needs a key and has no configured credential is `no-key` before any discovery runs, since a discovery can
 * answer for a route that holds no key, such as a catalog's installed models, or refuse a protocol before it reads the
 * key. The official DeepSeek route is decided by its own listing, which reports `no-key` while no key is configured.
 * @param deps - the harness's parts.
 * @param provider - the route.
 * @returns the result.
 */
async function testRoute(deps: KeyTestDeps, provider: string): Promise<KeyResult> {
  const signal = AbortSignal.timeout(deps.timeoutMs)
  if (provider !== DEEPSEEK_ROUTE && deps.needsKey(provider) && !(await deps.credentialConfigured(provider))) return 'no-key'
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
 * Test every usable route that is not hidden, at most {@link MAX_PROVIDERS}, all at once.
 * @param deps - the harness's parts.
 * @returns each route with its name and result.
 */
export async function testKeys(deps: KeyTestDeps): Promise<KeyTestAnswer> {
  const routes = deps.providers().filter(route => !deps.hidden.includes(route.id)).slice(0, MAX_PROVIDERS)
  const results = await Promise.all(routes.map(route => testRoute(deps, route.id).catch((): KeyResult => 'failed')))
  return { hidden: [...deps.hidden], providers: routes.map((route, index) => ({ provider: route.id, name: route.name, result: results[index] as KeyResult })) }
}
