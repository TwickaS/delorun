/**
 * Screenshots of the remote studio's unlock in each state it shows, for design review. It drives a studio that runs on
 * this computer from a scratch home, signed in through a one-time `delorun open --print` link, and makes the page
 * believe it is an approved device: Playwright stubs answer the unlock routes (`/auth/elevation*`) and the Devices
 * section's routes, and answer one Remote call with the `remote-access/denied` failure the home's policy sends a device
 * for a sensitive action. No reach listener, Tailscale or device is involved, and no request reaches a model.
 *
 *   export DELO_HOME=<scratch home>   # an empty directory with mode 0700
 *   delorun setup --yes && delorun start
 *   node_modules/.bin/tsx delo/packages/bundle-local/scripts/unlock-screens.ts --out <directory> [--only <scenario>]
 *
 * It signs in with `delorun open --print` of the same home, once per width.
 *
 * It writes `<scenario>-390-<scheme>.png` for each scenario in light and dark, and `computer-*-1280-<scheme>.png` for the
 * computer's Devices section. It exits 1 when the page logged an error. Playwright comes from
 * `@delo/benchmarks`, which already depends on it.
 * @module @delo/bundle-local/scripts/unlock-screens
 */
import { execFileSync } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { DEVICE_ROUTES, ELEVATION_ROUTES } from '../src/client/devices-api.ts'

/** The slice of Playwright's API this script uses. */
interface Route {
  fulfill(response: { status: number; contentType?: string; body?: string }): Promise<void>
  abort(code?: string): Promise<void>
  request(): { method(): string; url(): string; postData(): string | null }
}
interface Locator {
  click(): Promise<void>
  fill(value: string): Promise<void>
  waitFor(options?: { state?: 'visible' | 'attached'; timeout?: number }): Promise<void>
  first(): Locator
  count(): Promise<number>
}
interface Page {
  route(url: string | RegExp, handler: (route: Route) => Promise<void> | void): Promise<void>
  unrouteAll(): Promise<void>
  goto(url: string): Promise<unknown>
  evaluate<T, A>(fn: (arg: A) => T, arg: A): Promise<T>
  emulateMedia(options: { colorScheme: 'light' | 'dark'; reducedMotion?: 'reduce' }): Promise<void>
  waitForTimeout(ms: number): Promise<void>
  waitForURL(url: RegExp, options?: { timeout?: number }): Promise<void>
  getByRole(role: string, options?: { name?: string | RegExp; exact?: boolean }): Locator
  getByText(text: string | RegExp, options?: { exact?: boolean }): Locator
  locator(selector: string): Locator
  screenshot(options: { path: string; fullPage: boolean; caret: 'initial' }): Promise<unknown>
  setViewportSize(size: { width: number; height: number }): Promise<void>
  close(): Promise<void>
  on(event: 'console', handler: (message: { type(): string; text(): string }) => void): void
  on(event: 'pageerror', handler: (error: Error) => void): void
}
interface BrowserContext { newPage(): Promise<Page>; close(): Promise<void> }
interface Browser {
  newContext(options: { viewport: { width: number; height: number }; deviceScaleFactor: number; locale: string; isMobile?: boolean; hasTouch?: boolean }): Promise<BrowserContext>
  close(): Promise<void>
}
interface Playwright { chromium: { launch(): Promise<Browser> } }

/** The composer, which shows once the studio's shell has loaded. */
const SHELL = 'textarea, [contenteditable="true"]'
const MINUTE = 60_000
const CODE = '48213907'
const DEVICE_ID = 'p'.repeat(43)
const ADDRESS = 'https://home.example.ts.net'

/** One answer of the stubbed home: a status and a JSON body, or a lost connection. */
type Stub = { readonly status: number; readonly body: unknown } | 'unreachable'

