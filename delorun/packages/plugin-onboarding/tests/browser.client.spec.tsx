// @vitest-environment jsdom
/**
 * The Browser step: whether Browser is ready, read from the Host's requirement check; the action that meets an unmet
 * need; what the first chat asks; and, under the preview flag only, the planned choice of the person's own browser,
 * which records nothing. Each denial test's comment names the check whose removal makes it fail.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { RequirementsAnswer } from '@delorun/bundle-local/requirements-api'
import { BROWSER_BUNDLE, browserAdded, browserSetupOf, createBrowserSetup, type BrowserSetup } from '../src/client/browser-setup.ts'
import { buildSteps, STEPS } from '../src/client/flow.tsx'
import { createGuide } from '../src/client/guide.ts'
import { en } from '../src/client/locales.ts'
import { OnboardingStepEntry, type OnboardingStepEntryProps } from '../src/client/Onboarding.tsx'
import { BrowserStep } from '../src/client/steps/Browser.tsx'
import type { OnboardingStep, StepServices } from '../src/client/types.ts'
import { NO_RECORD } from '../src/wire.ts'
import { PREVIEW_STEPS } from '../src/preview-flags.ts'
import type { OnboardingSettings } from '../src/config.ts'
import { browserFake, flagsFake, hostFake, installerFake, liveForm, settings, stepServices, t } from './fixtures.client.ts'

afterEach(cleanup)

const click = async (element: HTMLElement) => { await act(async () => { fireEvent.click(element) }) }
const settle = async () => { await act(async () => { await Promise.resolve(); await Promise.resolve() }) }

const ROW = 'browser-use-playwright-mcp'
const NEEDS_COMMAND: BrowserSetup = { kind: 'needs-setup', reason: 'Needs the Chromium build downloaded', fix: { kind: 'command', command: 'delorun browser install' } }

/** Render the step over faked services. */
async function show(change: Partial<StepServices> = {}) {
  const services = stepServices(change)
  const host = hostFake()
  render(<BrowserStep services={services} guide={createGuide(host.host)} />)
  await settle()
  return { services, host }
}

describe('Browser\'s setup, narrowed from the Host\'s requirement check', () => {
  const answer = (rows: RequirementsAnswer['rows'], problems: RequirementsAnswer['problems'] = []): RequirementsAnswer => ({ rows, problems })

  it('is ready when every row of the pack is, and not added when the Host lists none', () => {
    expect(browserSetupOf(answer([{ packageName: BROWSER_BUNDLE, rowId: ROW, state: 'ready' }]))).toEqual({ kind: 'ready' })
    expect(browserSetupOf(answer([{ packageName: '@delorun/bundle-other', rowId: 'row', state: 'needs-setup', reason: 'Needs x installed', fix: { kind: 'docs', url: 'https://example.test' } }]))).toEqual({ kind: 'not-added' })
    expect(browserSetupOf(answer([]))).toEqual({ kind: 'not-added' })
  })

  it('carries the Host\'s reason and fix for the first row that needs setup, whatever they are', () => {
    const fix = { kind: 'command', command: 'npx playwright install chromium' } as const
    expect(browserSetupOf(answer([
      { packageName: BROWSER_BUNDLE, rowId: 'browser-use', state: 'ready' },
      { packageName: BROWSER_BUNDLE, rowId: ROW, state: 'needs-setup', reason: 'Needs Chromium downloaded', fix },
    ]))).toEqual({ kind: 'needs-setup', reason: 'Needs Chromium downloaded', fix })
  })

  it('reports a declaration the Host could not read', () => {
    expect(browserSetupOf(answer([], [{ packageName: BROWSER_BUNDLE, message: 'bad needs' }]))).toEqual({ kind: 'problem', message: 'bad needs' })
  })

  it('counts the pack as added for every state the Host reports about it', () => {
    expect([{ kind: 'ready' }, NEEDS_COMMAND, { kind: 'problem', message: 'x' }].map(setup => browserAdded(setup as BrowserSetup))).toEqual([true, true, true])
    expect([{ kind: 'checking' }, { kind: 'not-added' }, { kind: 'failed' }].map(setup => browserAdded(setup as BrowserSetup))).toEqual([false, false, false])
  })

  it('asks the check in the studio\'s language and shares one request between overlapping reads', async () => {
    const urls: string[] = []
    let language = 'en'
    const store = createBrowserSetup(async (input) => {
      urls.push(input)
      return new Response(JSON.stringify(answer([{ packageName: BROWSER_BUNDLE, rowId: ROW, state: 'ready' }])), { status: 200 })
    }, () => language)
    expect(store.getSnapshot()).toEqual({ kind: 'checking' })
    const [first, second] = await Promise.all([store.refresh(), store.refresh()])
    expect([first, second, store.getSnapshot()]).toEqual([{ kind: 'ready' }, { kind: 'ready' }, { kind: 'ready' }])
    language = 'zh-CN'
    const listener = vi.fn()
    const unsubscribe = store.subscribe(listener)
    await store.refresh()
    expect(listener).toHaveBeenCalledTimes(1)
    unsubscribe()
    await store.refresh()
    expect(listener).toHaveBeenCalledTimes(1)
    urls.pop()
    expect(urls).toEqual(['/api/delorunRequirements.check?language=en', '/api/delorunRequirements.check?language=zh'])
  })

  it('is failed, with a warning, when the check cannot be read', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const store = createBrowserSetup(async () => new Response('{}', { status: 500 }), () => 'en')
    expect(await store.refresh()).toEqual({ kind: 'failed' })
    expect(warn).toHaveBeenCalledTimes(1)
    warn.mockRestore()
  })
})

