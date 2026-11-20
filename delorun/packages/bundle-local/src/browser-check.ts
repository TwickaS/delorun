/**
 * The Host half of the Settings Browser page: `POST /api/delorunBrowser.test` opens a fixed page in the built-in browser
 * and answers a thumbnail, and `POST /api/delorunBrowser.install` downloads the browser build the built-in browser
 * needs. Neither starts a model turn, and neither reads a page from the network: the test's page is a constant in this
 * module, set into a browser the Host starts with a fresh profile, and the download runs the installer of the
 * Playwright MCP package already in the Browser pack, never a package from a registry.
 *
 * Only the computer's own studio may ask: the routes admit no paired device and also refuse a request whose `Host`
 * is not a loopback name. Both programs run with the environment every harness child starts from
 * (`scrubbedParentEnv`, which drops credentials such as model provider keys). A test is stopped after
 * {@link TEST_SECONDS} seconds and a download after {@link INSTALL_SECONDS} seconds. One download runs at a time: a
 * second request waits for the one running and gets its answer.
 *
 * @module @delorun/bundle-local/browser-check
 */
import { spawn } from 'node:child_process'
import type { Context } from '@deepseek-ai/cordis'
// Type-only: the ctx.connection service.
import type {} from '@deepseek-ai/dsh-client-connection'
import { BROWSER_INSTALL_ROUTE, BROWSER_TEST_ROUTE, MAX_THUMBNAIL_CHARACTERS, type BrowserInstallAnswer, type BrowserTestAnswer } from './client/browser-check-api.ts'

/** How long a test may run before it is stopped, in seconds. */
export const TEST_SECONDS = 60

/** How long a download may run before it is stopped, in seconds. */
export const INSTALL_SECONDS = 900

/** The most bytes of a program's output the Host keeps; the answer needs its last line only. */
const MAX_OUTPUT = 64 * 1024

/** The fixed page the test opens: no script, no request, no link. */
export const TEST_PAGE = '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Delorun browser test</title><style>body{margin:0;display:grid;place-items:center;height:100vh;background:#f4f1ea;color:#1d1b16;font:600 28px/1.3 system-ui,sans-serif;text-align:center}small{display:block;margin-top:8px;font:400 16px system-ui,sans-serif;color:#5a564c}</style></head><body><main>Browser works<small>This page was opened by Delorun on this computer.</small></main></body></html>' // us-spelling: quoted output

/**
 * The program the test runs under Node, as an ES module: it loads the Browser pack's `playwright-core`, starts the
 * browser headless in a fresh profile, sets {@link TEST_PAGE} and prints one JSON line with the title and a PNG of the
 * page as base64. The arguments are the `playwright-core` folder, `chrome` or `chromium`, an executable path or an
 * empty string, and the page.
 */
export const TEST_PROGRAM = `
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'
const [core, launch, executable, page] = process.argv.slice(1)
const loaded = await import(pathToFileURL(join(core, 'index.js')).href)
const { chromium } = loaded.chromium === undefined ? loaded.default : loaded
const browser = await chromium.launch({ headless: true, ...(executable === '' && launch === 'chrome' ? { channel: 'chrome' } : {}), ...(executable === '' ? {} : { executablePath: executable }) })
try {
  const tab = await browser.newPage({ viewport: { width: 640, height: 400 } })
  await tab.setContent(page)
  const title = await tab.title()
  const png = await tab.screenshot({ type: 'png' })
  process.stdout.write(JSON.stringify({ title, image: 'data:image/png;base64,' + png.toString('base64') }))
} finally {
  await browser.close()
}
`

/** What a run needs to know about the built-in browser. */
export interface BrowserKit {
  /** The `playwright-core` folder of the Playwright MCP package in the pack. */
  readonly core: string
  /** The Playwright MCP package's `cli.js`, whose `install-browser` command downloads a build. */
  readonly cli: string
  /** Which browser the provider launches. */
  readonly launch: 'chrome' | 'chromium'
  /** The executable the row names for its launch, or an empty string. */
  readonly executable: string
  /** Whether the Chromium build is downloaded, which only a `chromium` launch without an executable needs. */
  readonly installed: boolean
}

