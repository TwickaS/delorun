/**
 * The Worker's routes: the sign-up form's POST, the form's site key, and the confirmation and unsubscribe links.
 * Anything else goes to the static assets.
 *
 * @module @delorun/website/worker/routes
 */
import { CONSENT_OUT_OF_DATE, CONSENT_TEXT_VERSION, FIELDS, SIGNUP_CONFIG_PATH, SUBSCRIBE_PATH, UNCONFIRMED_DAYS } from '../site/signup.ts'
import type { Env } from './env.ts'
import { sendConfirmation } from './mail.ts'
import { page } from './pages.ts'
import { confirm, listUnsent, purgeUnconfirmed, recordSignup, rotateTokens, unsubscribe, type LinkResult } from './store.ts'
import { hashToken, isTokenShape, newToken } from './tokens.ts'
import { verifyTurnstile } from './turnstile.ts'
import { parseSignup, type SignupProblem } from './validate.ts'

/** What the Worker needs from outside its bindings, so a spec can replace each. */
export interface Deps {
  readonly fetch: typeof fetch
  readonly now: () => Date
}

/** The real dependencies. */
export const LIVE: Deps = { fetch: (input, init) => fetch(input, init), now: () => new Date() }

/** Confirmation messages a sweep sends at most, below the per-request limits of the send binding. */
const SWEEP_LIMIT = 50

/** The answer to every accepted sign-up, whether or not the address was already known. */
function acceptedMessage(env: Env): string {
  return env.SEND_CONFIRMATION === 'on'
    ? 'Thanks. We have sent a message from Delorun with a link to confirm your address. Nothing is sent to you until you open it.'
    : 'Thanks. Your sign-up is saved. We will email you a link to confirm your address; nothing is sent to you until you open it.'
}

/** The message for each problem the form can have. */
const PROBLEMS: Record<SignupProblem, string> = {
  email: 'That does not look like an email address. Check it and try again.',
  name: 'That first name is too long. Shorten it or leave it empty.',
  consent: 'Tick the box to say you want Delorun release news.',
  version: CONSENT_OUT_OF_DATE,
}

/**
 * Answers a sign-up as JSON for the form's script or as a page for a plain form post.
 * @param request - the request.
 * @param status - the HTTP status.
 * @param message - the text to show.
 * @param code - `out_of_date` when the page shows older consent words; the message already tells the visitor to reload, and a script may read the code.
 * @returns the response.
 */
function answer(request: Request, status: number, message: string, code?: 'out_of_date'): Response {
  if ((request.headers.get('Accept') ?? '').includes('application/json')) {
    return Response.json({ ok: status === 200, message, ...code === undefined ? {} : { code } }, { status, headers: { 'Cache-Control': 'no-store' } })
  }
  return page(status, status === 200 ? 'Thank you' : 'Sign-up not saved', [message])
}

/**
 * Handles `POST /api/subscribe`.
 * @param request - the request.
 * @param env - the Worker's bindings.
 * @param deps - the clock and the fetch function.
 * @returns the response; an accepted sign-up gets one answer whether or not the address was already on file.
 */