describe('the Browser step', () => {
  it('says Browser is ready, and that the first chat asks once to allow playwright-mcp and never again', async () => {
    const browser = browserFake({ kind: 'ready' })
    const bundles = installerFake({ [BROWSER_BUNDLE]: { state: 'installed', title: 'Browser', description: 'The pack\'s own description' } })
    await show({ browser: browser.face, bundles: bundles.installer })
    expect(screen.getByText(en['browser.ready'])).toBeTruthy()
    // Once the pack is in the profile, the card shows its own words.
    expect(screen.getByText('The pack\'s own description')).toBeTruthy()
    expect(screen.queryByText(en['browser.pack.description'])).toBeNull()
    expect(screen.getByText(en['browser.expect.asks.text']).textContent).toBe('The first chat that uses Browser asks you to allow its browser tool, playwright-mcp. Allow it once and Delorun does not ask again.')
    expect(screen.getByText(en['bundle.added'])).toBeTruthy()
    expect(bundles.refresh).toHaveBeenCalledWith([BROWSER_BUNDLE])
  })

  it('shows the Host\'s reason as "Needs setup · reason" with its command and a copy button', async () => {
    await show({ browser: browserFake(NEEDS_COMMAND).face })
    expect(screen.getByText('Needs setup · Needs the Chromium build downloaded')).toBeTruthy()
    expect(screen.getByText('delorun browser install').tagName).toBe('CODE')
    expect(screen.getByRole('button', { name: 'Copy delorun browser install' })).toBeTruthy()
    expect(screen.queryByText(en['browser.ready'])).toBeNull()
  })

  it('links to the page that says how, for a need a page explains', async () => {
    await show({ browser: browserFake({ kind: 'needs-setup', reason: 'Needs Chrome or Chromium installed', fix: { kind: 'docs', url: 'https://www.google.com/chrome/' } }).face })
    const link = screen.getByRole('link', { name: en['browser.fix.docs'] })
    expect([link.getAttribute('href'), link.getAttribute('target'), link.getAttribute('rel')]).toEqual(['https://www.google.com/chrome/', '_blank', 'noopener noreferrer'])
  })

  it('opens the Settings section a need is met in', async () => {
    const browser = browserFake({ kind: 'needs-setup', reason: 'Needs BROWSER_KEY set', fix: { kind: 'settings', section: 'models' } })
    await show({ browser: browser.face })
    await click(screen.getByRole('button', { name: en['browser.fix.settings'] }))
    expect(browser.openSettings).toHaveBeenCalledExactlyOnceWith('models')
  })

  it('offers Try again when the check cannot be read, and reports a declaration the Host could not read', async () => {
    const browser = browserFake({ kind: 'failed' }, { kind: 'problem', message: 'bad needs' })
    await show({ browser: browser.face })
    expect(screen.getByText(en['browser.unread'])).toBeTruthy()
    await click(screen.getByRole('button', { name: en['bundle.retry'] }))
    expect(screen.getByRole('alert').textContent).toContain('Delorun could not read what Browser needs: bad needs')
  })

  it('offers to add the pack while it is not in the profile, and says what the step shows once it is', async () => {
    const bundles = installerFake({ [BROWSER_BUNDLE]: { state: 'available' } })
    await show({ bundles: bundles.installer })
    expect(screen.getByText(en['browser.notAdded'])).toBeTruthy()
    expect(screen.getByText(en['browser.pack.description'])).toBeTruthy()
    await click(screen.getByRole('button', { name: 'Add Browser' }))
    expect(bundles.install).toHaveBeenCalledExactlyOnceWith(BROWSER_BUNDLE)
  })

  it.each(['unavailable', 'offline', 'failed', 'restart', 'checking'] as const)('leaves the add hint out while the pack is %s, which its card explains', async (state) => {
    // Pins the condition: without it the step says "Add Browser" under a card that says it cannot be added here.
    await show({ bundles: installerFake({ [BROWSER_BUNDLE]: { state } }).installer })
    expect(screen.queryByText(en['browser.notAdded'])).toBeNull()
    expect(screen.queryByText(en['browser.added'])).toBeNull()
  })

  it('says an added pack is checked once it has loaded, while the Host does not list it yet', async () => {
    await show({ bundles: installerFake({ [BROWSER_BUNDLE]: { state: 'installed' } }).installer })
    expect(screen.getByText(en['browser.added'])).toBeTruthy()
  })

  it('says a pack that was just added is checked once it has loaded, then reads again when its state changes', async () => {
    const browser = browserFake({ kind: 'not-added' }, { kind: 'ready' })
    const bundles = installerFake({ [BROWSER_BUNDLE]: { state: 'installing' } })
    await show({ browser: browser.face, bundles: bundles.installer })
    expect(screen.getByText(en['browser.notAdded'])).toBeTruthy()
    await act(async () => { bundles.store.set({ [BROWSER_BUNDLE]: { state: 'installed' } }) })
    await settle()
    expect(screen.getByText(en['browser.ready'])).toBeTruthy()
  })

  it('checks again when the window regains focus, so a need met in a terminal clears', async () => {
    const browser = browserFake(NEEDS_COMMAND, { kind: 'ready' })
    await show({ browser: browser.face })
    expect(screen.getByText(/^Needs setup/)).toBeTruthy()
    await act(async () => { window.dispatchEvent(new Event('focus')) })
    await settle()
    expect(screen.getByText(en['browser.ready'])).toBeTruthy()
    expect(screen.queryByText(/^Needs setup/)).toBeNull()
  })
})

