/**
 * What the journey asks of a running studio from inside its container, with the container's own Node, as the person's
 * browser asks it: the start-token exchange for the signed cookie, then the studio's own `/api` calls with that cookie.
 * Like a browser, it keeps the cookie (in `~/.journey-browser/cookie`) and uses it again after a restart, which the
 * cookie survives; when it holds none, or the studio refuses it, it exchanges the newest address the person's browser
 * was handed (`~/.journey-browser/opened`, which the journey's stand-in browser writes). It prints one JSON line.
 *
 * `node probe.mjs <action> [arguments]`, where action is:
 *
 * - `index`: a fresh exchange, then the index's status with the cookie and without it;
 * - `exchange <address>`: the status the start-token exchange of one printed address answers;
 * - `rows`: every Loader row of the running Host (`pluginInventory/list`);
 * - `chat <directory> <text> <expected reply>`: a new chat in the directory, one prompt, and the wait until the chat's
 *   history holds an assistant reply with the expected text; prints the chat's id;
 * - `page <chat id>`: the chat's history as the studio reads it;
 * - `trash <chat id>`: the studio's "Move to trash" for one chat.
 */
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const [action, ...rest] = process.argv.slice(2)
const BROWSER = join(homedir(), '.journey-browser')
const COOKIE = join(BROWSER, 'cookie')
const OPENED = join(BROWSER, 'opened')

/** The newest address the person's browser was handed. */
function opened() {
  const lines = existsSync(OPENED) ? readFileSync(OPENED, 'utf8').trim().split('\n').filter(line => line !== '') : []
  if (lines.length === 0) throw new Error('the person\'s browser was handed no studio address')
  return new URL(lines.at(-1))
}

/** The studio's origin, from the newest address the browser was handed. */
function studio() {
  return opened().origin
}

/**
 * Exchange an address's start token for the studio's cookie, as the browser does when it opens the address.
 * @param address - the address with its token.
 * @returns the `Cookie` header value.
 */
async function exchange(address) {
  const answer = await fetch(address, { redirect: 'manual' })
  if (answer.status !== 303) throw new Error(`the start-token exchange answered ${answer.status}, not 303`)
  const cookie = (answer.headers.get('set-cookie') ?? '').split(';')[0]
  if (cookie === '') throw new Error('the start-token exchange set no cookie')
  mkdirSync(BROWSER, { recursive: true })
  writeFileSync(COOKIE, cookie)
  return cookie
}

/**
 * The cookie the browser holds when the studio still accepts it, or a new one from the newest address it was handed.
 * @returns the `Cookie` header value.
 */
async function login() {
  if (existsSync(COOKIE)) {
    const cookie = readFileSync(COOKIE, 'utf8')
    if ((await fetch(`${studio()}/`, { headers: { cookie } })).status === 200) return cookie
  }
  return exchange(opened())
}

/**
 * Call one studio endpoint as the page does.
 * @param cookie - the cookie.
 * @param endpoint - such as `session/create`.
 * @param args - the method's arguments by parameter name, such as `{ request }`.
 * @returns the endpoint's value.
 */
async function call(cookie, endpoint, args) {
  const rpcId = randomUUID()
  const answer = await fetch(`${studio()}/api/${endpoint}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ type: 'client-request', rpcId, method: endpoint, payload: { args } }),
  })
  const text = await answer.text()
  if (!answer.ok) throw new Error(`${endpoint} answered ${answer.status}: ${text}`)
  const envelope = JSON.parse(text)
  if (envelope.result?.ok !== true) throw new Error(`${endpoint} failed: ${text}`)
  return envelope.result.value
}

/**
 * Post to one of the trash plugin's routes, as the studio's trash actions do.
 * @param cookie - the cookie.
 * @param path - the route.
 * @param body - the JSON body.
 * @returns the route's answer.
 */
async function route(cookie, path, body) {
  const answer = await fetch(`${studio()}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify(body) })
  const text = await answer.text()
  if (!answer.ok) throw new Error(`${path} answered ${answer.status}: ${text}`)
  return JSON.parse(text)
}

async function main() {
  switch (action) {
    case 'exchange':
      return { status: (await fetch(rest[0], { redirect: 'manual' })).status }
    case 'index': {
      const cookie = await exchange(opened())
      const withCookie = await fetch(`${studio()}/`, { headers: { cookie } })
      const html = await withCookie.text()
      const without = await fetch(`${studio()}/`)
      return { withCookie: withCookie.status, html: html.includes('<div id="root"></div>'), without: without.status }
    }
    case 'rows': {
      const cookie = await login()
      return call(cookie, 'pluginInventory/list', {})
    }
    case 'chat': {
      const [cwd, text, expected] = rest
      const cookie = await login()
      const { sessionId } = await call(cookie, 'session/create', { request: { cwd } })
      await call(cookie, 'session/prompt', { request: { requestId: randomUUID(), sessionId, mode: 'queue', content: [{ type: 'text', text }] } })
      const deadline = Date.now() + 120_000
      for (;;) {
        const page = await call(cookie, 'session/page', { request: { address: { kind: 'session', sessionId }, maxMessages: 20 } })
        const serialized = JSON.stringify(page)
        if (serialized.includes(expected ?? '') && /"assistant"/u.test(serialized)) return { sessionId, page }
        if (Date.now() > deadline) throw new Error(`the chat ${sessionId} has no assistant reply after 120 seconds: ${serialized.slice(0, 2000)}`)
        await new Promise(done => setTimeout(done, 500))
      }
    }
    case 'page': {
      const cookie = await login()
      return call(cookie, 'session/page', { request: { address: { kind: 'session', sessionId: rest[0] }, maxMessages: 20 } })
    }
    case 'trash': {
      const cookie = await login()
      return route(cookie, '/api/deloTrash.deleteChat', { sessionId: rest[0] })
    }
    default:
      throw new Error(`unknown action ${action}`)
  }
}

try {
  process.stdout.write(`${JSON.stringify({ ok: true, value: await main() })}\n`)
} catch (error) {
  process.stdout.write(`${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) })}\n`)
  process.exitCode = 1
}