/** What looking for the kit found. */
export type KitSearch =
  | { readonly kind: 'kit'; readonly kit: BrowserKit }
  | { readonly kind: 'not-added' }
  | { readonly kind: 'unreadable'; readonly message: string }

/** Finds the kit; a spec supplies another. */
export type FindKit = () => Promise<KitSearch>

/** Runs a program to its end; a spec supplies another. */
export type RunProgram = (argv: readonly string[], env: Readonly<Record<string, string | undefined>>, seconds: number) => Promise<{ readonly status: number | null; readonly stdout: string; readonly stderr: string }>

/**
 * Run a program under Node and collect its output, stopping it when the time is up.
 * @param argv - the arguments after the Node executable.
 * @param env - the child's environment.
 * @param seconds - the time limit.
 * @returns the exit status (null when it was stopped) and the end of each stream.
 */
export const runNode: RunProgram = (argv, env, seconds) => new Promise((resolve) => {
  let stdout = ''
  let stderr = ''
  const child = spawn(process.execPath, [...argv], { env: { ...env }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, signal: AbortSignal.timeout(seconds * 1000) })
  child.stdout.setEncoding('utf8').on('data', (text: string) => { stdout = (stdout + text).slice(-MAX_OUTPUT * 10) })
  child.stderr.setEncoding('utf8').on('data', (text: string) => { stderr = (stderr + text).slice(-MAX_OUTPUT) })
  // A timeout aborts the signal: the child is killed, which reports as an error with no status.
  child.on('error', () => { resolve({ status: null, stdout, stderr }) })
  child.on('close', (status) => { resolve({ status, stdout, stderr }) })
})

/**
 * The last line of a program's error output, for the sentence a person reads.
 * @param stderr - the end of the stream.
 * @returns the line, or a fixed sentence for a program that said nothing.
 */
function lastLine(stderr: string): string {
  const line = stderr.trim().split('\n').at(-1)?.trim() ?? ''
  return line === '' ? 'The browser stopped without saying why.' : line.slice(0, 300)
}

/**
 * Open the fixed page in the built-in browser and take its thumbnail.
 * @param find - finds the kit.
 * @param run - runs the program.
 * @param env - the scrubbed environment of a harness child.
 * @returns the thumbnail, or why none was made; it never rejects.
 */
export async function testBrowser(find: FindKit, run: RunProgram, env: Readonly<Record<string, string | undefined>>): Promise<BrowserTestAnswer> {
  const search = await find()
  if (search.kind === 'not-added') return { ok: false, reason: 'not-added', message: 'Browser is not added to this home yet.' }
  if (search.kind === 'unreadable') return { ok: false, reason: 'unreadable', message: search.message }
  const { kit } = search
  if (!kit.installed) return { ok: false, reason: 'not-installed', message: 'The browser build is not downloaded yet.' }
  const result = await run(['--input-type=module', '-e', TEST_PROGRAM, kit.core, kit.launch, kit.executable, TEST_PAGE], env, TEST_SECONDS)
  if (result.status !== 0) {
    return { ok: false, reason: 'failed', message: result.status === null ? `The browser did not answer within ${String(TEST_SECONDS)} seconds.` : lastLine(result.stderr) }
  }
  try {
    const parsed = JSON.parse(result.stdout.trim().split('\n').at(-1) ?? '') as { title?: unknown; image?: unknown }
    if (typeof parsed.image !== 'string' || !parsed.image.startsWith('data:image/png;base64,') || parsed.image.length > MAX_THUMBNAIL_CHARACTERS) throw new Error('no thumbnail')
    return { ok: true, image: parsed.image, title: typeof parsed.title === 'string' ? parsed.title : '' }
  } catch (_unreadable) {
    // The program's output is read only for the thumbnail; anything else is a failed test with a fixed sentence.
    return { ok: false, reason: 'failed', message: 'The browser opened the page but returned no picture.' }
  }
}