/** How the stubbed home answers in one scenario, and what the script does before the screenshot. */
interface Scenario {
  /** `GET /auth/elevation`, by the time the screenshot is taken. */
  readonly state: (now: number) => Stub
  /** `POST /auth/elevation/request`. */
  readonly request?: (now: number) => Stub
  /** `POST /auth/elevation/lock`. */
  readonly lock?: Stub
  /** `GET /auth/elevation/terminal`: whether the terminal switch is on; off unless named. */
  readonly terminal?: boolean
  /** Whether the page is the computer, which lists the requests of the devices. */
  readonly computer?: boolean
  /** The steps after the studio loaded. */
  readonly steps: (page: Page, stubs: Stubs) => Promise<void>
}

/** The stubs a scenario's steps change while they run. */
interface Stubs { state: Stub }

const none = (): Stub => ({ status: 200, body: { kind: 'none' } })
const pending = (now: number): Stub => ({ status: 201, body: { kind: 'pending', requestId: 'request-1', code: CODE, expiresAt: now + 5 * MINUTE } })
const elevated = (now: number): Stub => ({ status: 200, body: { kind: 'elevated', elevationId: 'elevation-1', endsAt: now + 15 * MINUTE } })

/** Open the sidebar where the narrow layout hides it behind the header's toggle. */
async function openSidebar(page: Page): Promise<void> {
  const toggle = page.locator('button[aria-label="Open sidebar"]:visible')
  if (await toggle.count() > 0) await toggle.first().click()
  await page.locator('button[aria-label="Settings"]:visible').first().waitFor()
}

/** Ask to add a workspace, which browses the computer's folders: the stub refuses it as the home's policy does a device. */
async function openDialog(page: Page): Promise<void> {
  await openSidebar(page)
  await page.locator('button[aria-label="Add workspace"]:visible').first().click()
  await page.getByRole('dialog', { name: 'Unlock sensitive actions' }).waitFor()
}

/** Open Settings, Devices. */
async function openDevices(page: Page): Promise<void> {
  await openSidebar(page)
  await page.locator('button[aria-label="Settings"]:visible').first().click()
  await page.getByRole('button', { name: 'Devices' }).first().click()
  await page.getByText(/^(Sensitive actions|Unlock requests)$/u).first().waitFor()
}

