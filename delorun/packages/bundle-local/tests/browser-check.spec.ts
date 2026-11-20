/**
 * The Settings Browser page's Host half: the test that opens a fixed page and answers a thumbnail, and the download of
 * the Chromium build. The kit and the program are stand-ins; no real browser starts. Each denial test's comment names
 * the check whose removal makes it fail.
 */
import { describe, expect, it, vi } from 'vitest'
import {
  answerBrowserCheck, installBrowser, registerBrowserCheck, INSTALL_SECONDS, runNode, TEST_PAGE, TEST_PROGRAM, TEST_SECONDS, testBrowser,
  type BrowserKit, type FindKit, type RunProgram,
} from '../src/browser-check.ts'
import { runBrowserInstall, runBrowserTest, type BrowserInstallAnswer, type BrowserTestAnswer } from '../src/client/browser-check-api.ts'

const KIT: BrowserKit = { core: '/pack/playwright-core', cli: '/pack/mcp/cli.js', launch: 'chromium', executable: '', installed: true }
const found = (change: Partial<BrowserKit> = {}): FindKit => () => Promise.resolve({ kind: 'kit', kit: { ...KIT, ...change } })
const PNG = 'data:image/png;base64,iVBORw0KGgo='
const printing = (stdout: string, status: number | null = 0, stderr = ''): RunProgram => () => Promise.resolve({ status, stdout, stderr })
const ENV = { PATH: '/bin' }
const loopback = (host: string | undefined): boolean => host === '127.0.0.1:19101'

describe('testBrowser', () => {
  it('opens the fixed page in the pack\'s browser and answers its thumbnail', async () => {
    const run = vi.fn<RunProgram>(() => Promise.resolve({ status: 0, stdout: JSON.stringify({ title: 'Delorun browser test', image: PNG }), stderr: '' }))
    expect(await testBrowser(found(), run, ENV)).toEqual({ ok: true, image: PNG, title: 'Delorun browser test' })
    expect(run).toHaveBeenCalledWith(['--input-type=module', '-e', TEST_PROGRAM, '/pack/playwright-core', 'chromium', '', TEST_PAGE], ENV, TEST_SECONDS)
  })

  // The page carries no script and no link, so the test cannot reach the network or run page code.
  it('opens a page with no script and no link', () => {
    expect(TEST_PAGE).not.toMatch(/<script|href=|src=|http/iu)
  })

  it('passes Chrome and an executable the row names to the program', async () => {
    const run = vi.fn<RunProgram>(printing(JSON.stringify({ title: '', image: PNG })))
    await testBrowser(found({ launch: 'chrome', executable: '/opt/chrome' }), run, ENV)
    expect(run.mock.calls[0]?.[0].slice(3, 6)).toEqual(['/pack/playwright-core', 'chrome', '/opt/chrome'])
  })

  it('says so when Browser is not added', async () => {
    expect(await testBrowser(() => Promise.resolve({ kind: 'not-added' }), printing(''), ENV)).toMatchObject({ ok: false, reason: 'not-added' })
  })

  it('says why the pack could not be read', async () => {
    expect(await testBrowser(() => Promise.resolve({ kind: 'unreadable', message: 'no declaration' }), printing(''), ENV)).toEqual({ ok: false, reason: 'unreadable', message: 'no declaration' })
  })

  // Starting a browser that is not downloaded would only fail slowly; the page offers the download instead.
  it('runs nothing while the build is not downloaded', async () => {
    const run = vi.fn<RunProgram>(printing(''))
    expect(await testBrowser(found({ installed: false }), run, ENV)).toMatchObject({ ok: false, reason: 'not-installed' })
    expect(run).not.toHaveBeenCalled()
  })

  it('reports the program\'s last error line', async () => {
    expect(await testBrowser(found(), printing('', 1, 'noise\nbrowserType.launch: Executable doesn\'t exist\n'), ENV)).toEqual({ ok: false, reason: 'failed', message: 'browserType.launch: Executable doesn\'t exist' })
    expect(await testBrowser(found(), printing('', 1, ''), ENV)).toMatchObject({ ok: false, message: 'The browser stopped without saying why.' })
  })

  it('reports a test that ran out of time', async () => {
    expect(await testBrowser(found(), printing('', null), ENV)).toEqual({ ok: false, reason: 'failed', message: `The browser did not answer within ${String(TEST_SECONDS)} seconds.` })
  })

  // A program whose output is not a PNG thumbnail must never reach the page as an image address.
  it.each([
    ['not JSON', 'oops'],
    ['an image that is not a PNG', JSON.stringify({ title: 't', image: 'data:text/html;base64,AAAA' })],
    ['no image', JSON.stringify({ title: 't' })],
    ['a thumbnail over the size limit', JSON.stringify({ title: 't', image: `data:image/png;base64,${'A'.repeat(700_000)}` })],
  ])('refuses %s', async (_name, stdout) => {
    expect(await testBrowser(found(), printing(stdout), ENV)).toEqual({ ok: false, reason: 'failed', message: 'The browser opened the page but returned no picture.' })
  })

  it('keeps an empty title when the program sends none', async () => {
    expect(await testBrowser(found(), printing(JSON.stringify({ image: PNG })), ENV)).toEqual({ ok: true, image: PNG, title: '' })
  })
})