export async function subscribe(request: Request, env: Env, deps: Deps): Promise<Response> {
  let form: FormData
  try {
    form = await request.formData()
  } catch (error) {
    // A body that is not a form is a malformed request, not a server fault.
    console.error('subscribe: unreadable body', error instanceof Error ? error.name : 'unknown')
    return answer(request, 400, 'The form could not be read. Reload the page and try again.')
  }
  const parsed = parseSignup(form, FIELDS, CONSENT_TEXT_VERSION)
  // An out-of-date page is refused before anything else runs: nothing is stored and no message is sent. The form shows `code: 'out_of_date'` as a reload prompt.
  if (!parsed.ok) return parsed.problem === 'version' ? answer(request, 409, PROBLEMS.version, 'out_of_date') : answer(request, 400, PROBLEMS[parsed.problem])

  const limited = await env.RATE_LIMIT.limit({ key: request.headers.get('CF-Connecting-IP') ?? 'unknown' })
  if (!limited.success) return answer(request, 429, 'Too many sign-ups from your connection. Wait a minute and try again.')

  const token = form.get(FIELDS.turnstile)
  const verdict = await verifyTurnstile(env.TURNSTILE_SECRET, typeof token === 'string' ? token : '', deps.fetch)
  if (verdict === 'unavailable') return answer(request, 503, 'The check that you are a person could not run. Try again in a few minutes.')
  if (verdict === 'failed') return answer(request, 400, 'The check that you are a person did not pass. Reload the page, make sure scripts are on and try again.')

  const confirmToken = newToken()
  const unsubscribeToken = newToken()
  const hashes = { confirm: await hashToken(confirmToken), unsubscribe: await hashToken(unsubscribeToken) }
  const now = deps.now().toISOString()
  try {
    const outcome = await recordSignup(env.DB, parsed.value, hashes, now)
    if (outcome.kind !== 'unchanged') {
      await sendConfirmation(env, parsed.value.email, parsed.value.firstName, { confirm: confirmToken, unsubscribe: unsubscribeToken }, hashes, linkOrigin(env, request), now)
    }
  } catch (error) {
    console.error('subscribe: storage failed', error instanceof Error ? error.name : 'unknown')
    return answer(request, 500, 'Your sign-up could not be saved. Try again later, or write to ' + env.SUPPORT_ADDRESS + '.')
  }
  return answer(request, 200, acceptedMessage(env))
}

/**
 * The origin that links in messages point at.
 * @param env - the Worker's settings.
 * @param request - the request, whose origin is the fallback.
 * @returns the origin without a trailing slash.
 */
function linkOrigin(env: Env, request: Request): string {
  return env.PUBLIC_ORIGIN ?? new URL(request.url).origin
}

/**
 * Reads a token from a link or a posted form.
 * @param request - the request.
 * @param url - the request's URL.
 * @returns the token, or null when none of the right shape is present.
 */
async function readToken(request: Request, url: URL): Promise<string | null> {
  let candidate = url.searchParams.get('token')
  if (request.method === 'POST') {
    try {
      const form = await request.clone().formData()
      const posted = form.get('token')
      if (typeof posted === 'string') candidate = posted
    } catch (error) {
      // One-click unsubscribe posts a form body without a token; the token then comes from the link.
      console.error('link: no form body', error instanceof Error ? error.name : 'unknown')
    }
  }
  return isTokenShape(candidate) ? candidate : null
}

/** The text for a confirmation result. */
const CONFIRM_PAGES: Record<LinkResult, { status: number; title: string; text: string }> = {
  done: { status: 200, title: 'You are signed up', text: 'Thank you. Your address is confirmed, and we will email you Delorun release news. Every message has a link to unsubscribe.' },
  already: { status: 200, title: 'You are signed up', text: 'This address is already confirmed. Nothing more to do.' },
  gone: { status: 410, title: 'You have unsubscribed', text: 'This address has unsubscribed since. To sign up again, use the form on delorun.com.' },
  unknown: { status: 404, title: 'This link does not work', text: 'The link is not one we issued, or the sign-up was deleted. Use the form on delorun.com to sign up again.' },
}

/**
 * Handles `/confirm`. A link opens a page with a button, and the button confirms, so a mail scanner that opens the link cannot confirm for the person.
 * @param request - the request.
 * @param env - the Worker's bindings.
 * @param deps - the clock.
 * @returns the response.
 */
export async function confirmRoute(request: Request, env: Env, deps: Deps): Promise<Response> {
  const token = await readToken(request, new URL(request.url))
  if (token === null) return page(400, 'This link does not work', ['The link is incomplete. Open it again from the message, or use the form on delorun.com.'])
  if (request.method === 'GET') {
    return page(200, 'Confirm your address', ['Press the button to say you want Delorun release news.'], { path: '/confirm', token, label: 'Confirm' })
  }
  const result = await confirm(env.DB, await hashToken(token), deps.now().toISOString())
  const text = CONFIRM_PAGES[result]
  return page(text.status, text.title, [text.text])
}

