// @vitest-environment jsdom
/**
 * The Browser step: the shared Browser choice over the Browser plugin pack. Browser is on until the person turns it off:
 * a home that never chose adds the pack, No browser turns it off and records that, and the readiness comes from the Host's
 * requirement check. Each denial test's comment names the check whose removal makes it fail.
 */
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { BROWSER_BUNDLE, REAL_BROWSER_BUNDLE, type BrowserReadiness } from '@delorun/browser-setup'
import { turnBrowserOff } from '../src/client/browser-pack.ts'
import type { BundleState } from '../src/client/bundles.ts'
import { buildSteps, STEPS } from '../src/client/flow.tsx'
import { createGuide } from '../src/client/guide.ts'
import { en } from '../src/client/locales.ts'
import { OnboardingStepEntry, type OnboardingStepEntryProps } from '../src/client/Onboarding.tsx'
import { BrowserStep } from '../src/client/steps/Browser.tsx'
import type { OnboardingStep, StepServices } from '../src/client/types.ts'
import type { OnboardingSettings } from '../src/config.ts'
import { NO_RECORD } from '../src/wire.ts'
import { browserFake, hostFake, installerFake, liveForm, settings, stepServices, t } from './fixtures.client.ts'

afterEach(cleanup)

const click = async (element: HTMLElement) => { await act(async () => { fireEvent.click(element) }) }
const settle = async () => { await act(async () => { await Promise.resolve(); await Promise.resolve() }) }

const NEEDS_COMMAND: BrowserReadiness = { kind: 'needs-setup', reason: 'Needs the Chromium build downloaded', fix: { kind: 'command', command: 'delorun browser install' } }

/** Render the step over faked services. */
async function show(change: Partial<StepServices> = {}) {
  const services = stepServices(change)
  const host = hostFake()
  render(<BrowserStep services={services} guide={createGuide(host.host)} />)
  await settle()
  return { services, host }
}

const radios = (): HTMLInputElement[] => screen.getAllByRole('radio') as HTMLInputElement[]
const checked = (): boolean[] => radios().map(radio => radio.checked)
const pack = (state: BundleState, more: object = {}) => installerFake({ [BROWSER_BUNDLE]: { state, ...more } })

