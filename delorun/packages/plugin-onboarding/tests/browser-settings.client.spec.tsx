// @vitest-environment jsdom
/**
 * The Settings Browser page: the switch, the built-in browser's status in plain words with the action that fixes it, the
 * test that shows a thumbnail, the download, and where the own-Chrome pack stands. Each denial test's comment names the
 * check whose removal makes it fail.
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BROWSER_BUNDLE, REAL_BROWSER_BUNDLE, type BrowserReadiness } from '@delorun/browser-setup'
import type { BundleState } from '../src/client/bundles.ts'
import { BrowserSettings, type BrowserSettingsInjected } from '../src/client/browser/BrowserSettings.tsx'
import { en } from '../src/client/locales.ts'
import { browserFake, installerFake, t } from './fixtures.client.ts'

afterEach(cleanup)

const click = async (element: HTMLElement) => { await act(async () => { fireEvent.click(element) }) }
const settle = async () => { await act(async () => { await Promise.resolve(); await Promise.resolve() }) }

const DOWNLOAD: BrowserReadiness = { kind: 'needs-setup', reason: 'Needs the Chromium download', fix: { kind: 'command', command: 'npx -y @playwright/mcp@0.0.1 install-browser chromium' } }
const OTHER: BrowserReadiness = { kind: 'needs-setup', reason: 'Needs Google Chrome installed', fix: { kind: 'command', command: 'npx -y @playwright/mcp@0.0.1 install-browser chrome' } }

interface Options {
  readonly browser?: ReturnType<typeof browserFake>
  readonly pack?: BundleState
  readonly own?: BundleState
  readonly packMore?: object
  readonly remote?: boolean
  readonly recorded?: 'on' | 'off'
  /** Whether setup is unfinished; a spec's home is new unless it says otherwise. */
  readonly fresh?: boolean
  /** What the pack was last seen as while off. */
  readonly seen?: 'enabled' | 'disabled'
}

/** Render the page over faked services. */
async function show(options: Options = {}) {
  const browser = options.browser ?? browserFake({ kind: 'ready' })
  if (options.recorded !== undefined) browser.recorded.set(options.recorded)
  if (options.fresh !== undefined) browser.fresh.set(options.fresh)
  if (options.seen !== undefined) browser.packSeen.set(options.seen)
  const bundles = installerFake({
    [BROWSER_BUNDLE]: { state: options.pack ?? 'installed', ...options.packMore },
    [REAL_BROWSER_BUNDLE]: { state: options.own ?? 'available' },
  })
  const openPlugins = vi.fn()
  const injected: BrowserSettingsInjected = { services: { bundles: bundles.installer, browser: browser.face, remote: options.remote ?? false }, openPlugins }
  render(<BrowserSettings t={t} {...injected} />)
  await settle()
  return { browser, bundles, openPlugins }
}

const switchControl = (): HTMLButtonElement => screen.getByRole('switch', { name: en['page.switch.title'] }) as HTMLButtonElement