describe('the planned choice of browser', () => {
  it('is absent while the preview flag is off', async () => {
    // Pins the flag read: without it the unbuilt choice shows to everyone.
    await show({ browser: browserFake({ kind: 'ready' }).face })
    expect(screen.queryByRole('radiogroup')).toBeNull()
    expect(screen.queryByText(en['browser.which.mine.title'])).toBeNull()
    expect(screen.queryByText(en['previewFlag.chip'])).toBeNull()
  })

  it('shows Use my browser with the Preview chip beside its title while the flag is on', async () => {
    await show({ browser: browserFake({ kind: 'ready' }).face, previewFlags: flagsFake(PREVIEW_STEPS.id) })
    const group = screen.getByRole('radiogroup', { name: en['browser.which'] })
    const radios = within(group).getAllByRole('radio') as HTMLInputElement[]
    expect(radios.map(radio => [radio.getAttribute('aria-labelledby') === null ? '' : document.getElementById(radio.getAttribute('aria-labelledby') ?? '')?.textContent, radio.checked]))
      .toEqual([['Delorun\'s browser', true], ['Use my browser', false]])
    expect(screen.getByText(en['browser.which.mine.text']).textContent).toBe('Your Chrome with your sign-ins, approved per chat.')
    const chips = screen.getAllByText('Preview')
    expect(chips).toHaveLength(1)
    // The chip sits in the title row of Use my browser and nowhere else.
    expect(chips[0]?.closest('div')?.textContent).toContain('Use my browser')
    fireEvent.focus(chips[0] as HTMLElement)
    expect((await screen.findByRole('tooltip')).textContent).toBe(en['browser.which.mine.preview'])
    expect(screen.getByText(en['browser.which.note'])).toBeTruthy()
  })

  it('records nothing and changes nothing when Use my browser is chosen', async () => {
    // Pins the preview's promise: a write, a request or an install here would make the planned choice real.
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(() => Promise.reject(new Error('no request may be made')))
    const browser = browserFake({ kind: 'ready' })
    const bundles = installerFake({ [BROWSER_BUNDLE]: { state: 'installed', title: 'Browser' } })
    const { host } = await show({ browser: browser.face, bundles: bundles.installer, previewFlags: flagsFake(PREVIEW_STEPS.id) })
    const reads = browser.refresh.mock.calls.length
    const mine = screen.getAllByRole('radio')[1] as HTMLInputElement
    await click(mine)
    await waitFor(() => { expect(mine.checked).toBe(true) })
    expect(fetch).not.toHaveBeenCalled()
    expect(browser.refresh.mock.calls.length).toBe(reads)
    expect(browser.openSettings).not.toHaveBeenCalled()
    expect([bundles.install, bundles.enableRow, bundles.openPlugins].every(spy => spy.mock.calls.length === 0)).toBe(true)
    expect([host.defer, host.cloneStart, host.recommend].every(spy => spy.mock.calls.length === 0)).toBe(true)
    expect(screen.getByText(en['browser.ready'])).toBeTruthy()
    fetch.mockRestore()
  })
})