/**
 * Handles `/unsubscribe`: a link unsubscribes at once, and a POST does too, which is the one-click form that mail programs send.
 * @param request - the request.
 * @param env - the Worker's bindings.
 * @param deps - the clock.
 * @returns the response; repeating it changes nothing.
 */
export async function unsubscribeRoute(request: Request, env: Env, deps: Deps): Promise<Response> {
  const token = await readToken(request, new URL(request.url))
  if (token === null) return page(400, 'This link does not work', ['The link is incomplete. Write to ' + env.SUPPORT_ADDRESS + ' and we will remove your address.'])
  const result = await unsubscribe(env.DB, await hashToken(token), deps.now().toISOString())
  if (result === 'unknown') return page(404, 'This link does not work', ['The link is not one we issued, or the address was deleted. If you still get messages from us, write to ' + env.SUPPORT_ADDRESS + '.'])
  return page(200, 'You have unsubscribed', ['We will not email this address about Delorun again. To have it deleted, write to ' + env.SUPPORT_ADDRESS + '.'])
}

/**
 * Routes a request.
 * @param request - the request.
 * @param env - the Worker's bindings.
 * @param deps - the clock and the fetch function.
 * @returns the response.
 */
export async function route(request: Request, env: Env, deps: Deps = LIVE): Promise<Response> {
  const { pathname } = new URL(request.url)
  const method = request.method
  if (pathname === SUBSCRIBE_PATH) {
    return method === 'POST' ? subscribe(request, env, deps) : methodNotAllowed('POST')
  }
  if (pathname === SIGNUP_CONFIG_PATH) {
    return method === 'GET' ? Response.json({ siteKey: env.TURNSTILE_SITEKEY }, { headers: { 'Cache-Control': 'no-store' } }) : methodNotAllowed('GET')
  }
  if (pathname === '/confirm') {
    return method === 'GET' || method === 'POST' ? confirmRoute(request, env, deps) : methodNotAllowed('GET, POST')
  }
  if (pathname === '/unsubscribe') {
    return method === 'GET' || method === 'POST' ? unsubscribeRoute(request, env, deps) : methodNotAllowed('GET, POST')
  }
  return env.ASSETS.fetch(request)
}

/**
 * Answers a method a route does not take.
 * @param allow - the methods it takes.
 * @returns the 405 response.
 */
function methodNotAllowed(allow: string): Response {
  return new Response('Method not allowed', { status: 405, headers: { Allow: allow } })
}

/**
 * The daily job: deletes sign-ups nobody confirmed within {@link UNCONFIRMED_DAYS} days and, when sending is on,
 * sends the confirmation to pending records that have none. Their sent tokens are not kept, so each gets new ones.
 * @param env - the Worker's bindings.
 * @param deps - the clock.
 * @returns how many records were deleted and how many confirmations were sent.
 */
export async function sweep(env: Env, deps: Deps = LIVE): Promise<{ deleted: number; sent: number }> {
  const now = deps.now().toISOString()
  const deleted = await purgeUnconfirmed(env.DB, UNCONFIRMED_DAYS, now)
  let sent = 0
  if (env.SEND_CONFIRMATION === 'on' && env.PUBLIC_ORIGIN !== undefined) {
    for (const row of await listUnsent(env.DB, SWEEP_LIMIT)) {
      const tokens = { confirm: newToken(), unsubscribe: newToken() }
      const hashes = { confirm: await hashToken(tokens.confirm), unsubscribe: await hashToken(tokens.unsubscribe) }
      if (!await rotateTokens(env.DB, row.id, hashes, now)) continue
      if (await sendConfirmation(env, row.email, row.firstName, tokens, hashes, env.PUBLIC_ORIGIN, now)) sent += 1
    }
  }
  return { deleted, sent }
}
