/**
 * Worker of the `playwright` adapter. Reads one JSON request from standard input (`{ "check": true }` or a
 * {@link RunSpec}), drives headless Chromium, and prints one JSON answer line. Not a command of its own.
 *
 * @module @delorun/tools/studio-browser/playwright-worker
 */
import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium, type Page } from 'playwright'
import type { RunSpec } from './adapter.ts'
import type { Step } from './steps.ts'

const DEFAULT_VIEWPORT = { width: 1440, height: 900 }

/** How long the page may stay busy before it counts as idle; a studio keeps a socket open, so idle is not guaranteed. */
const IDLE_MS = 8_000

/** Pause after idle so entrance animations finish before a screenshot. */
const SETTLE_MS = 600

const AsyncFunction = Object.getPrototypeOf(async () => undefined).constructor as new (...names: string[]) => (page: Page) => Promise<unknown>

/**
 * Wait until the page's network is quiet, or the idle limit passes.
 * @param page - the page.
 */
async function settle(page: Page): Promise<void> {
  await page.waitForLoadState('networkidle', { timeout: IDLE_MS }).catch(() => undefined)
  await page.waitForTimeout(SETTLE_MS)
}

/**
 * Run one step.
 * @param page - the page.
 * @param step - the step.
 * @param origin - the studio origin `goto` must stay on.
 */
async function runStep(page: Page, step: Step, origin: string): Promise<void> {
  if ('goto' in step) {
    const target = new URL(step.goto, `${origin}/`)
    if (target.origin !== origin) throw new Error(`goto ${step.goto} leaves the studio origin ${origin}`)
    await page.goto(target.href)
    await settle(page)
  } else if ('click' in step) {
    await page.click(step.click)
    await settle(page)
  } else if ('type' in step) {
    await page.fill(step.type.selector, step.type.text)
  } else if ('press' in step) {
    await page.keyboard.press(step.press)
  } else if ('waitFor' in step) {
    await page.waitForSelector(step.waitFor)
  } else if ('waitMs' in step) {
    await page.waitForTimeout(step.waitMs)
  } else {
    await page.screenshot({ path: step.screenshot })
  }
}

/**
 * Run a request.
 * @param spec - the run.
 * @returns the JSON answer.
 */
async function run(spec: RunSpec): Promise<{ ok: boolean, output: string, recording?: string }> {
  const browser = await chromium.launch()
  const videoDir = spec.recordTo === undefined ? undefined : await mkdtemp(join(tmpdir(), 'delorun-studio-video-'))
  try {
    const context = await browser.newContext({
      viewport: spec.viewport ?? DEFAULT_VIEWPORT,
      colorScheme: spec.scheme ?? 'light',
      ...(videoDir === undefined ? {} : { recordVideo: { dir: videoDir } }),
    })
    // The sign-in token is single-use and the browser holds no other session, so nothing off the studio's origin may load.
    await context.route('**/*', route => (new URL(route.request().url()).origin === spec.origin || route.request().url().startsWith('data:') ? route.continue() : route.abort()))
    context.setDefaultTimeout(spec.timeoutMs)
    const page = await context.newPage()
    await page.goto(`${spec.origin}/`)
    if (spec.startUrl !== `${spec.origin}/`) {
      // The sign-in route refuses a navigation whose fetch metadata says cross-site, so move inside the page.
      await page.evaluate(link => { location.href = link }, spec.startUrl)
      await page.waitForLoadState('load')
    }
    await settle(page)
    for (const step of spec.steps ?? []) await runStep(page, step, spec.origin)
    const returned = spec.code === undefined ? undefined : await new AsyncFunction('page', spec.code)(page)
    if (spec.screenshotTo !== undefined) await page.screenshot({ path: spec.screenshotTo })
    await context.close()
    let recording: string | undefined
    if (spec.recordTo !== undefined && videoDir !== undefined) {
      const [file] = await readdir(videoDir)
      if (file === undefined) throw new Error('the browser wrote no recording')
      await copyFile(join(videoDir, file), spec.recordTo)
      recording = spec.recordTo
    }
    return { ok: true, output: returned === undefined ? '' : JSON.stringify(returned), ...(recording === undefined ? {} : { recording }) }
  } finally {
    await browser.close()
    if (videoDir !== undefined) await rm(videoDir, { recursive: true, force: true })
  }
}

/**
 * Report that Chromium launches.
 * @returns the answer.
 */
async function check(): Promise<{ ok: boolean, output: string }> {
  const browser = await chromium.launch()
  const version = browser.version()
  await browser.close()
  return { ok: true, output: `Chromium ${version} (headless, Playwright)` }
}

const chunks: Buffer[] = []
for await (const chunk of process.stdin) chunks.push(chunk as Buffer)
const request = JSON.parse(Buffer.concat(chunks).toString('utf8')) as RunSpec | { check: true }
let answer: { ok: boolean, output: string, recording?: string }
try {
  answer = 'check' in request ? await check() : await run(request)
} catch (error) {
  const message = error instanceof Error ? error.message : String(error)
  answer = { ok: false, output: /Executable doesn't exist/.test(message) ? 'Chromium is not installed for Playwright; run: pnpm exec playwright install chromium' : message }
}
process.stdout.write(`\n${JSON.stringify(answer)}\n`)