describe('installBrowser', () => {
  it('runs the pack\'s own installer for the Chromium build', async () => {
    const run = vi.fn<RunProgram>(printing(''))
    expect(await installBrowser(found(), run, ENV)).toEqual({ ok: true })
    expect(run).toHaveBeenCalledWith(['/pack/mcp/cli.js', 'install-browser', 'chromium'], ENV, INSTALL_SECONDS)
  })

  // The installer would fetch a build that nothing launches when Chrome or an executable is the browser.
  it.each([[{ launch: 'chrome' as const }], [{ executable: '/opt/chrome' }]])('downloads nothing when the row launches its own browser %o', async (change) => {
    const run = vi.fn<RunProgram>(printing(''))
    expect(await installBrowser(found(change), run, ENV)).toMatchObject({ ok: false, reason: 'failed' })
    expect(run).not.toHaveBeenCalled()
  })

  it('reports the installer\'s last error line, a timeout, and a missing or unreadable pack', async () => {
    expect(await installBrowser(found(), printing('', 1, 'download failed: offline\n'), ENV)).toEqual({ ok: false, reason: 'failed', message: 'download failed: offline' })
    expect(await installBrowser(found(), printing('', null), ENV)).toEqual({ ok: false, reason: 'failed', message: 'The download did not finish within 15 minutes.' })
    expect(await installBrowser(() => Promise.resolve({ kind: 'not-added' }), printing(''), ENV)).toMatchObject({ reason: 'not-added' })
    expect(await installBrowser(() => Promise.resolve({ kind: 'unreadable', message: 'bad' }), printing(''), ENV)).toEqual({ ok: false, reason: 'unreadable', message: 'bad' })
  })
})

describe('answerBrowserCheck', () => {
  const request = (host: string): Request => new Request('http://dsh.internal/api/delorunBrowser.test', { method: 'POST', headers: { host } })

  it('answers the computer\'s own studio', async () => {
    const answered = await answerBrowserCheck(request('127.0.0.1:19101'), loopback, () => Promise.resolve({ ok: true }))
    expect(answered.status).toBe(200)
    expect(answered.headers.get('cache-control')).toBe('no-store')
    expect(await answered.json()).toEqual({ ok: true })
  })

  // Starting a browser costs the computer's resources and belongs to the person at it; without the Host check a remote name would run it.
  it('refuses a request whose Host is not a loopback name, before running anything', async () => {
    const action = vi.fn<() => Promise<BrowserTestAnswer>>()
    const refused = await answerBrowserCheck(request('studio.example.com'), loopback, action)
    expect(refused.status).toBe(403)
    expect(await refused.json()).toMatchObject({ ok: false, reason: 'at-computer' })
    expect(action).not.toHaveBeenCalled()
  })
})

