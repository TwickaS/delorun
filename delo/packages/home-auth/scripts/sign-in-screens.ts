/**
 * Screenshots of the reach sign-in page in each state it shows, for design review. It serves the page and its assets
 * through this package's own route handlers on a loopback port, with the Content Security Policy every reach response
 * carries, and answers the sign-in API from Playwright stubs, one scenario per state. No reach listener, Tailscale or
 * home process is involved, and the stubs never reach a real home: the device-key signature covers the page's origin,
 * which here is `http://127.0.0.1`, so a real home would refuse it.
 *
 *   node_modules/.bin/tsx delo/packages/home-auth/scripts/sign-in-screens.ts --out <directory> [--prefix after] [--only <scenario>] [--engine webkit]
 *
 * It writes `<prefix>-<scenario>-<width>-<scheme>[-zh][-webkit].png`: in Chromium, each scenario at 390 px in light
 * and dark, at 360 px in light, at desktop width (1280 px) in light and dark, and the main scenarios in Chinese; with
 * `--engine webkit`, each scenario at 390 px in light and dark. It exits 1 when the page logged an error or a policy
 * violation that the scenario does not expect. Playwright comes from `@delo/benchmarks`, which already depends on it.
 * @module @delo/home-auth/scripts/sign-in-screens
 */
import { once } from 'node:events'
import { mkdir } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { brandString } from '@deepseek-ai/dsh-brand'
import { reachContentSecurityPolicy } from '@deepseek-ai/dsh-client-connection'
import type { StudioAddress } from '@delo/contract-admission'
import { stampListener } from '@delo/home'
import { assetHandler, REACH_PATHS, signInPageHandler } from '../src/reach-routes.ts'
import { homeFixture } from '../tests/fixtures/home.ts'

/** The slice of Playwright's API this script uses. */
interface Route {
  fulfill(response: { status: number; contentType?: string; body?: string; headers?: Record<string, string> }): Promise<void>
  abort(code?: string): Promise<void>
  request(): { method(): string; url(): string }
}
interface Page {
  route(url: string | RegExp, handler: (route: Route) => Promise<void> | void): Promise<void>
  goto(url: string): Promise<unknown>
  emulateMedia(options: { colorScheme: 'light' | 'dark'; reducedMotion?: 'reduce' | 'no-preference' }): Promise<void>
  addInitScript(script: string): Promise<void>
  click(selector: string): Promise<void>
  fill(selector: string, value: string): Promise<void>
  waitForTimeout(ms: number): Promise<void>
  screenshot(options: { path: string; fullPage: boolean; caret: 'initial' }): Promise<unknown>
  on(event: 'console', handler: (message: { type(): string; text(): string }) => void): void
  on(event: 'pageerror', handler: (error: Error) => void): void
}
interface Context { newPage(): Promise<Page>; close(): Promise<void> }
interface Browser {
  newContext(options: { viewport: { width: number; height: number }; deviceScaleFactor: number; locale: string; isMobile?: boolean; hasTouch?: boolean }): Promise<Context>
  close(): Promise<void>
}
interface Playwright { chromium: { launch(): Promise<Browser> }; webkit: { launch(): Promise<Browser> } }

/** How the stubbed home answers each sign-in call in one scenario. */
interface Scenario {
  /** `POST /auth/device/challenge`: a trusted device, a new one, a held answer or a lost connection. */
  readonly challenge: 'trusted' | 'untrusted' | 'hold' | 'offline'
  /** `POST /auth/device/request`: accepted, or refused with a status and code. */
  readonly request?: { readonly status: number; readonly error?: string }
  /** `POST /auth/session`: held, so the "signing in" view stays on screen, or refused with a status and code. */
  readonly session?: { readonly status: number; readonly error: string }
  /** `GET /auth/device/request/<id>`: the states it answers, in order; the last repeats. */
  readonly states?: readonly string[]
  /** Whether the person asks for approval once the form shows. */
  readonly ask?: boolean
  /** Script run before the page, such as one that removes WebCrypto. */
  readonly init?: string
  /** Milliseconds to wait after the last step before the screenshot. */
  readonly settle?: number
  /** Shown also in Chinese. */
  readonly main?: boolean
}

