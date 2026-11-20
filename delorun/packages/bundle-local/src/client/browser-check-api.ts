/**
 * The requests the Settings Browser page sends to the Host: one test that opens a fixed page in the built-in browser
 * and answers a thumbnail, and one that downloads the browser build the built-in browser needs. Both answer only the
 * computer's own studio ([`../browser-check.ts`](../browser-check.ts)); neither starts a model turn.
 * @module @delorun/bundle-local/client/browser-check-api
 */
import type { HostFetch } from './host-api.ts'

/** The test route under `/api`: `POST` with no body answers a {@link BrowserTestAnswer}. */
export const BROWSER_TEST_ROUTE = '/api/delorunBrowser.test'

/** The download route under `/api`: `POST` with no body answers a {@link BrowserInstallAnswer} when the download ends. */
export const BROWSER_INSTALL_ROUTE = '/api/delorunBrowser.install'

/** The most bytes of the thumbnail the Host sends, as the PNG's base64 text. */
export const MAX_THUMBNAIL_CHARACTERS = 600_000

/** Why a test or a download did not run or did not finish. */
export type BrowserCheckRefusal =
  /** The request did not arrive on the computer's own studio. */
  | 'at-computer'
  /** The built-in browser is not in the profile, so there is nothing to run. */
  | 'not-added'
  /** The browser build is not downloaded. */
  | 'not-installed'
  /** The browser started and failed, or ran out of time; `message` is the program's own last line. */
  | 'failed'
  /** The profile's browser declaration could not be read. */
  | 'unreadable'

/** The answer of a test: the page's thumbnail, or why none was made. */
export type BrowserTestAnswer =
  | { readonly ok: true; readonly image: string; readonly title: string }
  | { readonly ok: false; readonly reason: BrowserCheckRefusal; readonly message: string }

/** The answer of a download: done, or why it did not finish. */
export type BrowserInstallAnswer =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: BrowserCheckRefusal; readonly message: string }

const REASONS: ReadonlySet<string> = new Set<BrowserCheckRefusal>(['at-computer', 'not-added', 'not-installed', 'failed', 'unreadable'])

/**
 * Read an answer, whatever the status: the Host answers a refusal with the same JSON fields.
 * @param value - the parsed body.
 * @returns the answer, or undefined for a body that is neither.
 */
function answerOf(value: unknown): BrowserInstallAnswer | undefined {
  if (typeof value !== 'object' || value === null || !('ok' in value)) return undefined
  if (value.ok === true) return { ok: true }
  if (value.ok !== false || !('reason' in value) || typeof value.reason !== 'string' || !REASONS.has(value.reason)) return undefined
  return { ok: false, reason: value.reason as BrowserCheckRefusal, message: 'message' in value && typeof value.message === 'string' ? value.message : '' }
}

/**
 * Run the test.
 * @param fetch - the request function.
 * @returns the answer; a Host that cannot be reached or that answers something else is a `failed` answer.
 */
export async function runBrowserTest(fetch: HostFetch): Promise<BrowserTestAnswer> {
  const unreadable: BrowserTestAnswer = { ok: false, reason: 'failed', message: 'Delorun could not reach this computer to run the test.' }
  let body: unknown
  try {
    body = await (await fetch(BROWSER_TEST_ROUTE, { method: 'POST', credentials: 'same-origin' })).json()
  } catch (_unreachable) {
    // A refused connection and an answer that is not JSON read the same here: the page says the test did not run.
    return unreadable
  }
  const answer = answerOf(body)
  if (answer === undefined) return unreadable
  if (!answer.ok) return answer
  const found = body as { image?: unknown; title?: unknown }
  const image = found.image
  if (typeof image !== 'string' || !/^data:image\/png;base64,[A-Za-z0-9+/=]+$/u.test(image) || image.length > MAX_THUMBNAIL_CHARACTERS) return unreadable
  return { ok: true, image, title: typeof found.title === 'string' ? found.title : '' }
}

/**
 * Download the browser build and wait for the Host to finish.
 * @param fetch - the request function.
 * @returns the answer; a Host that cannot be reached or that answers something else is a `failed` answer.
 */
export async function runBrowserInstall(fetch: HostFetch): Promise<BrowserInstallAnswer> {
  const unreadable: BrowserInstallAnswer = { ok: false, reason: 'failed', message: 'Delorun could not reach this computer to start the download.' }
  try {
    return answerOf(await (await fetch(BROWSER_INSTALL_ROUTE, { method: 'POST', credentials: 'same-origin' })).json()) ?? unreadable
  } catch (_unreachable) {
    // As for the test: an unreachable Host and a body that is not JSON both mean the download did not run.
    return unreadable
  }
}