describe('registerBrowserCheck', () => {
  interface Route { readonly path: string, readonly admitPeer?: unknown, readonly fetch: (request: Request) => Promise<Response> }
  const register = (run: RunProgram): Route[] => {
    const routes: Route[] = []
    const scope = { connection: { fetch: { register: (route: Route) => { routes.push(route) } } } }
    registerBrowserCheck(scope as never, found(), { run, env: () => ENV, loopback })
    return routes
  }
  const post = (path: string): Request => new Request(`http://dsh.internal${path}`, { method: 'POST', headers: { host: '127.0.0.1:19101' } })

  // A paired device reaches a route only through admitPeer; the rows in home-auth class both routes as the computer only.
  it('registers both routes without admitPeer', () => {
    const routes = register(printing(''))
    expect(routes.map(route => route.path)).toEqual(['/api/delorunBrowser.test', '/api/delorunBrowser.install'])
    for (const route of routes) expect(route.admitPeer).toBeUndefined()
  })

  // Each Test starts a Chromium for up to a minute; sharing the run in flight stops a double click from stacking browsers.
  it.each([['/api/delorunBrowser.test'], ['/api/delorunBrowser.install']])('runs %s once for two concurrent calls, and again after it ends', async (path) => {
    const gate: { finish: (() => void) | undefined } = { finish: undefined }
    const run = vi.fn<RunProgram>(() => new Promise((resolve) => { gate.finish = () => { resolve({ status: 0, stdout: '', stderr: '' }) } }))
    const release = (): void => { gate.finish?.() }
    const route = register(run).find(each => each.path === path)!
    const first = route.fetch(post(path))
    const second = route.fetch(post(path))
    await vi.waitFor(() => { expect(gate.finish).toBeDefined() })
    expect(run).toHaveBeenCalledTimes(1)
    release()
    await Promise.all([first, second])
    gate.finish = undefined
    const third = route.fetch(post(path))
    await vi.waitFor(() => { expect(gate.finish).toBeDefined() })
    release()
    await third
    expect(run).toHaveBeenCalledTimes(2)
  })
})

describe('the studio\'s readers', () => {
  const answering = (body: unknown) => () => Promise.resolve(Response.json(body))

  it('reads a thumbnail and a refusal', async () => {
    expect(await runBrowserTest(answering({ ok: true, image: PNG, title: 'x' }))).toEqual({ ok: true, image: PNG, title: 'x' })
    expect(await runBrowserTest(answering({ ok: false, reason: 'not-installed', message: 'm' }))).toEqual({ ok: false, reason: 'not-installed', message: 'm' })
    expect(await runBrowserInstall(answering({ ok: true }))).toEqual({ ok: true })
    expect(await runBrowserInstall(answering({ ok: false, reason: 'failed', message: 'offline' }))).toEqual({ ok: false, reason: 'failed', message: 'offline' })
  })

  // The studio draws the image address in an <img>: anything but a PNG data address of the allowed size is refused here.
  it.each([
    ['a script address', { ok: true, image: 'javascript:alert(1)', title: '' }],
    ['a remote address', { ok: true, image: 'https://example.com/a.png', title: '' }],
    ['an html data address', { ok: true, image: 'data:text/html;base64,AAAA', title: '' }],
    ['an oversize picture', { ok: true, image: `data:image/png;base64,${'A'.repeat(700_000)}`, title: '' }],
    ['no image', { ok: true }],
    ['an unknown reason', { ok: false, reason: 'weird', message: 'm' }],
    ['no object', 7],
  ])('does not draw %s', async (_name, body) => {
    expect(await runBrowserTest(answering(body))).toEqual({ ok: false, reason: 'failed', message: 'Delorun could not reach this computer to run the test.' })
  })

  it('says the Host could not be reached', async () => {
    const down = (): Promise<Response> => Promise.reject(new Error('refused'))
    const expectedTest: BrowserTestAnswer = { ok: false, reason: 'failed', message: 'Delorun could not reach this computer to run the test.' }
    const expectedInstall: BrowserInstallAnswer = { ok: false, reason: 'failed', message: 'Delorun could not reach this computer to start the download.' }
    expect(await runBrowserTest(down)).toEqual(expectedTest)
    expect(await runBrowserInstall(down)).toEqual(expectedInstall)
    expect(await runBrowserInstall(answering(3))).toEqual(expectedInstall)
  })
})

describe('runNode', () => {
  it('collects a program\'s output and status', async () => {
    expect(await runNode(['-e', 'console.log("out"); console.error("err"); process.exit(3)'], process.env, 30)).toEqual({ status: 3, stdout: 'out\n', stderr: 'err\n' })
  })

  it('stops a program that runs past its time and reports no status', async () => {
    expect((await runNode(['-e', 'setTimeout(() => {}, 60000)'], process.env, 0.2)).status).toBeNull()
  })
})