const SCENARIOS: Record<string, Scenario> = {
  'dialog-refused': {
    state: none,
    steps: async (page) => { await openDialog(page) },
  },
  'dialog-pending': {
    state: none,
    request: pending,
    steps: async (page, stubs) => {
      await openDialog(page)
      stubs.state = pending(Date.now())
      await page.getByRole('button', { name: 'Unlock', exact: true }).click()
      await page.getByText(`${CODE.slice(0, 4)} ${CODE.slice(4)}`).waitFor()
    },
  },
  'dialog-expired': {
    state: none,
    request: now => ({ status: 201, body: { kind: 'pending', requestId: 'request-1', code: CODE, expiresAt: now + 3_000 } }),
    steps: async (page, stubs) => {
      await openDialog(page)
      stubs.state = { status: 201, body: { kind: 'pending', requestId: 'request-1', code: CODE, expiresAt: Date.now() + 3_000 } }
      await page.getByRole('button', { name: 'Unlock', exact: true }).click()
      await page.getByText(`${CODE.slice(0, 4)} ${CODE.slice(4)}`).waitFor()
      // The home forgets a request once it expires; before then, `none` would read as declined.
      await page.waitForTimeout(3_500)
      stubs.state = none()
      await page.getByText('expired', { exact: false }).waitFor({ timeout: 10_000 })
    },
  },
  'dialog-unreachable': {
    state: none,
    request: () => 'unreachable',
    steps: async (page) => {
      await openDialog(page)
      await page.getByRole('button', { name: 'Unlock', exact: true }).click()
      await page.getByRole('button', { name: 'Try again' }).waitFor()
    },
  },
  'dialog-declined': {
    state: none,
    request: pending,
    steps: async (page, stubs) => {
      await openDialog(page)
      stubs.state = pending(Date.now())
      await page.getByRole('button', { name: 'Unlock', exact: true }).click()
      await page.getByText(`${CODE.slice(0, 4)} ${CODE.slice(4)}`).waitFor()
      stubs.state = none()
      await page.getByRole('button', { name: 'Try again' }).waitFor({ timeout: 10_000 })
    },
  },
  'dialog-limit': {
    state: none,
    request: () => ({ status: 429, body: { error: 'APPROVAL_PENDING_LIMIT', message: 'Too many requests wait at the computer.' } }),
    steps: async (page) => {
      await openDialog(page)
      await page.getByRole('button', { name: 'Unlock', exact: true }).click()
      await page.getByRole('button', { name: 'Try again' }).waitFor()
    },
  },
  'banner-unlocked': {
    state: elevated,
    steps: async (page) => { await page.getByRole('button', { name: 'Lock now' }).waitFor() },
  },
  'banner-lock-failed': {
    state: elevated,
    lock: 'unreachable',
    steps: async (page) => {
      await page.getByRole('button', { name: 'Lock now' }).click()
      await page.getByText('Could not lock. Try again.').waitFor()
    },
  },
  'locked-again': {
    state: elevated,
    lock: { status: 200, body: { kind: 'none' } },
    steps: async (page) => {
      await page.getByRole('button', { name: 'Lock now' }).click()
      await page.getByText('Sensitive actions are locked again', { exact: false }).waitFor()
    },
  },
  'devices-locked': {
    state: none,
    steps: async (page) => { await openDevices(page); await page.getByRole('button', { name: 'Unlock', exact: true }).waitFor() },
  },
  'devices-unlocked': {
    state: elevated,
    steps: async (page) => { await openDevices(page); await page.getByText(/Unlocked until/u).first().waitFor() },
  },
  'devices-terminal-refused': {
    state: none,
    steps: async (page) => {
      await openDevices(page)
      await page.getByRole('switch', { name: 'Terminal from phone without unlock' }).click()
      await page.locator('[data-terminal-switch] [role="alert"]').waitFor()
    },
  },
  'devices-terminal-on': {
    state: none,
    terminal: true,
    steps: async (page) => { await openDevices(page); await page.locator('[data-terminal-switch="on"]').waitFor() },
  },
  'computer-terminal-on': {
    state: () => ({ status: 421, body: { error: 'HOST_MISMATCH', message: 'This address is not a device address.' } }),
    terminal: true,
    computer: true,
    steps: async (page) => { await openDevices(page); await page.locator('[data-terminal-switch="on"]').waitFor() },
  },
  'computer-requests': {
    state: () => ({ status: 421, body: { error: 'HOST_MISMATCH', message: 'This address is not a device address.' } }),
    computer: true,
    steps: async (page) => { await openDevices(page); await page.getByRole('button', { name: 'Approve' }).first().waitFor() },
  },
}

const { values } = parseArgs({ options: { out: { type: 'string' }, only: { type: 'string' } } })
if (values.out === undefined) throw new Error('usage: DELO_HOME=<scratch home> unlock-screens.ts --out <directory> [--only <scenario>]')
const out = values.out
await mkdir(out, { recursive: true })
const names = values.only === undefined ? Object.keys(SCENARIOS) : [values.only]
const repository = fileURLToPath(new URL('../../../../', import.meta.url))

/**
 * A one-time sign-in link of the studio the scratch home runs, from `delorun open --print`.
 * @returns the link, on this computer.
 */
function signInLink(): URL {
  const printed = execFileSync(join(repository, 'node_modules/.bin/tsx'), [join(repository, 'delo/apps/cli/src/bin.ts'), 'open', '--print'], { encoding: 'utf8', timeout: 120_000 })
  const link = new URL(printed.split('\n')[0]?.trim() ?? '')
  if (link.hostname !== '127.0.0.1' && link.hostname !== 'localhost') throw new Error(`the studio must run on this computer, not ${link.host}`)
  return link
}

