/**
 * Screenshots of the PIN lock screen and the PIN mode settings section, in the real studio, for design review. The
 * studio runs on this computer from a scratch home. The settings section is the studio's own, with `GET /auth/pin/mode`
 * answered by a Playwright stub per scenario. A page on the computer never shows the lock screen, so each lock screen
 * is the real component, built with Vite and mounted over the studio page with a fixed view: the studio's stylesheet,
 * theme, fonts and icons apply to it.
 *
 *   export DELORUN_HOME=<scratch home>   # an empty directory with mode 0700
 *   delorun setup --yes && delorun start --foreground
 *   node_modules/.bin/tsx delorun/packages/bundle-local/scripts/pin-screens.ts --out <directory>
 *
 * It writes `<scenario>-<width>-<scheme>.png` for widths 390 and 1280 in light and dark, with the page's reduced-motion
 * preference on so no screenshot catches the shake. Playwright comes from `@delorun/benchmarks`.
 * @module @delorun/bundle-local/scripts/pin-screens
 */
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { build } from 'vite'
import { PIN_COMPUTER_ROUTES } from '../src/client/pin-api.ts'

/** The slice of Playwright's API this script uses. */
interface Locator { click(): Promise<void>; waitFor(options?: { timeout?: number }): Promise<void>; first(): Locator }
interface Page {
  route(url: string, handler: (route: { fulfill(response: { status: number; contentType: string; body: string }): Promise<void> }) => Promise<void>): Promise<void>
  goto(url: string): Promise<unknown>
  evaluate<A>(fn: (arg: A) => unknown, arg: A): Promise<unknown>
  addScriptTag(options: { content: string }): Promise<unknown>
  addStyleTag(options: { content: string }): Promise<unknown>
  emulateMedia(options: { colorScheme: 'light' | 'dark'; reducedMotion: 'reduce' }): Promise<void>
  waitForTimeout(ms: number): Promise<void>
  getByRole(role: string, options?: { name?: string | RegExp }): Locator
  locator(selector: string): Locator
  screenshot(options: { path: string }): Promise<unknown>
  close(): Promise<void>
}
interface Context { newPage(): Promise<Page>; close(): Promise<void> }
interface Playwright { chromium: { launch(): Promise<{ newContext(options: object): Promise<Context>; close(): Promise<void> }> } }

const { values } = parseArgs({ options: { out: { type: 'string' } } })
if (values.out === undefined) throw new Error('usage: DELORUN_HOME=<scratch home> pin-screens.ts --out <directory>')
const out = values.out
await mkdir(out, { recursive: true })
const repository = fileURLToPath(new URL('../../../../', import.meta.url))
const here = fileURLToPath(new URL('.', import.meta.url))
const clientRequire = createRequire(join(repository, 'packages/client/ui-primitives/package.json'))

/** What the home answers `GET /auth/pin/mode` per settings scenario. */
const MODE = { enabled: true, kind: 'pin', idleMinutes: 15, lockWhenHidden: true, paused: false }
const SETTINGS: Record<string, { body: object; steps?: (page: Page) => Promise<void> }> = {
  'settings-on': { body: MODE },
  'settings-off': { body: { ...MODE, enabled: false, kind: undefined } },
  'settings-set-back': { body: { ...MODE, setBackWaiting: [{ ns: 'delorun-reach', field: '*' }, { ns: 'delorun-home-auth', field: '*' }] } },
  'settings-paused': { body: { ...MODE, paused: true } },
  'settings-change-pin': { body: MODE, steps: async page => { await page.getByRole('button', { name: 'Change PIN' }).click() } },
  'settings-confirm-off': { body: MODE, steps: async page => { await page.getByRole('button', { name: 'Turn off PIN mode' }).click() } },
}

const view = (outcome?: object, secret = 'pin', paused = false) => ({ phase: 'locked', secret, busy: false, outcome, paused })
/** The lock screen's views per scenario; `typed` is how many keys the script presses first. */
const LOCKS: Record<string, { view: object; typed?: number }> = {
  'lock-ask': { view: view() },
  'lock-typing': { view: view(), typed: 4 },
  'lock-passcode': { view: view(undefined, 'passcode') },
  'lock-wrong': { view: view({ kind: 'wrong', triesLeft: 3 }), typed: 6 },
  'lock-last-try': { view: view({ kind: 'wrong', triesLeft: 1 }), typed: 6 },
  'lock-removed': { view: view({ kind: 'removed' }) },
  'lock-paused': { view: view({ kind: 'paused' }, 'pin', true) },
  'lock-unreachable': { view: view({ kind: 'unreachable' }) },
  'lock-address': { view: view({ kind: 'address' }) },
  'lock-failed': { view: view({ kind: 'failed' }) },
}