describe('the switch', () => {
  it('is on for a home that never chose, and says Browser is ready', async () => {
    await show()
    expect(switchControl().getAttribute('aria-checked')).toBe('true')
    expect(screen.getByText(en['page.status.ready'])).toBeTruthy()
  })

  // The first chat asks once to allow the browser tool; Settings does not allow it for the person.
  it('says agents ask once before first use while on, and nothing while off', async () => {
    await show()
    expect(screen.getByText(en['page.asks'])).toBeTruthy()
    cleanup()
    await show({ recorded: 'off', pack: 'available' })
    expect(screen.queryByText(en['page.asks'])).toBeNull()
  })

  it('records off and turns the pack off when switched off', async () => {
    const { browser } = await show()
    await click(switchControl())
    await settle()
    expect(browser.turnOff).toHaveBeenCalledTimes(1)
    expect(browser.record).toHaveBeenCalledExactlyOnceWith('off')
    expect(switchControl().getAttribute('aria-checked')).toBe('false')
    expect(screen.getByText(en['page.status.off'])).toBeTruthy()
  })

  it('shows off for a home that chose off, with no test to run', async () => {
    const { bundles } = await show({ pack: 'available', recorded: 'off' })
    expect(switchControl().getAttribute('aria-checked')).toBe('false')
    expect(screen.getByText(en['page.status.off'])).toBeTruthy()
    expect(screen.queryByRole('button', { name: en['page.test'] })).toBeNull()
    // Pins "a home that chose off stays off": opening the page must not add the pack.
    expect(bundles.install).not.toHaveBeenCalled()
  })

  it('records on when switched on, and the pack is then added', async () => {
    const { browser, bundles } = await show({ pack: 'available', recorded: 'off' })
    await click(switchControl())
    await settle()
    expect(browser.record).toHaveBeenCalledExactlyOnceWith('on')
    expect(bundles.install).toHaveBeenCalledExactlyOnceWith(BROWSER_BUNDLE)
  })

  // Pins "turning Browser off then on brings it back": a pack turned off in Plugins is held, and only the installer switches it on.
  it('switches a held pack back on through the installer when switched on after off', async () => {
    const { browser, bundles } = await show({ pack: 'available', packMore: { held: true }, recorded: 'off' })
    expect(switchControl().getAttribute('aria-checked')).toBe('false')
    await click(switchControl())
    await settle()
    expect(browser.record).toHaveBeenCalledWith('on')
    expect(bundles.install).toHaveBeenCalledExactlyOnceWith(BROWSER_BUNDLE)
    expect(switchControl().getAttribute('aria-checked')).toBe('true')
  })

  // Pins the fresh-home check: a new home that never chose adds the pack once, and records on so a later removal is read.
  it('adds the pack in a new home that never chose, and records on', async () => {
    const { browser, bundles } = await show({ pack: 'available', fresh: true })
    expect(bundles.install).toHaveBeenCalledExactlyOnceWith(BROWSER_BUNDLE)
    expect(browser.record).toHaveBeenCalledExactlyOnceWith('on')
  })

  // Pins the fresh-home check: opening Settings must not download or enable anything in a home whose setup is done.
  it('adds nothing and records nothing when an existing home that never chose opens the page', async () => {
    const { browser, bundles } = await show({ pack: 'available', fresh: false })
    expect(switchControl().getAttribute('aria-checked')).toBe('false')
    expect(screen.getByText(en['page.status.off'])).toBeTruthy()
    expect(bundles.install).not.toHaveBeenCalled()
    expect(browser.record).not.toHaveBeenCalled()
  })

  it('turns the pack on from the off page of an existing home that never chose', async () => {
    const { browser, bundles } = await show({ pack: 'available', fresh: false })
    await click(switchControl())
    await settle()
    expect(browser.record).toHaveBeenCalledExactlyOnceWith('on')
    expect(bundles.install).toHaveBeenCalledExactlyOnceWith(BROWSER_BUNDLE)
  })

  // Pins the removal check: with on recorded and the pack gone or turned off in Plugins, the page records off, not Installing for ever.
  it.each<readonly [string, object]>([['removed', {}], ['turned off', { held: true }]])('records off when the pack was %s in Plugins', async (_how, more) => {
    const { browser, bundles } = await show({ pack: 'available', packMore: more, recorded: 'on', fresh: false })
    expect(browser.record).toHaveBeenCalledExactlyOnceWith('off')
    expect(switchControl().getAttribute('aria-checked')).toBe('false')
    expect(bundles.install).not.toHaveBeenCalled()
  })

  // Pins the re-enable check: a pack seen disabled and now enabled was switched on in Plugins, so the page shows On, not a stale Off.
  it('records on when the pack, seen disabled while off, is enabled again in Plugins', async () => {
    const { browser } = await show({ pack: 'installed', recorded: 'off', seen: 'disabled', fresh: false })
    expect(browser.record).toHaveBeenCalledExactlyOnceWith('on')
    expect(switchControl().getAttribute('aria-checked')).toBe('true')
  })

  // Pins the "never infer on from installed" check: a pack never seen disabled is still waiting to turn off.
  it.each([['not seen yet', undefined, 'enabled'], ['seen enabled', 'enabled' as const, undefined]])('stays off for an enabled pack %s, and notes it', async (_how, seen, noted) => {
    const { browser } = await show({ pack: 'installed', recorded: 'off', ...seen === undefined ? {} : { seen }, fresh: false })
    expect(browser.record).not.toHaveBeenCalled()
    if (noted === undefined) expect(browser.recordSeen).not.toHaveBeenCalled()
    else expect(browser.recordSeen).toHaveBeenCalledExactlyOnceWith(noted)
    expect(switchControl().getAttribute('aria-checked')).toBe('false')
  })

  it('notes a pack that is off or removed while Browser is off, once', async () => {
    const { browser } = await show({ pack: 'available', packMore: { held: true }, recorded: 'off', fresh: false })
    expect(browser.recordSeen).toHaveBeenCalledExactlyOnceWith('disabled')
    expect(browser.record).not.toHaveBeenCalled()
  })

  // Turning off whose pack change ends in a restart leaves the pack enabled until the restart; reopening must not read that as On.
  it('stays off when turning off ended in a restart and the page is opened again', async () => {
    const browser = browserFake({ kind: 'ready' })
    browser.outcome.value = 'restart'
    await show({ browser })
    await click(switchControl())
    await settle()
    expect(browser.recorded.getSnapshot()).toBe('off')
    cleanup()
    await show({ browser })
    expect(browser.recorded.getSnapshot()).toBe('off')
    expect(browser.record).toHaveBeenCalledExactlyOnceWith('off')
    expect(switchControl().getAttribute('aria-checked')).toBe('false')
    // After the restart the pack reads off, and a later switch-on in Plugins is a real re-enable.
    cleanup()
    await show({ browser, pack: 'available', packMore: { held: true } })
    expect(browser.packSeen.getSnapshot()).toBe('disabled')
    cleanup()
    await show({ browser, pack: 'installed' })
    expect(browser.record).toHaveBeenLastCalledWith('on')
  })

  // The Host's write can fail outright; the page says so and keeps what it shows, and starts no add.
  it.each([['on', { pack: 'available' as const, fresh: false, recorded: 'off' as const }], ['off', {}]])('says it could not turn Browser %s when recording the choice throws', async (_which, options) => {
    const browser = browserFake({ kind: 'ready' })
    browser.record.mockRejectedValue(new Error('refused'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const { bundles } = await show({ ...options, browser })
    await click(switchControl())
    await settle()
    expect(screen.getByText(en['page.switch.failed'])).toBeTruthy()
    expect(bundles.install).not.toHaveBeenCalled()
    warn.mockRestore()
  })

  it('records on and hands a failed pack to the installer when switched on after Off', async () => {
    const { browser, bundles } = await show({ pack: 'failed', recorded: 'off', fresh: false, browser: browserFake({ kind: 'not-added' }) })
    await click(switchControl())
    await settle()
    expect(browser.record).not.toHaveBeenCalledWith('off')
    expect(bundles.install).toHaveBeenCalledExactlyOnceWith(BROWSER_BUNDLE)
  })

  it('does not add or record anything from a phone', async () => {
    const { browser, bundles } = await show({ pack: 'available', fresh: true, remote: true })
    expect(bundles.install).not.toHaveBeenCalled()
    expect(browser.record).not.toHaveBeenCalled()
  })

  it('says it could not change Browser, and keeps the shown state, when the Host refuses', async () => {
    const browser = browserFake({ kind: 'ready' })
    browser.outcome.value = 'failed'
    await show({ browser })
    await click(switchControl())
    await settle()
    expect(screen.getByText(en['page.switch.failed'])).toBeTruthy()
    expect(switchControl().getAttribute('aria-checked')).toBe('true')
    expect(browser.record).not.toHaveBeenCalled()
  })

  // Pins the phone check: installs and turn-offs are refused there, so the switch must not offer them.
  it('is held and points to the computer on a phone', async () => {
    await show({ remote: true })
    expect(switchControl().disabled).toBe(true)
    expect(screen.getByText(en['page.switch.remote'])).toBeTruthy()
  })

  it('holds the switch while the pack is being added', async () => {
    await show({ pack: 'installing', browser: browserFake({ kind: 'not-added' }) })
    expect(switchControl().disabled).toBe(true)
  })
})

describe('the status', () => {
  it.each<readonly [string, Options, string]>([
    ['checking', { pack: 'checking', browser: browserFake({ kind: 'checking' }) }, en['page.status.checking']],
    ['installing', { pack: 'installing', browser: browserFake({ kind: 'not-added' }) }, en['page.status.installing']],
    ['slow', { pack: 'slow', browser: browserFake({ kind: 'not-added' }) }, en['page.status.slow']],
    ['restart', { pack: 'restart', browser: browserFake({ kind: 'not-added' }) }, en['page.status.restart']],
    ['offline', { pack: 'offline', browser: browserFake({ kind: 'not-added' }) }, en['page.status.offline']],
    ['unavailable', { pack: 'unavailable', browser: browserFake({ kind: 'not-added' }) }, en['page.status.unavailable']],
    ['unavailable with a reason', { pack: 'unavailable', packMore: { reason: 'A build from source has no packs.' }, browser: browserFake({ kind: 'not-added' }) }, 'This Delorun cannot add Browser: A build from source has no packs.'],
    ['failed', { pack: 'failed', browser: browserFake({ kind: 'not-added' }) }, en['page.status.failed']],
    ['failed with a reason', { pack: 'failed', packMore: { reason: 'disk full' }, browser: browserFake({ kind: 'not-added' }) }, 'Browser could not be added: disk full'],
    ['unread', { pack: 'installed', browser: browserFake({ kind: 'failed' }) }, en['page.status.unread']],
    ['problem', { browser: browserFake({ kind: 'problem', message: 'no declaration' }) }, 'Delorun could not read what Browser needs: no declaration'],
    ['needs setup', { browser: browserFake(OTHER) }, 'Not ready yet: Needs Google Chrome installed'],
  ])('says %s in plain words', async (_name, options, text) => {
    await show(options)
    expect(screen.getByText(text)).toBeTruthy()
  })

  // Chrome is looked for first and the download second, so a computer with no Chrome and no download shows what to do and can try again.
  it('offers Try again where Chrome is not found or the download is missing, and reads the check again', async () => {
    const browser = browserFake(OTHER, { kind: 'ready' })
    await show({ browser })
    expect(screen.getByText('Not ready yet: Needs Google Chrome installed')).toBeTruthy()
    await click(screen.getByRole('button', { name: en['page.retry'] }))
    expect(screen.getByText(en['page.status.ready'])).toBeTruthy()
  })

  it('reads the check again on Try again after a failure, and adds the pack again after a failed add', async () => {
    const browser = browserFake({ kind: 'failed' })
    await show({ browser, pack: 'installed' })
    const reads = browser.refresh.mock.calls.length
    await click(screen.getByRole('button', { name: en['page.retry'] }))
    expect(browser.refresh.mock.calls.length).toBe(reads + 1)
    cleanup()
    const { bundles } = await show({ pack: 'failed', browser: browserFake({ kind: 'not-added' }) })
    await click(screen.getByRole('button', { name: en['page.retry'] }))
    expect(bundles.install).toHaveBeenCalledWith(BROWSER_BUNDLE)
  })
})

describe('the download', () => {
  it('downloads the Chromium build on the button, shows that it runs, and reads the check again when it ends', async () => {
    const browser = browserFake(DOWNLOAD, { kind: 'ready' })
    let finish: () => void = () => {}
    browser.download.mockImplementation(() => new Promise((resolve) => { finish = () => { resolve({ ok: true }) } }))
    await show({ browser })
    expect(screen.getByText('npx -y @playwright/mcp@0.0.1 install-browser chromium')).toBeTruthy()
    await click(screen.getByRole('button', { name: en['page.download'] }))
    expect(screen.getByText(en['page.download.running'])).toBeTruthy()
    expect(screen.queryByRole('button', { name: en['page.download'] })).toBeNull()
    const reads = browser.refresh.mock.calls.length
    await act(async () => { finish() })
    await settle()
    expect(browser.download).toHaveBeenCalledTimes(1)
    expect(browser.refresh.mock.calls.length).toBe(reads + 1)
    expect(screen.getByText(en['page.status.ready'])).toBeTruthy()
  })

  it('says why the download did not finish, and offers it again', async () => {
    const browser = browserFake(DOWNLOAD)
    browser.download.mockResolvedValue({ ok: false, reason: 'failed', message: 'offline' })
    await show({ browser })
    await click(screen.getByRole('button', { name: en['page.download'] }))
    await settle()
    expect(screen.getByRole('alert').textContent).toContain('The download did not finish: offline')
    expect(screen.getByRole('button', { name: en['page.download'] })).toBeTruthy()
  })

  // Pins the command check: Chrome's own install is not a download the Host makes.
  it('offers no download for a need that is not the Chromium build, only its command', async () => {
    await show({ browser: browserFake(OTHER) })
    expect(screen.queryByRole('button', { name: en['page.download'] })).toBeNull()
    expect(screen.getByText('npx -y @playwright/mcp@0.0.1 install-browser chrome')).toBeTruthy()
  })

  // Pins the phone check: the download runs on the computer, which only the computer's own studio may ask.
  it('offers no download on a phone', async () => {
    await show({ browser: browserFake(DOWNLOAD), remote: true })
    expect(screen.queryByRole('button', { name: en['page.download'] })).toBeNull()
  })
})

describe('the test', () => {
  it('opens the fixed page and shows its thumbnail, with no model turn', async () => {
    const { browser } = await show()
    await click(screen.getByRole('button', { name: en['page.test'] }))
    await settle()
    expect(browser.test).toHaveBeenCalledTimes(1)
    expect(screen.getByText(en['page.test.ok'])).toBeTruthy()
    const image = screen.getByRole('img', { name: en['page.test.alt'] }) as HTMLImageElement
    expect(image.getAttribute('src')).toMatch(/^data:image\/png;base64,/u)
  })

  it('shows that the test runs, and holds the button meanwhile', async () => {
    const browser = browserFake({ kind: 'ready' })
    browser.test.mockImplementation(() => new Promise(() => {}))
    await show({ browser })
    await click(screen.getByRole('button', { name: en['page.test'] }))
    expect(screen.getByText(en['page.test.running'])).toBeTruthy()
    expect((screen.getByRole('button', { name: en['page.test'] }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('says why the test did not work', async () => {
    const browser = browserFake({ kind: 'ready' })
    browser.test.mockResolvedValue({ ok: false, reason: 'failed', message: 'The browser stopped without saying why.' })
    await show({ browser })
    await click(screen.getByRole('button', { name: en['page.test'] }))
    await settle()
    expect(screen.getByRole('alert').textContent).toContain('The test did not work: The browser stopped without saying why.')
    expect(screen.queryByRole('img')).toBeNull()
  })

  // Pins the ready check: a browser that is not ready has nothing to test, and the download comes first.
  it('is not offered until Browser is ready', async () => {
    await show({ browser: browserFake(DOWNLOAD) })
    expect(screen.queryByRole('button', { name: en['page.test'] })).toBeNull()
    expect(screen.queryByText(en['page.asks'])).toBeNull()
  })

  it('is held on a phone, which says where to run it', async () => {
    await show({ remote: true })
    expect((screen.getByRole('button', { name: en['page.test'] }) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByText(en['page.test.atComputer'])).toBeTruthy()
  })
})

describe('the own Chrome card', () => {
  it('adds the pack on the button while it can be added', async () => {
    const { bundles } = await show({ own: 'available' })
    await click(screen.getByRole('button', { name: en['page.own.add'] }))
    expect(bundles.install).toHaveBeenCalledWith(REAL_BROWSER_BUNDLE)
  })

  it('offers no add on a phone', async () => {
    await show({ own: 'available', remote: true })
    expect(screen.queryByRole('button', { name: en['page.own.add'] })).toBeNull()
  })

  it.each<readonly [BundleState, string]>([
    ['checking', en['bundle.checking']],
    ['installing', en['bundle.adding']],
    ['slow', en['bundle.slow']],
    ['offline', en['bundle.offline']],
    ['unavailable', en['bundle.unavailable']],
    ['failed', en['bundle.failed']],
    ['restart', en['bundle.restart']],
  ])('says where the pack stands while it is %s', async (own, text) => {
    await show({ own })
    expect(screen.getByText(text)).toBeTruthy()
  })

  it('says the pack is paired, or what it needs, and opens Plugins to finish', async () => {
    const browser = browserFake({ kind: 'ready' })
    browser.setOwn({ kind: 'ready' })
    const { openPlugins } = await show({ browser })
    expect(screen.getByText(en['page.own.ready'])).toBeTruthy()
    await click(screen.getByRole('button', { name: en['page.own.plugins'] }))
    expect(openPlugins).toHaveBeenCalledTimes(1)
    cleanup()
    const waiting = browserFake({ kind: 'ready' })
    waiting.setOwn({ kind: 'needs-setup', reason: 'Needs the browse extension paired', fix: { kind: 'docs', url: 'https://example.com/guide' } })
    await show({ browser: waiting })
    expect(screen.getByText('Not paired yet: Needs the browse extension paired')).toBeTruthy()
    expect(screen.getByRole('button', { name: en['page.own.plugins'] })).toBeTruthy()
  })

  it('says what is wrong when the own-Chrome pack\'s declaration cannot be read', async () => {
    const browser = browserFake({ kind: 'ready' })
    browser.setOwn({ kind: 'problem', message: 'bad declaration' })
    await show({ browser })
    expect(screen.getByText('Delorun could not read what Browser needs: bad declaration')).toBeTruthy()
  })
})
