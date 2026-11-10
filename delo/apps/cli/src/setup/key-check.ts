/**
 * The live check of a typed model key: one authenticated model-listing request to the provider's origin, through
 * upstream's own listing client. The key goes in the request header to that origin only; redirects fail, so it
 * cannot follow one elsewhere. The reason a check fails never contains the key.
 *
 * @module @delo/cli/setup/key-check
 */
import { CliError, EXIT } from '../exit.ts'

/** The outcome of one key check. */
export type KeyCheckResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string }

/**
 * Checks a key with one request.
 * @param key - the key to check.
 * @returns whether the provider accepted it, and if not, why.
 */
export type KeyCheck = (key: string) => Promise<KeyCheckResult>

/** The most time the one request may take. */
const CHECK_TIMEOUT_MS = 15_000

/**
 * @param error - what the listing request threw.
 * @returns the error's `code`, as text.
 */
function codeOf(error: unknown): string {
  return String(Reflect.get(Object(error), 'code'))
}

/**
 * The reason line for a failed request, from the listing client's error code only, so the key and the response body
 * stay out of it.
 * @param code - the client's error code.
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
 * The key check of a terminal run: the model listing of the DeepSeek API, or of the origin `DEEPSEEK_BASE_URL`
 * names, as the provider plugin resolves its endpoint.
 * @param env - the environment `delorun` inherited.
 * @param timeoutMs - the most time the one request may take.
 * @returns the check; it throws a {@link CliError} when `DEEPSEEK_BASE_URL` is not a URL.
 */
export function liveKeyCheck(env: Readonly<Record<string, string | undefined>>, timeoutMs: number = CHECK_TIMEOUT_MS): KeyCheck {
  return async (key) => {
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
}
