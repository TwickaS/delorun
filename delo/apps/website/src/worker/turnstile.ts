/**
 * Server-side verification of a Turnstile token with Siteverify.
 *
 * @module @delo/website/worker/turnstile
 */

/** Cloudflare's Siteverify endpoint. */
export const SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify'

/** Turnstile tokens are at most this long. */
const MAX_TOKEN_LENGTH = 2048

/** The outcome of a verification: `unavailable` means Siteverify could not be asked, which is not the visitor's fault. */
export type Verification = 'passed' | 'failed' | 'unavailable'

/**
 * Asks Siteverify whether a token came from a passed check. The visitor's address is not sent.
 * @param secret - the widget's secret.
 * @param token - the token the form carried; absent when the form was posted without the widget.
 * @param fetcher - the function that makes the request.
 * @returns the outcome.
 */
export async function verifyTurnstile(secret: string, token: string, fetcher: typeof fetch): Promise<Verification> {
  if (token.length === 0 || token.length > MAX_TOKEN_LENGTH) return 'failed'
  let response: Response
  try {
    response = await fetcher(SITEVERIFY_URL, { method: 'POST', body: new URLSearchParams({ secret, response: token }) })
  } catch (error) {
    // The request failed before any answer: report the service as unavailable instead of blaming the visitor.
    console.error('turnstile: siteverify request failed', error instanceof Error ? error.name : 'unknown')
    return 'unavailable'
  }
  if (!response.ok) return 'unavailable'
  let body: { success?: unknown }
  try {
    body = await response.json()
  } catch (error) {
    // A reply that is not JSON is not an answer to the question.
    console.error('turnstile: siteverify reply was not JSON', error instanceof Error ? error.name : 'unknown')
    return 'unavailable'
  }
  return body.success === true ? 'passed' : 'failed'
}