/** Every state the page shows, by the scenario that reaches it. */
const SCENARIOS: Readonly<Record<string, Scenario>> = {
  checking: { challenge: 'hold' },
  'new-device': { challenge: 'untrusted', main: true },
  waiting: { challenge: 'untrusted', ask: true, states: ['pending'], settle: 3500, main: true },
  'waiting-reconnecting': { challenge: 'untrusted', ask: true, states: ['offline'], settle: 6000 },
  approved: { challenge: 'untrusted', ask: true, states: ['approved'], settle: 3500, main: true },
  declined: { challenge: 'untrusted', ask: true, states: ['cancelled'], settle: 3500 },
  expired: { challenge: 'untrusted', ask: true, states: ['expired'], settle: 3500 },
  closed: { challenge: 'untrusted', ask: true, request: { status: 403, error: 'APPROVALS_CLOSED' }, main: true },
  'rate-limited': { challenge: 'untrusted', ask: true, request: { status: 429, error: 'APPROVAL_RATE_LIMITED' } },
  busy: { challenge: 'untrusted', ask: true, request: { status: 429, error: 'APPROVAL_PENDING_LIMIT' } },
  'name-refused': { challenge: 'untrusted', ask: true, request: { status: 400, error: 'BAD_REQUEST' } },
  returning: { challenge: 'trusted' },
  sessions: { challenge: 'trusted', session: { status: 429, error: 'SESSION_LIMIT_REACHED' } },
  offline: { challenge: 'offline', main: true },
  unsupported: { challenge: 'untrusted', init: 'Object.defineProperty(globalThis.crypto, "subtle", { value: undefined })' },
}

/** Console text a scenario produces by design: the browser's own report of a stubbed lost connection. */
const EXPECTED_CONSOLE = /Failed to load resource/

const { values } = parseArgs({ options: { out: { type: 'string' }, prefix: { type: 'string', default: 'after' }, only: { type: 'string' }, engine: { type: 'string', default: 'chromium' } } })
if (values.engine !== 'chromium' && values.engine !== 'webkit') throw new Error('--engine is chromium or webkit')
if (values.out === undefined) throw new Error('name the output directory with --out')
const out = values.out
await mkdir(out, { recursive: true })