/**
 * Answer one stubbed route.
 * @param route - the intercepted request.
 * @param stub - the answer.
 */
async function answer(route: Route, stub: Stub): Promise<void> {
  if (stub === 'unreachable') return route.abort('internetdisconnected')
  await route.fulfill({ status: stub.status, contentType: 'application/json', body: JSON.stringify(stub.body) })
}

/**
 * Install the stubs of one scenario on a page.
 * @param page - the page.
 * @param origin - the studio's origin.
 * @param scenario - the scenario.
 * @returns the stubs its steps change.
 */
async function stub(page: Page, origin: string, scenario: Scenario): Promise<Stubs> {
  const stubs: Stubs = { state: scenario.state(Date.now()) }
  const now = Date.now()
  await page.route(`${origin}${ELEVATION_ROUTES.state}`, route => answer(route, stubs.state))
  await page.route(`${origin}${ELEVATION_ROUTES.request}`, route => answer(route, scenario.request?.(Date.now()) ?? pending(Date.now())))
  await page.route(`${origin}${ELEVATION_ROUTES.lock}`, route => answer(route, scenario.lock ?? none()))
  // The home turns the switch on only at the computer, and lets any studio turn it off.
  await page.route(`${origin}${ELEVATION_ROUTES.terminal}`, route => answer(route, route.request().method() === 'GET'
    ? { status: 200, body: { withoutUnlock: scenario.terminal === true } }
    : JSON.parse(route.request().postData() ?? '{}').withoutUnlock === true && scenario.computer !== true
      ? { status: 403, body: { error: 'LOOPBACK_REQUIRED', message: 'Only the computer turns this on.' } }
      : { status: 200, body: { withoutUnlock: JSON.parse(route.request().postData() ?? '{}').withoutUnlock === true } }))
  await page.route(`${origin}${ELEVATION_ROUTES.pending}`, route => answer(route, {
    status: 200,
    body: {
      pending: [{ requestId: 'request-1', deviceId: DEVICE_ID, requestedAt: now - 20_000, expiresAt: now + 4 * MINUTE }],
      running: [{ id: 'elevation-2', deviceId: 'q'.repeat(43), startedAt: now - 3 * MINUTE, endsAt: now + 12 * MINUTE }],
    },
  }))
  await page.route(`${origin}${DEVICE_ROUTES.reachStatus}`, route => answer(route, {
    status: 200, body: { available: true, options: [{ option: 'tailscale-private', state: 'ready', address: ADDRESS }] },
  }))
  await page.route(`${origin}${DEVICE_ROUTES.devices}`, route => answer(route, scenario.computer === true
    ? {
        status: 200,
        body: {
          owner: { claimedAt: now - 30 * 86_400_000, firstDeviceId: DEVICE_ID },
          devices: [
            { id: DEVICE_ID, label: 'Pixel 9', platform: 'Android', address: ADDRESS, approvedAt: now - 30 * 86_400_000, approvedBy: 'local', lastSignInAt: now - 60_000 },
            { id: 'q'.repeat(43), label: 'iPad', platform: 'iPadOS', address: ADDRESS, approvedAt: now - 9 * 86_400_000, approvedBy: 'local', lastSignInAt: now - 3 * MINUTE },
          ],
        },
      }
    : { status: 403, body: { error: 'LOOPBACK_REQUIRED', message: 'Devices are managed at the computer.' } }))
  // The home's policy refuses a sensitive action from a device with `remote-access/denied` and the reason.
  await page.route(/\/api\/directoryPicker\/[A-Za-z]+$/u, async (route) => {
    const sent = JSON.parse(route.request().postData() ?? '{}') as { rpcId?: string }
    const action = new URL(route.request().url()).pathname.replace(/^.*\/api\//u, '')
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        type: 'server-response',
        rpcId: sent.rpcId,
        result: { ok: false, error: { code: 'remote-access/denied', message: `remote access: ${action}: access denied`, details: { action, reason: `elevation-required: ${action}` } } },
      }),
    })
  })
  return stubs
}