/**
 * Download the Chromium build with the Playwright MCP package's own installer.
 * @param find - finds the kit.
 * @param run - runs the program.
 * @param env - the scrubbed environment of a harness child.
 * @returns done, or why it did not finish; it never rejects.
 */
export async function installBrowser(find: FindKit, run: RunProgram, env: Readonly<Record<string, string | undefined>>): Promise<BrowserInstallAnswer> {
  const search = await find()
  if (search.kind === 'not-added') return { ok: false, reason: 'not-added', message: 'Browser is not added to this home yet.' }
  if (search.kind === 'unreadable') return { ok: false, reason: 'unreadable', message: search.message }
  const { kit } = search
  // Chrome, or an executable the row names, is not a download: the installer would fetch a build nothing launches.
  if (kit.launch === 'chrome' || kit.executable !== '') return { ok: false, reason: 'failed', message: 'This computer launches its own Chrome, so there is no download to make.' }
  const result = await run([kit.cli, 'install-browser', 'chromium'], env, INSTALL_SECONDS)
  if (result.status === 0) return { ok: true }
  return { ok: false, reason: 'failed', message: result.status === null ? `The download did not finish within ${String(INSTALL_SECONDS / 60)} minutes.` : lastLine(result.stderr) }
}

/**
 * Answer a request of one of the routes.
 * @param request - the request.
 * @param loopback - whether a `Host` header names this computer (`isLoopbackHost` of `@delorun/home-auth`).
 * @param action - what the route does.
 * @returns the JSON answer; a request that is not the computer's own is refused with `403`.
 */
export async function answerBrowserCheck(request: Request, loopback: (host: string | undefined) => boolean, action: () => Promise<BrowserTestAnswer | BrowserInstallAnswer>): Promise<Response> {
  const headers = { 'content-type': 'application/json', 'cache-control': 'no-store' }
  if (!loopback(request.headers.get('host') ?? undefined)) {
    const refused: BrowserInstallAnswer = { ok: false, reason: 'at-computer', message: 'Testing the browser needs you at your computer: open the studio on the home\'s own computer.' }
    return new Response(JSON.stringify(refused), { status: 403, headers })
  }
  return new Response(JSON.stringify(await action()), { status: 200, headers })
}

/** What the routes run with: the program runner, the environment a harness child starts from and the Host check. */
export interface BrowserCheckHost {
  /** Runs a program; a spec supplies a fake. */
  readonly run: RunProgram
  /** @returns the scrubbed environment of a harness child (`scrubbedParentEnv` of `@deepseek-ai/dsh-subprocess`). */
  readonly env: () => Readonly<Record<string, string | undefined>>
  /** Whether a `Host` header names this computer (`isLoopbackHost` of `@delorun/home-auth`). */
  readonly loopback: (host: string | undefined) => boolean
}

/**
 * Register the test and download routes.
 * @param scope - the scope that holds the Connection.
 * @param find - finds the kit.
 * @param host - what the routes run with.
 */
export function registerBrowserCheck(scope: Context, find: FindKit, host: BrowserCheckHost): void {
  let installing: Promise<BrowserInstallAnswer> | undefined
  const route = (path: string, action: () => Promise<BrowserTestAnswer | BrowserInstallAnswer>): void => {
    scope.connection.fetch.register({
      path, methods: ['POST'], requestBody: 'buffered',
      // Admits no paired device: only the owner's own studio reaches the route; `answerBrowserCheck` also refuses a non-loopback Host.
      fetch: request => answerBrowserCheck(request, host.loopback, action),
    })
  }
  route(BROWSER_TEST_ROUTE, () => testBrowser(find, host.run, host.env()))
  route(BROWSER_INSTALL_ROUTE, () => {
    installing ??= installBrowser(find, host.run, host.env()).finally(() => { installing = undefined })
    return installing
  })
}