const home = await homeFixture()
const address = brandString<StudioAddress>('https://home.example.ts.net')
home.auth.serve({ listener: 'reach-tailscale-private', address, factor: 'tailnet-membership' })
const page = signInPageHandler(home.auth)
const assets = assetHandler(home.auth)
const server = createServer((request, response) => {
  const path = new URL(request.url ?? '/', 'http://fixture.invalid').pathname
  stampListener(request, 'reach-tailscale-private')
  response.setHeader('content-security-policy', reachContentSecurityPolicy('fixture-nonce'))
  if (path === REACH_PATHS.signIn) return void page(request, response)
  if (path.startsWith(`${REACH_PATHS.assets}/`)) return void assets(request, response)
  response.setHeader('content-type', 'text/html; charset=utf-8')
  response.end('<!doctype html><title>Studio</title><p>The studio opens here.</p>')
})
server.listen(0, '127.0.0.1')
await once(server, 'listening')
const origin = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`

const playwright = createRequire(new URL('../../../apps/benchmarks/package.json', import.meta.url))('playwright') as Playwright
const browser = await playwright[values.engine].launch()
const problems: string[] = []

/**
 * Answer the sign-in API as one scenario's home would.
 * @param target - the page.
 * @param scenario - the scenario.
 */
async function stub(target: Page, scenario: Scenario): Promise<void> {
  const json = (route: Route, status: number, value: unknown): Promise<void> => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) })
  let challenges = 0
  await target.route(`${origin}${REACH_PATHS.challenge}`, async (route) => {
    challenges += 1
    if (scenario.challenge === 'hold') return
    if (scenario.challenge === 'offline') return route.abort('internetdisconnected')
    // The second challenge comes after an approval, when the device is trusted.
    if (scenario.challenge === 'trusted' || challenges > 1) return json(route, 200, { challenge: 'Y2hhbGxlbmdlLWNoYWxsZW5nZS1jaGFsbGVuZ2UtY2g' })
    return json(route, 401, { error: 'DEVICE_NOT_TRUSTED', message: 'This device is not trusted for this address' })
  })
  // A held sign-in keeps the "signing in" state on screen instead of opening the studio.
  await target.route(`${origin}${REACH_PATHS.session}`, (route) => {
    if (scenario.session !== undefined) return json(route, scenario.session.status, { error: scenario.session.error, message: 'Refused by the stub' })
  })
  await target.route(`${origin}${REACH_PATHS.request}`, (route) => {
    const refusal = scenario.request
    if (refusal !== undefined) return json(route, refusal.status, { error: refusal.error, message: 'Refused by the stub' })
    return json(route, 201, { requestId: 'request-1', requestSecret: 'secret-1', homePublicKey: 'aG9tZS1wdWJsaWMta2V5', homeNonce: 'aG9tZS1ub25jZS0xMjM0NQ', expiresAt: Date.now() + 300_000 })
  })
  let reads = 0
  await target.route(new RegExp(`${REACH_PATHS.request}/request-1$`), (route) => {
    const states = scenario.states ?? ['pending']
    const state = states[Math.min(reads, states.length - 1)]
    reads += 1
    if (state === 'offline') return route.abort('internetdisconnected')
    return json(route, 200, { state })
  })
}

/**
 * Take one scenario's screenshot.
 * @param name - the scenario's name.
 * @param scenario - the scenario.
 * @param shot - the viewport, scheme and language.
 */
async function capture(name: string, scenario: Scenario, shot: { readonly width: number; readonly height: number; readonly scheme: 'light' | 'dark'; readonly zh: boolean }): Promise<void> {
  const mobile = shot.width < 600
  const context = await browser.newContext({ viewport: { width: shot.width, height: shot.height }, deviceScaleFactor: 2, locale: shot.zh ? 'zh-CN' : 'en-US', isMobile: mobile, hasTouch: mobile })
  const target = await context.newPage()
  const label = `${name} ${String(shot.width)} ${shot.scheme}${shot.zh ? ' zh' : ''}`
  // Playwright's WebKit screenshot injects an inline style of its own, which the policy refuses; what the page logs
  // from then on is not the page's.
  let shooting = false
  target.on('console', (message) => { if (!shooting && message.type() === 'error' && !EXPECTED_CONSOLE.test(message.text())) problems.push(`${label}: ${message.text()}`) })
  target.on('pageerror', (error) => { if (!shooting) problems.push(`${label}: ${error.message}`) })
  await target.addInitScript('document.addEventListener("securitypolicyviolation", (event) => console.error(`CSP violation: ${event.violatedDirective} ${event.blockedURI} at ${event.sourceFile}:${String(event.lineNumber)} ${event.sample}`))')
  if (scenario.init !== undefined) await target.addInitScript(scenario.init)
  await target.emulateMedia({ colorScheme: shot.scheme })
  await stub(target, scenario)
  await target.goto(`${origin}${REACH_PATHS.signIn}`)
  await target.waitForTimeout(600)
  if (scenario.ask === true) {
    await target.click('form button[type=submit]')
    await target.waitForTimeout(scenario.settle ?? 600)
  }
  const engine = values.engine === 'chromium' ? '' : `-${values.engine}`
  const file = `${values.prefix}-${name}-${String(shot.width)}-${shot.scheme}${shot.zh ? '-zh' : ''}${engine}.png`
  shooting = true
  await target.screenshot({ path: join(out, file), fullPage: true, caret: 'initial' })
  await context.close()
  console.log(file)
}

try {
  for (const [name, scenario] of Object.entries(SCENARIOS)) {
    if (values.only !== undefined && values.only !== name) continue
    for (const scheme of ['light', 'dark'] as const) await capture(name, scenario, { width: 390, height: 844, scheme, zh: false })
    if (values.engine !== 'chromium') continue
    await capture(name, scenario, { width: 360, height: 740, scheme: 'light', zh: false })
    for (const scheme of ['light', 'dark'] as const) await capture(name, scenario, { width: 1280, height: 800, scheme, zh: false })
    if (scenario.main === true) await capture(name, scenario, { width: 390, height: 844, scheme: 'light', zh: true })
  }
} finally {
  await browser.close()
  server.close()
  await home.dispose()
}
for (const problem of problems) console.error(problem)
process.exitCode = problems.length === 0 ? 0 : 1