describe('the Browser step', () => {
  it('has the isolated browser chosen for a home that never chose, and adds the pack once', async () => {
    const bundles = pack('available')
    const browser = browserFake()
    await show({ bundles: bundles.installer, browser: browser.face })
    expect(screen.getByRole('radiogroup', { name: en['browser.which'] })).toBeTruthy()
    expect(checked()).toEqual([true, false])
    expect(bundles.refresh).toHaveBeenCalledWith([BROWSER_BUNDLE, REAL_BROWSER_BUNDLE])
    expect(bundles.install).toHaveBeenCalledExactlyOnceWith(BROWSER_BUNDLE)
    // Recorded so that removing the pack in Plugins later reads as the person's choice, not as a home that never chose.
    expect(browser.record).toHaveBeenCalledExactlyOnceWith('on')
  })

  // Pins the fresh-home check: a home whose setup is finished and that never chose must not download the pack by opening the step.
  it('does not add the pack for an existing home that never chose, and shows No browser', async () => {
    const bundles = pack('available')
    const browser = browserFake()
    browser.fresh.set(false)
    await show({ bundles: bundles.installer, browser: browser.face })
    expect(checked()).toEqual([false, true])
    expect(bundles.install).not.toHaveBeenCalled()
    expect(browser.record).not.toHaveBeenCalled()
  })

  it('adds the pack, and records on, when the isolated browser is chosen in an existing home', async () => {
    const bundles = pack('available')
    const browser = browserFake()
    browser.fresh.set(false)
    await show({ bundles: bundles.installer, browser: browser.face })
    await click(radios()[0]!)
    await settle()
    expect(browser.record).toHaveBeenCalledExactlyOnceWith('on')
    expect(bundles.install).toHaveBeenCalledExactlyOnceWith(BROWSER_BUNDLE)
  })

  // Pins "a home that chose off stays off": without the record check the step would add the pack again at every visit.
  it('does not add the pack for a home that chose off', async () => {
    const bundles = pack('available')
    const browser = browserFake()
    browser.recorded.set('off')
    await show({ bundles: bundles.installer, browser: browser.face })
    expect(checked()).toEqual([false, true])
    expect(bundles.install).not.toHaveBeenCalled()
  })

  // Pins the held check: a pack turned off in Plugins is a choice too, and the step must not turn it back on.
  it('does not add a pack the person turned off in Plugins', async () => {
    const bundles = pack('available', { held: true })
    await show({ bundles: bundles.installer })
    expect(checked()).toEqual([false, true])
    expect(bundles.install).not.toHaveBeenCalled()
  })

  // Pins the phone check: a studio on a phone cannot install, so it must not try.
  it('does not add the pack from a phone', async () => {
    const bundles = pack('available')
    await show({ bundles: bundles.installer, remote: true })
    expect(bundles.install).not.toHaveBeenCalled()
  })

  it('records the choice when the isolated browser is chosen after No browser', async () => {
    const bundles = pack('available')
    const browser = browserFake()
    browser.recorded.set('off')
    await show({ bundles: bundles.installer, browser: browser.face })
    await click(radios()[0] as HTMLInputElement)
    await settle()
    expect(browser.record).toHaveBeenCalledExactlyOnceWith('on')
    expect(bundles.install).toHaveBeenCalledExactlyOnceWith(BROWSER_BUNDLE)
    expect(checked()).toEqual([true, false])
  })

  it('says Browser could not be turned on when the Host refuses the choice, and adds nothing', async () => {
    const bundles = pack('available')
    const browser = browserFake()
    browser.recorded.set('off')
    browser.accepted.value = false
    await show({ bundles: bundles.installer, browser: browser.face })
    await click(radios()[0] as HTMLInputElement)
    await settle()
    expect(screen.getByRole('alert').textContent).toContain(en['browser.turnOn.failed'])
    expect(bundles.install).not.toHaveBeenCalled()
  })

  it('has the isolated browser chosen for an added pack, and says Browser is ready and what the first chat asks', async () => {
    const browser = browserFake({ kind: 'ready' })
    await show({ browser: browser.face, bundles: pack('installed').installer })
    expect(checked()).toEqual([true, false])
    expect(screen.getByText(en['browser.ready'])).toBeTruthy()
    expect(screen.getByText(en['browser.expect.asks.text']).textContent).toBe('The first chat that uses Browser asks you to allow its browser tool. Allow it once and Delorun does not ask again.')
  })

  it('shows the Host\'s reason as "Needs setup · reason" with its command, and opens the Settings section a need is met in', async () => {
    await show({ browser: browserFake(NEEDS_COMMAND).face, bundles: pack('installed').installer })
    expect(screen.getByText('Needs setup · Needs the Chromium build downloaded')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Copy delorun browser install' })).toBeTruthy()
    cleanup()
    const browser = browserFake({ kind: 'needs-setup', reason: 'Needs BROWSER_KEY set', fix: { kind: 'settings', section: 'models' } })
    await show({ browser: browser.face, bundles: pack('installed').installer })
    await click(screen.getByRole('button', { name: en['browser.fix.settings'] }))
    expect(browser.openSettings).toHaveBeenCalledExactlyOnceWith('models')
  })

  it('reads the check again on Try again, when the pack\'s state changes, and when the window regains focus', async () => {
    const browser = browserFake({ kind: 'failed' }, NEEDS_COMMAND, { kind: 'ready' })
    const bundles = pack('installed')
    await show({ browser: browser.face, bundles: bundles.installer })
    await click(screen.getByRole('button', { name: en['browser.retry'] }))
    expect(screen.getByText(/^Needs setup/)).toBeTruthy()
    await act(async () => { window.dispatchEvent(new Event('focus')) })
    await settle()
    expect(screen.getByText(en['browser.ready'])).toBeTruthy()
    const reads = browser.refresh.mock.calls.length
    await act(async () => { bundles.store.set({ [BROWSER_BUNDLE]: { state: 'restart' } }) })
    await settle()
    expect(browser.refresh.mock.calls.length).toBe(reads + 1)
  })

  it.each<readonly [BundleState, string, object]>([
    ['checking', en['bundle.checking'], {}],
    ['installing', en['bundle.adding'], {}],
    ['slow', en['bundle.slow'], {}],
    ['offline', en['bundle.offline'], {}],
    ['unavailable', en['bundle.unavailable'], {}],
    ['unavailable', 'Not available here. A build from source has no plugin packs.', { packsReason: 'A build from source has no plugin packs.' }],
    ['failed', en['bundle.failed'], {}],
    ['failed', 'Could not add it: the download stopped. Try again, or add it from Plugins.', { reason: 'the download stopped' }],
    ['restart', en['bundle.restart'], {}],
    ['installed', en['browser.added'], {}],
  ])('says where the pack stands while it is %s and the Host does not list it yet', async (state, text, more) => {
    await show({ bundles: pack(state, more).installer })
    expect(screen.getByText(text)).toBeTruthy()
  })

  it('holds the choices while the pack is being added, and retries a failed add', async () => {
    const bundles = pack('installing')
    await show({ bundles: bundles.installer })
    expect(radios().map(radio => radio.disabled)).toEqual([true, true])
    await act(async () => { bundles.store.set({ [BROWSER_BUNDLE]: { state: 'failed' } }) })
    expect(radios().map(radio => radio.disabled)).toEqual([false, false])
    await click(screen.getByRole('button', { name: en['bundle.retry'] }))
    expect(bundles.install).toHaveBeenCalledWith(BROWSER_BUNDLE)
  })

  it('turns the pack off when No browser is chosen for an added pack, and reads the pack again', async () => {
    const browser = browserFake({ kind: 'ready' })
    const bundles = pack('installed')
    await show({ browser: browser.face, bundles: bundles.installer })
    bundles.refresh.mockClear()
    await click(radios()[1] as HTMLInputElement)
    await settle()
    expect(browser.turnOff).toHaveBeenCalledTimes(1)
    expect(bundles.refresh).toHaveBeenCalledExactlyOnceWith([BROWSER_BUNDLE])
    expect(checked()).toEqual([false, true])
    expect(browser.record).toHaveBeenCalledExactlyOnceWith('off')
    expect(screen.queryByText(en['browser.ready'])).toBeNull()
    expect(bundles.install).not.toHaveBeenCalled()
  })

  it('only records No browser for a pack that is not added', async () => {
    // Pins the guard: without it choosing No browser on a fresh profile asks the plugin manager to disable a bundle it does not hold.
    const browser = browserFake()
    const bundles = pack('unavailable')
    await show({ browser: browser.face, bundles: bundles.installer })
    await click(radios()[1] as HTMLInputElement)
    await settle()
    expect(checked()).toEqual([false, true])
    expect(browser.turnOff).not.toHaveBeenCalled()
    expect(browser.record).toHaveBeenCalledExactlyOnceWith('off')
    expect(bundles.install).not.toHaveBeenCalled()
  })

  it('says Browser turns off at the next start when the plugin manager needs a restart', async () => {
    const browser = browserFake({ kind: 'ready' })
    browser.outcome.value = 'restart'
    await show({ browser: browser.face, bundles: pack('installed').installer })
    await click(radios()[1] as HTMLInputElement)
    await settle()
    expect(screen.getByText(en['browser.turnOff.restart'])).toBeTruthy()
    expect(checked()).toEqual([false, true])
  })

  it('keeps the isolated browser chosen and says so when the pack could not be turned off', async () => {
    // Pins the failure branch: without it the step shows No browser while Browser is still on.
    const browser = browserFake({ kind: 'ready' })
    browser.outcome.value = 'failed'
    await show({ browser: browser.face, bundles: pack('installed').installer })
    await click(radios()[1] as HTMLInputElement)
    await settle()
    expect(screen.getByRole('alert').textContent).toContain(en['browser.turnOff.failed'])
    expect(checked()).toEqual([true, false])
    expect(browser.record).not.toHaveBeenCalled()
  })
})

describe('turning the Browser pack off', () => {
  const ctx = (remote: object | undefined): Parameters<typeof turnBrowserOff>[0] => ({ get: () => remote }) as never
  const answers = (application: string) => vi.fn(() => Promise.resolve({ ok: true, value: { application } }))

  it('disables the bundle through the plugin manager and reports how it ended', async () => {
    const applied = answers('applied')
    expect(await turnBrowserOff(ctx({ setBundleEnabled: applied }))).toBe('off')
    expect(applied).toHaveBeenCalledExactlyOnceWith(BROWSER_BUNDLE, false)
    expect(await turnBrowserOff(ctx({ setBundleEnabled: answers('restart-required') }))).toBe('restart')
    expect(await turnBrowserOff(ctx({ setBundleEnabled: answers('failed') }))).toBe('failed')
  })

  it('fails without a plugin manager, on a refusal and on a call that throws', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(await turnBrowserOff(ctx(undefined))).toBe('failed')
    expect(await turnBrowserOff(ctx({ setBundleEnabled: () => Promise.resolve({ ok: false, error: { code: 'ELEVATION_REQUIRED' } }) }))).toBe('failed')
    expect(await turnBrowserOff(ctx({ setBundleEnabled: () => Promise.reject(new Error('transport')) }))).toBe('failed')
    expect(warn).toHaveBeenCalledTimes(1)
    warn.mockRestore()
  })
})