/** Build the preview bundle with Vite.
 * @returns its script and stylesheet text. */
async function buildPreview(): Promise<{ script: string; style: string }> {
  const dist = await mkdtemp(join(tmpdir(), 'pin-lock-preview-'))
  await build({
    // The bundle imports React through the client packages' copy, which also holds react-dom.
    resolve: { alias: { 'react-dom': dirname(clientRequire.resolve('react-dom/package.json')), react: dirname(clientRequire.resolve('react/package.json')) } },
    root: here, logLevel: 'error', configFile: false, define: { 'process.env.NODE_ENV': '"production"' },
    build: { outDir: dist, emptyOutDir: true, cssCodeSplit: false, lib: { entry: join(here, 'pin-lock-preview.tsx'), formats: ['iife'], name: 'PinLockPreview', fileName: 'preview' } },
  })
  const files = await readdir(dist)
  const read = async (suffix: string): Promise<string> => readFile(join(dist, files.find(file => file.endsWith(suffix)) ?? ''), 'utf8')
  return { script: await read('.js'), style: await read('.css') }
}

const preview = await buildPreview()
const playwright = createRequire(new URL('../../../apps/benchmarks/package.json', import.meta.url))('playwright') as Playwright
const browser = await playwright.chromium.launch()
try {
  for (const width of [390, 1280]) {
    const mobile = width === 390
    const context = await browser.newContext({ viewport: { width, height: mobile ? 844 : 800 }, deviceScaleFactor: 1, locale: 'en-GB', isMobile: mobile, hasTouch: mobile })
    const printed = execFileSync(join(repository, 'node_modules/.bin/tsx'), [join(repository, 'delorun/apps/cli/src/bin.ts'), 'open', '--print'], { encoding: 'utf8', timeout: 120_000 })
    const link = new URL(printed.split('\n')[0]?.trim() ?? '')
    if (link.hostname !== '127.0.0.1' && link.hostname !== 'localhost') throw new Error(`the studio must run on this computer, not ${link.host}`)
    const signIn = await context.newPage()
    await signIn.goto(link.href)
    await signIn.waitForTimeout(3000)
    for (let step = 0; step < 8; step++) {
      const skip = signIn.getByRole('button', { name: /^(Skip for now|Continue)/u }).first()
      try { await skip.waitFor({ timeout: 2500 }) } catch (_noOnboarding: unknown) { break }
      await skip.click()
      await signIn.waitForTimeout(600)
    }
    await signIn.close()
    for (const scheme of ['light', 'dark'] as const) {
      for (const [name, scenario] of Object.entries(SETTINGS)) {
        const page = await context.newPage()
        await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' })
        await page.route(`${link.origin}${PIN_COMPUTER_ROUTES.mode}`, async route => { await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(scenario.body) }) })
        await page.goto(`${link.origin}/`)
        await page.waitForTimeout(2500)
        const later = page.getByRole('button', { name: 'Configure later' })
        try { await later.waitFor({ timeout: 1500 }); await later.click() } catch (_noKeyPrompt: unknown) { /* the home has a key */ }
        const settings = page.getByRole('button', { name: 'Settings' }).first()
        try { await settings.waitFor({ timeout: 4000 }) } catch (_sidebarFolded: unknown) { await page.getByRole('button', { name: /^(expand|open) sidebar$/iu }).first().click() }
        try { await settings.click({ timeout: 5000 }) } catch (error) { await page.screenshot({ path: join(out, 'failed.png') }); throw error }
        await page.getByRole('button', { name: 'PIN mode' }).first().click()
        await page.waitForTimeout(800)
        await scenario.steps?.(page)
        await page.waitForTimeout(400)
        await page.screenshot({ path: join(out, `${name}-${String(width)}-${scheme}.png`) })
        await page.close()
      }
      for (const [name, scenario] of Object.entries(LOCKS)) {
        const page = await context.newPage()
        await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' })
        await page.goto(`${link.origin}/`)
        await page.waitForTimeout(2500)
        await page.addStyleTag({ content: preview.style })
        await page.addScriptTag({ content: preview.script })
        await page.evaluate((shown) => { (globalThis as unknown as { mountPinLock(view: object): void }).mountPinLock(shown) }, scenario.view)
        await page.waitForTimeout(300)
        for (let key = 0; key < (scenario.typed ?? 0); key++) await page.getByRole('button', { name: String(2 + key) }).first().click()
        await page.waitForTimeout(300)
        await page.screenshot({ path: join(out, `${name}-${String(width)}-${scheme}.png`) })
        await page.close()
      }
    }
    await context.close()
  }
} finally {
  await browser.close()
}