describe('the Browser step\'s place in the guide', () => {
  const ids = (change: { readonly plugins?: readonly string[], readonly browserAdded?: boolean, readonly covered?: boolean } = {}): string[] => buildSteps({
    services: stepServices({ plugins: change.plugins ?? [] }), guide: createGuide(hostFake().host),
    record: change.covered === true ? { ...NO_RECORD, sections: ['plugins'] } : NO_RECORD,
    extra: [], reach: 'absent', phone: 'untouched', target: { kind: 'other' }, notice: undefined, keepCurrent: false,
    ...change.browserAdded === undefined ? {} : { browserAdded: change.browserAdded },
  }).map(step => step.id)

  it('follows Recommended plugins while the guide offers the Browser pack', () => {
    const steps = ids({ plugins: ['@scope/other', BROWSER_BUNDLE] })
    expect(steps.slice(steps.indexOf(STEPS.plugins.id), steps.indexOf(STEPS.plugins.id) + 2)).toEqual(['plugins', 'browser'])
  })

  it('is left out where the pack is neither offered nor added', () => {
    // Pins the condition: without it every profile gets a Browser step, with nothing to say.
    expect(ids({ plugins: ['@scope/other'] })).not.toContain('browser')
    expect(ids()).not.toContain('browser')
    // The terminal setup covered the plugins step, so the guide does not offer the pack.
    expect(ids({ plugins: [BROWSER_BUNDLE], covered: true })).not.toContain('browser')
  })

  it('shows for a pack that is already added, offered or not', () => {
    expect(ids({ browserAdded: true })).toContain('browser')
    expect(ids({ plugins: [BROWSER_BUNDLE], covered: true, browserAdded: true })).toContain('browser')
  })

  it('is in the dialog for a pack the Host already reports, which the dialog reads before it shows its steps', async () => {
    const browser = browserFake({ kind: 'ready' })
    const props = {
      t, complete: vi.fn(), completeStep: vi.fn(), renderSection: (id: string) => `section ${id}`,
      progress: liveForm<OnboardingSettings>(settings()).form, extra: createSnapshotStore<readonly OnboardingStep[]>([]), loadRecord: () => Promise.resolve(NO_RECORD),
      services: stepServices({ browser: browser.face }), startChat: () => Promise.resolve(), aside: createSnapshotStore(false), deferredOnly: createSnapshotStore(false),
    } satisfies OnboardingStepEntryProps
    render(<OnboardingStepEntry {...props} />)
    await settle()
    await settle()
    expect(browser.refresh).toHaveBeenCalledTimes(1)
    expect(within(screen.getByRole('navigation')).getAllByRole('listitem').map(each => each.textContent)).toContain(en['step.browser'])
  })
})