describe('the Browser step\'s place in the guide', () => {
  const ids = (change: { readonly plugins?: readonly string[], readonly browserAdded?: boolean, readonly covered?: boolean } = {}): string[] => buildSteps({
    services: stepServices({ plugins: change.plugins ?? [] }), guide: createGuide(hostFake().host),
    record: change.covered === true ? { ...NO_RECORD, sections: ['plugins'] } : NO_RECORD,
    extra: [], reach: 'absent', phone: 'untouched', target: { kind: 'other' }, notice: undefined, keepCurrent: false, first: false,
    ...change.browserAdded === undefined ? {} : { browserAdded: change.browserAdded },
  }).map(step => step.id)

  it('follows Recommended plugins while the guide offers the Browser pack', () => {
    const steps = ids({ plugins: ['@scope/other', BROWSER_BUNDLE] })
    expect(steps.slice(steps.indexOf(STEPS.plugins.id), steps.indexOf(STEPS.plugins.id) + 2)).toEqual(['plugins', 'browser'])
  })

  it('is left out of a first open, where the pack is offered or added', () => {
    const first = (browserAdded: boolean): string[] => buildSteps({
      services: stepServices({ plugins: [BROWSER_BUNDLE] }), guide: createGuide(hostFake().host), record: NO_RECORD,
      extra: [], reach: 'absent', phone: 'untouched', target: { kind: 'other' }, notice: undefined, keepCurrent: false, first: true, browserAdded,
    }).map(step => step.id)
    expect(first(true)).not.toContain('browser')
    expect(first(false)).not.toContain('plugins')
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
      t, complete: vi.fn(), completeStep: vi.fn(), renderSection: (id: string) => `section ${id}`, explicit: true,
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
