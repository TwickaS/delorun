/**
 * The live check of a model key: one authenticated `GET` of a metadata endpoint at the provider's origin, never a
 * completion. DeepSeek's goes through upstream's own model-listing client; every other provider's is the request its
 * {@link KeyCheckSpec} names. The key goes in a request header to that origin only; redirects fail, so it cannot
 * follow one elsewhere. The reason a check fails never contains the key or the response body.
 *
 * @module @delorun/cli/setup/key-check
 */
import { CliError, EXIT } from '../exit.ts'
import type { KeyCheckKind, SetupProvider } from './providers.ts'

/** The outcome of one key check. */
export type KeyCheckResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string }

/** What a key is checked against. */
export interface KeyTarget {
  /** The provider. */
  readonly provider: SetupProvider
  /** The provider's base URL: the catalog's, or the one the person gave; `undefined` for DeepSeek, whose check reads `DEEPSEEK_BASE_URL`. */
  readonly baseURL: string | undefined
}

/**
 * Checks a key with one request.
 * @param target - the provider and its base URL.
 * @param key - the key to check.
 * @returns whether the provider accepted it, and if not, why.
 */
export type KeyCheck = (target: KeyTarget, key: string) => Promise<KeyCheckResult>

/** The most time the one request may take. */
const CHECK_TIMEOUT_MS = 15_000

/** The API version Anthropic's model listing requires. */
const ANTHROPIC_VERSION = '2023-06-01'

/**
 * @param error - what the listing request threw.
 * @returns the error's `code`, as text.
 */
function codeOf(error: unknown): string {
  return String(Reflect.get(Object(error), 'code'))
}

/**
 * The reason line for a failed request, from an error code only, so the key and the response body stay out of it.
 * @param code - `HTTP_<status>`, `ABORTED` or `TRANSPORT`.
 * @param origin - the provider's origin.
 * @param timeoutMs - the time the request was given.
 * @returns the reason.
 */
function reasonFor(code: string, origin: string, timeoutMs: number): string {
  if (code === 'HTTP_401' || code === 'HTTP_403') return `${origin} did not accept the key (${code.replace('HTTP_', 'HTTP ')}).`
  if (code === 'ABORTED') return `${origin} did not answer within ${String(timeoutMs / 1000)} seconds.`
  if (code === 'TRANSPORT') return `could not reach ${origin}.`
  return `${origin} could not check the key (${code.replace('HTTP_', 'HTTP ')}).`
}

/**
 * DeepSeek's check: the model listing of the DeepSeek API, or of the origin `DEEPSEEK_BASE_URL` names, as the
 * provider plugin resolves its endpoint.
 * @param env - the environment `delorun` inherited.
 * @param key - the key.
 * @param timeoutMs - the most time the request may take.
 * @returns the outcome.
 * @throws {CliError} `EXIT.failed` when `DEEPSEEK_BASE_URL` is not a URL.
 */
async function checkDeepSeekKey(env: Readonly<Record<string, string | undefined>>, key: string, timeoutMs: number): Promise<KeyCheckResult> {
  // Loaded here so a run that skips the check never loads the provider package.
  const { modelListingURL, requestModelListing, PUBLIC_BASE_URL } = await import('@deepseek-ai/dsh-llm-deepseek')
  const base = env['DEEPSEEK_BASE_URL'] !== undefined && env['DEEPSEEK_BASE_URL'] !== '' ? env['DEEPSEEK_BASE_URL'] : PUBLIC_BASE_URL
  let url: string
  try {
    url = modelListingURL(base)
  } catch {
    // `new URL` rejects a base that is not a URL; the variable is the person's, so the message names it.
    throw new CliError(EXIT.failed, 'delorun setup: DEEPSEEK_BASE_URL is not a URL, so the key cannot be checked; fix or unset it')
  }
  try {
    await requestModelListing(url, { 'x-api-key': key }, AbortSignal.timeout(timeoutMs))
    return { ok: true }
  } catch (error) {
    const code = codeOf(error)
    // The client reports INVALID_RESPONSE only for an answer with a success status, which means the key was accepted.
    if (code === 'INVALID_RESPONSE') return { ok: true }
    return { ok: false, reason: reasonFor(code, new URL(url).origin, timeoutMs) }
  }
}

/**
 * The request headers that carry a key, by check kind.
 * @param kind - the check's kind.
 * @param key - the key.
 * @returns the headers.
 */
function keyHeaders(kind: KeyCheckKind, key: string): Record<string, string> {
  switch (kind) {
    case 'deepseek': return { 'x-api-key': key }
    case 'anthropic': return { 'x-api-key': key, 'anthropic-version': ANTHROPIC_VERSION }
    case 'bearer': return { authorization: `Bearer ${key}` }
    case 'google': return { 'x-goog-api-key': key }
  }
}

/**
 * Another provider's check: one `GET` of the metadata endpoint its spec names, under its base URL. A success status
 * means the key was accepted; the body is not read.
 * @param target - the provider and its base URL.
 * @param key - the key.
 * @param timeoutMs - the most time the request may take.
 * @returns the outcome.
 * @throws {CliError} `EXIT.failed` when the base URL is not an `http` or `https` URL.
 */
async function checkEndpointKey(target: KeyTarget, key: string, timeoutMs: number): Promise<KeyCheckResult> {
  const { check, label } = target.provider
  let url: URL
  try {
    url = new URL(`${(target.baseURL ?? '').replace(/\/+$/u, '')}${check.path}`)
  } catch {
    throw new CliError(EXIT.failed, `delorun setup: the base URL of ${label} is not a URL, so the key cannot be checked`)
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new CliError(EXIT.failed, `delorun setup: the base URL of ${label} is not an http or https URL, so the key cannot be checked`)
  let response: Response
  try {
    response = await fetch(url.href, { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(timeoutMs), headers: { accept: 'application/json', ...keyHeaders(check.kind, key) } })
  } catch (error) {
    // AbortSignal.timeout rejects with a TimeoutError; every other failure, a refused redirect included, is the transport's.
    return { ok: false, reason: reasonFor(Reflect.get(Object(error), 'name') === 'TimeoutError' ? 'ABORTED' : 'TRANSPORT', url.origin, timeoutMs) }
  }
  // The body is never read, so it cannot reach a message; cancelling it releases the connection.
  await response.body?.cancel().catch(() => {
    // A body that cannot be cancelled is already closed; the status decides the outcome.
  })
  return response.ok ? { ok: true } : { ok: false, reason: reasonFor(`HTTP_${String(response.status)}`, url.origin, timeoutMs) }
}

/**
 * The key check of a terminal run, and of `--check-key`.
 * @param env - the environment `delorun` inherited.
 * @param timeoutMs - the most time the one request may take.
 * @returns the check; it throws a {@link CliError} when the provider's base URL is not a URL.
 */
export function liveKeyCheck(env: Readonly<Record<string, string | undefined>>, timeoutMs: number = CHECK_TIMEOUT_MS): KeyCheck {
  return (target, key) => (target.provider.check.kind === 'deepseek' ? checkDeepSeekKey(env, key, timeoutMs) : checkEndpointKey(target, key, timeoutMs))
}