/**
 * Step through a fresh home's onboarding with its defaults, until the studio's shell shows.
 * @param page - the signed-in page.
 */
async function finishOnboarding(page: Page): Promise<void> {
  for (let step = 0; step < 8; step++) {
    if (await page.locator(SHELL).count() > 0) return
    const next = page.getByRole('button', { name: /^(Continue|Next|Skip|Finish|Done|Get started|Start)/u }).first()
    try {
      await next.waitFor({ timeout: 10_000 })
    } catch (_shellShown: unknown) {
      // No onboarding button: the shell is about to show.
      return
    }
    await next.click()
    await page.waitForTimeout(500)
  }
}

/**
 * Wait for the studio's shell, keeping a screenshot of the page when it does not show.
 * @param page - the page.
 * @param failed - where the screenshot of a page that did not load goes.
 */
async function studioReady(page: Page, failed: string): Promise<void> {
  try {
    await page.locator(SHELL).first().waitFor({ timeout: 30_000 })
  } catch (error) {
    await page.screenshot({ path: failed, fullPage: false, caret: 'initial' })
    throw error
  }
  // A scratch home without a model key asks for one over the shell; the screenshots do not need a model.
  const later = page.getByRole('button', { name: 'Configure later' })
  try {
    await later.waitFor({ timeout: 3_000 })
  } catch (_noKeyPrompt: unknown) {
    // The home has a key, so no prompt shows.
    return
  }
  await later.click()
}

const playwright = createRequire(new URL('../../../apps/benchmarks/package.json', import.meta.url))('playwright') as Playwright
const browser = await playwright.chromium.launch()
const errors: string[] = []
try {
  for (const width of [390, 1280]) {
    const chosen = names.filter(name => (SCENARIOS[name]?.computer === true) === (width === 1280))
    if (chosen.length === 0) continue
    const mobile = width === 390
    const context = await browser.newContext({ viewport: { width, height: mobile ? 844 : 800 }, deviceScaleFactor: 2, locale: 'en-US', isMobile: mobile, hasTouch: mobile })
    // One sign-in per context: the link works once, and the session cookie serves every later page.
    const link = signInLink()
    const signIn = await context.newPage()
    await signIn.goto(`${link.origin}/`)
    await signIn.evaluate((target) => { location.href = target }, link.href)
    await finishOnboarding(signIn)
    await studioReady(signIn, join(out, 'sign-in-failed.png'))
    await signIn.close()
    for (const name of chosen) {
      const scenario = SCENARIOS[name]
      if (scenario === undefined) throw new Error(`no scenario ${name}; the scenarios are ${Object.keys(SCENARIOS).join(', ')}`)
      for (const scheme of ['light', 'dark'] as const) {
        const page = await context.newPage()
        page.on('pageerror', (error) => { errors.push(`${name}: ${error.message}`) })
        await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' })
        const stubs = await stub(page, link.origin, scenario)
        await page.goto(`${link.origin}/`)
        await studioReady(page, join(out, `${name}-failed.png`))
        try {
          await scenario.steps(page, stubs)
        } catch (error) {
          await page.screenshot({ path: join(out, `${name}-${String(width)}-${scheme}-failed.png`), fullPage: false, caret: 'initial' })
          throw error
        }
        await page.waitForTimeout(400)
        const path = join(out, `${name}-${String(width)}-${scheme}.png`)
        await page.screenshot({ path, fullPage: false, caret: 'initial' })
        console.log(path)
        await page.close()
      }
    }
    await context.close()
  }
} finally {
  await browser.close()
}
if (errors.length > 0) {
  console.error(errors.join('\n'))
  process.exitCode = 1
}
