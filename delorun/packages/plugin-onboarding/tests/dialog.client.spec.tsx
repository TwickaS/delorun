// @vitest-environment jsdom
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createFakeDownloadsSource, provideDownloadsSource } from '@delorun/plugin-downloads/row'
import { OnboardingStepEntry, UPSTREAM_KEY_STEP, type OnboardingStepEntryProps } from '../src/client/Onboarding.tsx'
import { en } from '../src/client/locales.ts'
import type { OnboardingStep, ReachState, StartTarget } from '../src/client/types.ts'
import type { OnboardingSettings } from '../src/config.ts'
import { NO_RECORD, type Readiness, type SetupRecord } from '../src/wire.ts'
import { DEFAULT_PATH, pathText, DEFAULT_WORKSPACE, hostFake, liveForm, noticeFace, READY, settings, startFace, stepServices, t, THEME } from './fixtures.client.ts'
import type { ThemeSettings } from '@delorun/plugin-theme'

afterEach(() => {
  cleanup()
  document.getElementById('root')?.remove()
  vi.restoreAllMocks()
})

beforeEach(() => {
  const root = document.createElement('div')
  root.id = 'root'
  root.inert = false
  document.body.appendChild(root)
})

const settle = async () => { await act(async () => { await Promise.resolve(); await Promise.resolve() }) }
const click = async (element: HTMLElement) => { await act(async () => { fireEvent.click(element) }) }
const button = (name: string) => screen.getByRole('button', { name })

interface Options {
  /** Tailscale as the guide reads it; the fixtures' ready one by default. */
  readonly tailscale?: Readiness['tailscale']
  readonly settings?: OnboardingSettings | undefined
  readonly status?: 'loading' | 'ready' | 'unavailable'
  readonly explicit?: boolean
  readonly record?: SetupRecord | Promise<SetupRecord>
  readonly notice?: ReturnType<typeof noticeFace>
  readonly extra?: readonly OnboardingStep[]
  readonly writeResult?: boolean | 'reject'
  readonly reach?: ReachState
  /** The studio's address over Tailscale the reach status holds. */
  readonly reachAddress?: string
  readonly start?: ReturnType<typeof startFace>
  readonly useStockLook?: () => Promise<boolean>
  /** The PIN state a phone reads; absent fails the read. */
  readonly pinState?: object
  /** Whether the Finish setup entry at the computer opened the dialog for the deferred steps only. */
  readonly deferredOnly?: boolean
}

/** The step entry over fakes, as the Settings shell mounts it. */
async function mountEntry(options: Options = {}) {
  const progress = liveForm<OnboardingSettings>(options.settings ?? settings(), {
    status: options.status ?? 'ready', ...options.writeResult === undefined ? {} : { result: options.writeResult },
  })
  const extra = createSnapshotStore<readonly OnboardingStep[]>(options.extra ?? [])
  const base = createSnapshotStore(false)
  // Records what the pause was asked to keep in the home, as the plugin's store does.
  const set = vi.fn((value: boolean, remember?: boolean) => { void remember; base.set(value) })
  const aside = { ...base, set }
  const complete = vi.fn()
  const completeStep = vi.fn((_id: string) => {})
  const startChat = vi.fn((_workspaceId?: string, _keepCurrent?: boolean) => Promise.resolve())
  const loadRecord = vi.fn(() => Promise.resolve(options.record ?? NO_RECORD))
  const host = hostFake({ reach: options.reach ?? 'absent', reachAddress: options.reachAddress, ...options.tailscale === undefined ? {} : { readiness: { ...READY, tailscale: options.tailscale } } })
  const start = options.start ?? startFace()
  const deferredOnly = createSnapshotStore(options.deferredOnly ?? false)
  const pinFetch = vi.fn((_input: string) => options.pinState === undefined ? Promise.reject(new Error('no PIN request')) : Promise.resolve(new Response(JSON.stringify(options.pinState))))
  const services = stepServices({ notice: options.notice?.face, host: host.host, pin: { fetch: pinFetch, openSettings: () => undefined }, start: start.face, ...options.useStockLook === undefined ? {} : { look: { settings: liveForm<ThemeSettings>(THEME).form, useStockLook: options.useStockLook } } })
  const props = {
    t, complete, completeStep, renderSection: (id: string) => `section ${id}`, ...options.explicit === undefined ? {} : { explicit: options.explicit },
    progress: progress.form, extra, loadRecord, services, startChat, aside, deferredOnly,
  } satisfies OnboardingStepEntryProps
  const view = render(<OnboardingStepEntry {...props} />)
  await settle()
  await settle()
  return { ...view, aside, progress, extra, complete, completeStep, startChat, loadRecord, services, host, start, deferredOnly }
}

/** The steps the guide opened from Settings shows with nothing configured. */
const BASE = [en['step.welcome'], en['step.providers'], en['step.look'], en['step.agents'], en['step.workspace'], en['step.ready']]

/** The steps a first run shows where a default workspace exists: no Look, Agents, plugins, Browser or Phone access. */
const FIRST = [en['step.welcome'], en['step.providers'], en['step.ready']]

/** The guide opened from Settings, which builds every step; no workspace is held, so the default one is chosen as on a first run. */
const mountFull = (options: Options = {}) => mountEntry({ start: startFace(undefined, undefined, false), ...options, explicit: true })

/** Press Continue a number of times. */
// The Models landing has its own button: with every card unticked it reads "Continue without a key" and stands in for Continue.
const forward = async (times: number) => {
  for (let n = 0; n < times; n++) {
    await settle()
    const next = screen.queryByRole('button', { name: en.continue }) ?? screen.queryByRole('button', { name: en['reach.done'] })
    if (next !== null) { await click(next); continue }
    for (const box of screen.queryAllByRole('checkbox')) if ((box as HTMLInputElement).checked) await click(box)
    await click(button(en['providers.continueNoKey']))
  }
}

const titles = () => within(screen.getByRole('navigation')).getAllByRole('listitem').map(each => each.textContent?.replace(/^(\d+|✓)/, ''))
const heading = () => screen.getByRole('heading', { level: 2 })

describe('a profile that has finished onboarding', () => {
  it('completes upstream\'s step at once and shows nothing, without asking the harness for the record', async () => {
    const { complete, loadRecord, container, host } = await mountEntry({ settings: settings({ done: true }) })
    expect(complete).toHaveBeenCalledOnce()
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(container.textContent).toBe('')
    expect(loadRecord).not.toHaveBeenCalled()
    expect(host.readiness).not.toHaveBeenCalled()
  })

  it('completes at once when the settings are not served, and waits while they load', async () => {
    const unavailable = await mountEntry({ status: 'unavailable', settings: settings() })
    expect(unavailable.complete).toHaveBeenCalledOnce()
    cleanup()
    const loading = await mountEntry({ status: 'loading', settings: undefined })
    expect(loading.complete).not.toHaveBeenCalled()
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('shows the flow again from Welcome, without the notice, when Settings reopens it, and keeps the finished mark until the end', async () => {
    const notice = noticeFace()
    const { complete, progress } = await mountEntry({ settings: settings({ done: true }), explicit: true, notice })
    expect(heading().textContent).toBe(en['step.welcome'])
    expect(screen.queryByText('Delorun is a pre-release community fork.')).toBeNull()
    expect(titles()).toEqual(BASE)
    expect(complete).not.toHaveBeenCalled()
    expect(progress.set).not.toHaveBeenCalled()
    await forward(2)
    expect(heading().textContent).toBe(en['step.look'])
    expect(notice.acknowledge).not.toHaveBeenCalled()
  })
})

describe('the first run', () => {
  it('waits for the record and the reach status before it shows anything, and reads this computer once', async () => {
    let release: (record: SetupRecord) => void = () => {}
    const { container, host } = await mountEntry({ record: new Promise<SetupRecord>((resolve) => { release = resolve }) })
    expect(container.textContent).toBe('')
    await act(async () => { release({ reachSetUp: false }) })
    expect(screen.getByRole('dialog')).toBeTruthy()
    expect([host.reach, host.readiness, host.keyTest].map(each => each.mock.calls.length)).toEqual([1, 1, 1])
  })

  it('shows Welcome, Models and Ready where a default workspace exists, and leaves out Look, Agents, plugins and Phone access', async () => {
    await mountEntry({ reach: 'off', record: { reachSetUp: false }, settings: settings({ plugins: ['@scope/p'] }) })
    expect(titles()).toEqual(FIRST)
    expect(screen.getByText('Step 1 of 3')).toBeTruthy()
  })

  it('adds Workspace where there is no default workspace for the first chat', async () => {
    await mountEntry({ start: startFace({ kind: 'none' }) })
    expect(titles()).toEqual([en['step.welcome'], en['step.providers'], en['step.workspace'], en['step.ready']])
  })

  it('adds the PIN step at the computer where reach is set up and PIN mode is off, and reads the PIN state there', async () => {
    const pinState = { kind: 'on', secret: 'pin', idleMinutes: 15, paused: false, unlock: null }
    const off = await mountEntry({ reach: 'set-up', record: { reachSetUp: true }, pinState: { kind: 'off' } })
    expect(titles()).toEqual([en['step.welcome'], en['step.providers'], en['step.pin'], en['step.ready']])
    expect(off.services.pin.fetch).toHaveBeenCalled()
    cleanup()
    await mountEntry({ reach: 'set-up', record: { reachSetUp: true }, pinState })
    expect(titles()).toEqual(FIRST)
  })

  it('builds every step for the guide opened from Settings, with Phone access and the PIN step where reach applies', async () => {
    await mountFull({ reach: 'off', record: { reachSetUp: false }, settings: settings({ done: true, plugins: ['@scope/p'] }) })
    expect(titles()).toEqual([en['step.welcome'], en['step.providers'], en['step.look'], en['step.agents'], en['step.plugins'], en['step.reach'], en['step.workspace'], en['step.ready']])
  })

  it('does not show a flow whose record arrives after the dialog was removed', async () => {
    let release: (record: SetupRecord) => void = () => {}
    const { unmount, container } = await mountEntry({ record: new Promise<SetupRecord>((resolve) => { release = resolve }) })
    unmount()
    await act(async () => { release(NO_RECORD) })
    expect(container.textContent).toBe('')
  })

  it('shows the preview notice on Welcome while it is owed, without Skip, and acknowledges it only on Continue', async () => {
    const notice = noticeFace()
    await mountEntry({ notice })
    expect(heading().textContent).toBe(en['step.welcome'])
    expect(screen.getByText('Delorun is a pre-release community fork.')).toBeTruthy()
    expect(titles()).toEqual(FIRST)
    expect(screen.getByText('Step 1 of 3')).toBeTruthy()
    expect(screen.queryByRole('button', { name: en.back })).toBeNull()
    expect(screen.queryByRole('button', { name: en.skip })).toBeNull()
    expect(notice.acknowledge).not.toHaveBeenCalled()
    await forward(1)
    expect(notice.acknowledge).toHaveBeenCalledOnce()
    expect(heading().textContent).toBe(en['step.providers'])
    await click(button(en.back))
    expect(screen.getByText('Delorun is a pre-release community fork.')).toBeTruthy()
  })

  it('names the dialog by the step\'s heading and takes focus onto it, and again at each step', async () => {
    await mountEntry()
    expect(screen.getByRole('dialog').getAttribute('aria-label')).toBe(en['step.welcome'])
    expect(document.activeElement).toBe(heading())
    await forward(1)
    expect(screen.getByRole('dialog').getAttribute('aria-label')).toBe(en['step.providers'])
    expect(document.activeElement).toBe(heading())
  })

  it('offers Skip on Welcome where the notice is already acknowledged, and where there is no notice', async () => {
    await mountEntry({ notice: noticeFace(true) })
    expect(screen.queryByText('Delorun is a pre-release community fork.')).toBeNull()
    expect(button(en.skip)).toBeTruthy()
  })

  it('holds the page\'s root inert while it shows and gives it back afterwards, and works without a root', async () => {
    const { unmount } = await mountEntry()
    expect(document.getElementById('root')?.inert).toBe(true)
    unmount()
    expect(document.getElementById('root')?.inert).toBe(false)
    document.getElementById('root')?.remove()
    await mountEntry()
    expect(screen.getByRole('dialog')).toBeTruthy()
  })

  it('closes the guide for this page only on Escape: nothing is kept in the home and the owed notice is not acknowledged', async () => {
    const notice = noticeFace()
    const { progress, complete, aside } = await mountEntry({ notice })
    await act(async () => { fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' }) })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(progress.set).not.toHaveBeenCalled()
    expect(aside.set).toHaveBeenCalledWith(true, false)
    expect(notice.acknowledge).not.toHaveBeenCalled()
    expect(complete).toHaveBeenCalled()
  })

  it('acknowledges the owed preview notice on Complete setup later, so the separate notice step does not show it again', async () => {
    const notice = noticeFace()
    const { aside } = await mountEntry({ notice })
    await click(button(en.later))
    expect(notice.acknowledge).toHaveBeenCalledOnce()
    expect(aside.set).toHaveBeenCalledWith(true)
  })

  it('goes forward and back, saving the step reached, and starts the chat in the default workspace from Ready', async () => {
    const { progress, startChat, complete, completeStep } = await mountEntry()
    await forward(1)
    expect(progress.value()?.step).toBe('providers')
    await forward(1)
    expect(progress.value()?.step).toBe('ready')
    await click(button(en.back))
    expect(progress.value()?.step).toBe('providers')
    await forward(1)
    expect(heading().textContent).toBe(en['step.ready'])
    expect(screen.queryByRole('button', { name: en.continue })).toBeNull()
    expect(screen.getByText(pathText(DEFAULT_PATH))).toBeTruthy()
    expect(startChat).not.toHaveBeenCalled()
    await click(button(en.start))
    expect(progress.value()).toMatchObject({ done: true, step: '' })
    expect(complete).toHaveBeenCalled()
    expect(completeStep).toHaveBeenCalledExactlyOnceWith(UPSTREAM_KEY_STEP)
    expect(UPSTREAM_KEY_STEP).toBe('deepseek-official')
    expect(startChat).toHaveBeenCalledExactlyOnceWith(DEFAULT_WORKSPACE, false)
  })

  describe('the original look', () => {
    /** Go to the Look step and open the original-look screen. */
    const openScreen = async () => {
      await forward(2)
      expect(heading().textContent).toBe(en['step.look'])
      await click(button(en['look.stock.open']))
    }

    it('lands back on Look with nothing chosen when the screen is cancelled', async () => {
      const useStockLook = vi.fn(() => Promise.resolve(true))
      await mountFull({ useStockLook })
      await openScreen()
      expect(screen.queryByRole('button', { name: en.continue })).toBeNull()
      await click(button(en['look.stock.no']))
      expect(heading().textContent).toBe(en['step.look'])
      expect(screen.getByRole('button', { name: en['look.stock.open'] })).toBeTruthy()
      expect(useStockLook).not.toHaveBeenCalled()
    })

    it('goes straight to the step after Look when confirmed, keeps the look until Finish, then applies it', async () => {
      const useStockLook = vi.fn(() => Promise.resolve(true))
      const { startChat } = await mountFull({ useStockLook })
      await openScreen()
      await click(button(en['look.stock.yes']))
      expect(heading().textContent).toBe(en['step.agents'])
      expect(useStockLook).not.toHaveBeenCalled()
      await forward(2)
      expect(heading().textContent).toBe(en['step.ready'])
      expect(screen.getByText(en['ready.stock'])).toBeTruthy()
      expect(useStockLook).not.toHaveBeenCalled()
      await click(button(en.start))
      await settle()
      expect(startChat).toHaveBeenCalledOnce()
      expect(useStockLook).toHaveBeenCalledOnce()
    })

    it('does not apply it on Complete setup later, and says nothing about it on Ready when it was not chosen', async () => {
      const useStockLook = vi.fn(() => Promise.resolve(true))
      await mountFull({ useStockLook })
      await openScreen()
      await click(button(en['look.stock.yes']))
      await click(button(en.later))
      await settle()
      expect(useStockLook).not.toHaveBeenCalled()
      cleanup()
      await mountFull({ useStockLook })
      await forward(5)
      expect(screen.queryByText(en['ready.stock'])).toBeNull()
    })
  })

  it('lists the steps with the current one marked and the earlier ones done', async () => {
    await mountEntry()
    await forward(1)
    const items = within(screen.getByRole('navigation')).getAllByRole('listitem')
    expect(items.map(each => each.getAttribute('data-state'))).toEqual(['done', 'current', 'next'])
    expect(items.map(each => each.getAttribute('aria-current'))).toEqual([null, 'step', null])
  })

  it('finishes later without opening a chat or marking the guide done, leaving upstream\'s key step to show', async () => {
    const { progress, complete, startChat, completeStep } = await mountEntry()
    await click(button(en.later))
    expect(progress.value()).toMatchObject({ done: false })
    expect(complete).toHaveBeenCalled()
    expect(startChat).not.toHaveBeenCalled()
    expect(completeStep).not.toHaveBeenCalled()
  })

  it('resumes at the step reached, and begins again when that step is gone or the notice is still owed', async () => {
    await mountEntry({ settings: settings({ step: 'providers' }) })
    expect(heading().textContent).toBe(en['step.providers'])
    cleanup()
    await mountFull({ settings: settings({ step: 'agents' }) })
    expect(heading().textContent).toBe(en['step.agents'])
    cleanup()
    await mountEntry({ settings: settings({ step: 'agents' }) })
    expect(heading().textContent).toBe(en['step.welcome'])
    cleanup()
    await mountEntry({ settings: settings({ step: 'start' }) })
    expect(heading().textContent).toBe(en['step.welcome'])
    cleanup()
    await mountEntry({ settings: settings({ step: 'agents' }), notice: noticeFace() })
    expect(heading().textContent).toBe(en['step.welcome'])
  })

  it('warns, and goes on, when progress cannot be saved', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await mountEntry({ writeResult: 'reject' })
    await forward(1)
    await settle()
    expect(heading().textContent).toBe(en['step.providers'])
    expect(warn).toHaveBeenCalledWith('delorun onboarding: progress was not saved', expect.any(Error))
  })
})

describe('which steps apply', () => {
  it('adds recommended plugins when only bundled rows are configured', async () => {
    await mountFull({ settings: settings({ optionalRows: ['delorun-cost-meter'] }) })
    expect(titles()).toContain(en['step.plugins'])
  })

  it('adds recommended plugins when packages are configured, and leaves the step out otherwise', async () => {
    await mountFull({ settings: settings({ plugins: ['@scope/p'] }) })
    expect(titles()).toEqual([en['step.welcome'], en['step.providers'], en['step.look'], en['step.agents'], en['step.plugins'], en['step.workspace'], en['step.ready']])
    await forward(4)
    expect(heading().textContent).toBe(en['step.plugins'])
    await settle()
    expect(screen.queryAllByRole('heading', { level: 4 })).toEqual([])
    expect(screen.queryByText('P')).toBeNull()
  })

  it.each<readonly [string, ReachState, SetupRecord, boolean]>([
    ['the home has reach and it is off', 'off', { reachSetUp: false, sections: ['reach'] }, true],
    ['the home has no reach', 'absent', { reachSetUp: false }, false],
    ['reach is set up', 'set-up', { reachSetUp: false }, false],
    ['the terminal setup set reach up', 'off', { reachSetUp: true }, false],
  ])('shows phone access, before Workspace, only while %s', async (_, reach, record, shown) => {
    await mountFull({ reach, record })
    expect(titles().includes(en['step.reach'])).toBe(shown)
    if (!shown) return
    expect(titles().slice(-3)).toEqual([en['step.reach'], en['step.workspace'], en['step.ready']])
    await forward(titles().indexOf(en['step.reach']))
    expect(heading().textContent).toBe(en['step.reach'])
  })

  it('leaves out the phone access step in a studio opened from a phone', async () => {
    await mountFull({ reach: 'remote', record: { reachSetUp: false } })
    expect(titles().includes(en['step.reach'])).toBe(false)
  })

  it('counts only the steps the person will see: a phone has the PIN step in place of phone access, and fewer where the terminal covered some', async () => {
    const { unmount } = await mountFull({ reach: 'off', record: { reachSetUp: false } })
    const withPhone = titles().length
    expect(screen.getByText(`Step 1 of ${String(withPhone)}`)).toBeTruthy()
    unmount()
    await mountFull({ reach: 'remote', record: { reachSetUp: false } })
    expect(screen.getByText(`Step 1 of ${String(withPhone)}`)).toBeTruthy()
    expect(titles()).toHaveLength(withPhone)
  })

  it('counts phone access as on in Ready when the terminal setup set it up', async () => {
    await mountFull({ reach: 'off', record: { reachSetUp: true } })
    await forward(titles().length - 1)
    expect(heading().textContent).toBe(en['step.ready'])
    const term = [...document.querySelectorAll('dt')].find(each => each.textContent === 'Phone access')
    expect(term?.nextElementSibling?.textContent).toBe('On')
  })

  it('leaves out the steps whose section the terminal covered, but never Welcome, Workspace or Ready', async () => {
    await mountFull({ settings: settings({ plugins: ['@scope/p'] }), record: { reachSetUp: false, sections: ['look', 'agents', 'plugins', 'welcome', 'workspace', 'ready'] } })
    expect(titles()).toEqual([en['step.welcome'], en['step.providers'], en['step.workspace'], en['step.ready']])
  })

  it('places steps other plugins added by their order, before Workspace, and hands them the way forward', async () => {
    const Body = ({ next }: { next: () => void }) => <button type="button" onClick={next}>Added body</button>
    const added: OnboardingStep = { id: 'thinking.reader', order: 600, title: () => 'Reader', component: Body }
    const { extra } = await mountFull({ extra: [added] })
    expect(titles()).toEqual([en['step.welcome'], en['step.providers'], en['step.look'], en['step.agents'], 'Reader', en['step.workspace'], en['step.ready']])
    await forward(4)
    expect(heading().textContent).toBe('Reader')
    await click(button('Added body'))
    expect(heading().textContent).toBe(en['step.workspace'])
    await click(button(en.back))
    expect(heading().textContent).toBe('Reader')
    await act(async () => { extra.set([]) })
    expect(titles()).not.toContain('Reader')
  })
})

describe('the workspace and the last button', () => {
  it('looks up the default workspace when the dialog opens and chooses it once it resolves', async () => {
    const start = startFace({ kind: 'checking' })
    await mountFull({ start })
    expect(start.resolve).toHaveBeenCalledOnce()
    await forward(4)
    expect(screen.getByText(en['start.lead.checking'])).toBeTruthy()
    await act(async () => { start.set({ kind: 'default', workspaceId: DEFAULT_WORKSPACE, path: DEFAULT_PATH }) })
    expect(screen.getByText(pathText(DEFAULT_PATH))).toBeTruthy()
  })

  it('starts the chat in a workspace the new-workspace dialog made, with what the folder holds', async () => {
    const start = startFace(undefined, { kind: 'created', workspaceId: 'workspace-2', path: '/home/person/app', folder: 'code' }, false)
    const { startChat } = await mountFull({ start })
    await forward(4)
    await click(screen.getByRole('radio', { name: en['workspace.mode.another'] }))
    await click(button(en['workspace.new']))
    expect(start.openNewWorkspace).toHaveBeenCalledOnce()
    await settle()
    await forward(1)
    expect(screen.getByText(pathText('/home/person/app'))).toBeTruthy()
    await click(button(en.start))
    expect(startChat).toHaveBeenCalledExactlyOnceWith('workspace-2', false)
  })

  it('starts the chat through the workspace UI where other workspaces exist but no default', async () => {
    const { startChat } = await mountEntry({ start: startFace({ kind: 'other' }) })
    await forward(2)
    await click(button(en.start))
    expect(startChat).toHaveBeenCalledExactlyOnceWith(undefined, false)
  })

  it('sends the person back to Workspace from Ready while no folder is chosen and there is no default', async () => {
    const start = startFace({ kind: 'none' }, { kind: 'created', workspaceId: 'workspace-2', path: '/home/person/app', folder: 'empty' })
    const { startChat, complete } = await mountEntry({ start })
    expect(titles()).toEqual([en['step.welcome'], en['step.providers'], en['step.workspace'], en['step.ready']])
    await forward(3)
    expect(screen.queryByRole('button', { name: en.start })).toBeNull()
    await click(button(en.chooseFolder))
    expect(heading().textContent).toBe(en['step.workspace'])
    expect([startChat.mock.calls.length, complete.mock.calls.length]).toEqual([0, 0])
    await click(button(en['workspace.new']))
    await settle()
    await forward(1)
    await click(button(en.start))
    expect(startChat).toHaveBeenCalledExactlyOnceWith('workspace-2', false)
  })

  it('keeps the dialog open and starts no chat when the new-workspace dialog is cancelled', async () => {
    const start = startFace({ kind: 'none' })
    const { startChat, complete } = await mountEntry({ start })
    await forward(2)
    await click(button(en['workspace.new']))
    await settle()
    expect(screen.queryByRole('alert')).toBeNull()
    expect(heading().textContent).toBe(en['step.workspace'])
    expect([startChat.mock.calls.length, complete.mock.calls.length]).toEqual([0, 0])
  })

  it('holds the default-workspace notice while it shows and drops it once the Workspace step said there is no default workspace', async () => {
    const start = startFace({ kind: 'none' })
    await mountEntry({ start })
    expect(start.holdNotice).toHaveBeenCalledOnce()
    expect(start.release).not.toHaveBeenCalled()
    await click(button(en.later))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(start.release).toHaveBeenCalledExactlyOnceWith(true)
  })

  it.each<readonly [string, StartTarget]>([
    ['the default workspace resolved', { kind: 'default', workspaceId: DEFAULT_WORKSPACE, path: DEFAULT_PATH }],
    ['the lookup had not settled', { kind: 'checking' }],
  ])('lets the held notice show when the dialog closes and %s', async (_, target) => {
    const start = startFace(target)
    await mountEntry({ start })
    await click(button(en.later))
    expect(start.release).toHaveBeenCalledExactlyOnceWith(false)
  })
})

describe('closing the dialog', () => {
  /** A message box in the page behind the dialog, as upstream's composer renders it. */
  const composer = () => {
    const box = document.createElement('div')
    box.setAttribute('data-composer-input', '')
    box.setAttribute('contenteditable', 'true')
    box.tabIndex = -1
    document.getElementById('root')?.append(box)
    return box
  }

  it('puts focus in the message box after Complete setup later, instead of leaving it on the page body', async () => {
    const box = composer()
    await mountEntry()
    expect((document.getElementById('root') as HTMLElement).inert).toBe(true)
    await click(button(en.later))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect((document.getElementById('root') as HTMLElement).inert).toBe(false)
    expect(document.activeElement).toBe(box)
  })

  it('puts focus on the page\'s first control when the page has no message box', async () => {
    const control = document.createElement('button')
    document.getElementById('root')?.append(control)
    await mountEntry()
    await click(button(en.later))
    expect(document.activeElement).toBe(control)
  })

  it('leaves focus where the page put it back', async () => {
    composer()
    const opener = document.createElement('button')
    document.getElementById('root')?.append(opener)
    opener.focus()
    await mountEntry()
    await click(button(en.later))
    expect(document.activeElement).toBe(opener)
  })
})

describe('Skip', () => {
  it('leaves only the step it is on and keeps the guide open', async () => {
    const { progress, complete } = await mountFull()
    await forward(2)
    const before = heading().textContent
    await click(button(en.skip))
    expect(heading().textContent).not.toBe(before)
    expect(screen.getByRole('dialog')).toBeTruthy()
    expect(complete).not.toHaveBeenCalled()
    expect(progress.value()).not.toMatchObject({ done: true })
  })
})

describe('finishing later and the last step', () => {
  it('sets the guide aside for the visit on Complete setup later, for the Finish setup chip to bring back', async () => {
    const { aside, progress } = await mountEntry()
    expect(aside.getSnapshot()).toBe(false)
    await click(button(en.later))
    expect(aside.getSnapshot()).toBe(true)
    expect(progress.value()).not.toMatchObject({ done: true })
    await act(async () => { aside.set(false) })
    await settle()
    expect(screen.getByRole('dialog')).toBeTruthy()
  })

  it('offers no Complete setup later on Ready', async () => {
    await mountEntry({ start: startFace({ kind: 'other' }) })
    expect(screen.getByRole('button', { name: en.later })).toBeTruthy()
    await forward(2)
    expect(heading().textContent).toBe(en['step.ready'])
    expect(screen.queryByRole('button', { name: en.later })).toBeNull()
  })

  it('keeps the workspace the chat is in when the guide was opened again and Workspace is skipped', async () => {
    const { startChat } = await mountEntry({ explicit: true })
    await forward(4)
    expect(heading().textContent).toBe(en['step.workspace'])
    await click(button(en.skip))
    expect(screen.getByText(en['ready.workspace.last'])).toBeTruthy()
    await click(button(en.start))
    expect(startChat).toHaveBeenCalledExactlyOnceWith(undefined, true)
  })

  it('uses the default workspace when the guide was opened again with no workspace and Workspace is skipped', async () => {
    const { startChat } = await mountEntry({ explicit: true, start: startFace(undefined, undefined, false) })
    await forward(4)
    expect(heading().textContent).toBe(en['step.workspace'])
    await click(button(en.skip))
    expect(screen.getByText(pathText(DEFAULT_PATH))).toBeTruthy()
    await click(button(en.start))
    expect(startChat).toHaveBeenCalledExactlyOnceWith(DEFAULT_WORKSPACE, false)
  })

  it('reopens at the saved step after Escape, and the chip\'s reopen shows the guide again', async () => {
    const { aside, complete } = await mountEntry()
    await forward(1)
    await act(async () => { fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' }) })
    expect(aside.getSnapshot()).toBe(true)
    expect(complete).toHaveBeenCalled()
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  describe.each<readonly [string, 'skip' | 'done', ReachState, string]>([
    ['Skip step', 'skip', 'off', 'Not set up'],
    ['"I\'ve done this" while reach still reads off', 'done', 'off', en['ready.reach.check']],
    ['"I\'ve done this" once reach reads on', 'done', 'set-up', 'On'],
  ])('phone access with %s', (_, action, reachNow, summary) => {
    it(`tells Ready: ${summary}`, async () => {
      const { host } = await mountFull({ reach: 'off', record: { reachSetUp: false }, tailscale: { state: 'signed-out' } })
      await forward(titles().indexOf(en['step.reach']))
      expect(heading().textContent).toBe(en['step.reach'])
      expect(screen.queryByRole('button', { name: en.continue })).toBeNull()
      host.reach.mockResolvedValue(reachNow)
      await click(button(action === 'skip' ? en.skip : en['reach.done']))
      await settle()
      await forward(1)
      // A computer reached from the phone adds the PIN and Workspace steps before Ready.
      for (const between of [en['step.pin'], en['step.workspace']]) {
        if (heading().textContent === between) await forward(1)
      }
      expect(heading().textContent).toBe(en['step.ready'])
      const term = [...document.querySelectorAll('dt')].find(each => each.textContent === 'Phone access')
      expect(term?.nextElementSibling?.textContent).toBe(summary)
    })
  })
})

describe('the welcome step and device access', () => {
  const ADDRESS = 'https://my-pc.example.ts.net'
  const message = () => screen.queryByText(en['welcome.devices'], { exact: false })

  it('names the address at the computer while device access is on', async () => {
    const { host } = await mountEntry({ reach: 'set-up', reachAddress: ADDRESS, record: { reachSetUp: true } })
    expect(host.reachAddress).toHaveBeenCalledOnce()
    expect(message()?.textContent).toBe(`${en['welcome.devices']} ${ADDRESS}`)
  })

  it.each<readonly [string, ReachState]>([['device access is off', 'off'], ['the home has no reach', 'absent']])('says nothing of it when %s, and never asks for the address', async (_, reach) => {
    const { host } = await mountEntry({ reach, reachAddress: ADDRESS, record: { reachSetUp: false } })
    expect(message()).toBeNull()
    expect(host.reachAddress).not.toHaveBeenCalled()
  })

  it('says nothing of it on a device that is already signed in', async () => {
    const { host } = await mountEntry({ reach: 'remote', reachAddress: ADDRESS, record: { reachSetUp: true } })
    expect(message()).toBeNull()
    expect(host.reachAddress).not.toHaveBeenCalled()
  })

  it('says nothing of it when the address cannot be read', async () => {
    await mountEntry({ reach: 'set-up', record: { reachSetUp: true } })
    expect(message()).toBeNull()
  })
})

describe('on a phone, the steps only the computer can do', () => {
  const PIN_LEAD = en['computer.why.pin']

  it('shows the PIN step as done on the computer, with the reason, before Workspace', async () => {
    await mountEntry({ reach: 'remote', record: { reachSetUp: false } })
    expect(titles()).toEqual([en['step.welcome'], en['step.providers'], en['computer.title.pin'], en['step.ready']])
    await forward(titles().indexOf(en['computer.title.pin']))
    expect(heading().textContent).toBe(en['computer.title.pin'])
    expect(screen.getByText(PIN_LEAD)).toBeTruthy()
    expect(screen.queryByLabelText(en['pin.setup.pinLabel'])).toBeNull()
  })

  it('records the step as deferred and goes on when the person chooses Do it on my computer', async () => {
    const view = await mountEntry({ reach: 'remote', record: { reachSetUp: false } })
    await forward(titles().indexOf(en['computer.title.pin']))
    await click(button(en['computer.defer']))
    expect(view.host.defer).toHaveBeenCalledWith('pin', true)
    expect(heading().textContent).toBe(en['step.ready'])
  })

  it('leaves the step undone and unrecorded on Skip', async () => {
    const view = await mountEntry({ reach: 'remote', record: { reachSetUp: false } })
    await forward(titles().indexOf(en['computer.title.pin']))
    await click(button(en.skip))
    expect(view.host.defer).not.toHaveBeenCalled()
    expect(heading().textContent).toBe(en['step.ready'])
  })

  it.each<readonly [string, { readonly record?: SetupRecord; readonly pinState?: object }]>([
    ['it was already deferred', { record: { reachSetUp: false, deferred: ['pin'] } }],
    ['PIN mode is already on', { pinState: { kind: 'on', secret: 'pin', idleMinutes: 15, paused: false, unlock: null } }],
  ])('leaves the step out when %s', async (_, options) => {
    await mountEntry({ reach: 'remote', record: { reachSetUp: false }, ...options })
    expect(titles().includes(en['computer.title.pin'])).toBe(false)
  })

  it('does not show the computer-only step at the computer', async () => {
    await mountEntry({ reach: 'off', record: { reachSetUp: false } })
    expect(document.querySelector('[data-computer-only]')).toBeNull()
  })
})

describe('at the computer, opened from the Finish setup entry', () => {
  it('shows only the deferred steps and no Welcome or Ready', async () => {
    await mountEntry({ explicit: true, deferredOnly: true, settings: settings({ done: true }), reach: 'set-up', record: { reachSetUp: false, deferred: ['pin'] } })
    expect(titles()).toEqual([en['step.pin']])
  })

  it('offers Complete setup later on its only step, since Skip has nothing after it', async () => {
    const view = await mountEntry({ explicit: true, deferredOnly: true, settings: settings({ done: true }), reach: 'set-up', record: { reachSetUp: false, deferred: ['pin'] } })
    await click(button(en.later))
    expect(view.aside.getSnapshot()).toBe(true)
    expect(view.deferredOnly.getSnapshot()).toBe(false)
  })

  it('closes after the last deferred step without starting a chat or saving the place', async () => {
    const view = await mountEntry({ explicit: true, deferredOnly: true, settings: settings({ done: true }), reach: 'set-up', record: { reachSetUp: false, deferred: ['pin'] } })
    await click(button(en.continue))
    expect(view.startChat).not.toHaveBeenCalled()
    expect(view.progress.set).not.toHaveBeenCalled()
    expect(view.aside.getSnapshot()).toBe(true)
    expect(view.deferredOnly.getSnapshot()).toBe(false)
  })

  it('lists phone access then the PIN step, in the guide\'s order', async () => {
    await mountEntry({ explicit: true, deferredOnly: true, settings: settings({ done: true }), reach: 'off', record: { reachSetUp: false, deferred: ['pin', 'reach'] } })
    expect(titles()).toEqual([en['step.reach'], en['step.pin']])
  })
})

describe('the plugin downloads row in the footer', () => {
  const phone = (matches: boolean) => { vi.stubGlobal('matchMedia', () => ({ matches, addEventListener: () => {}, removeEventListener: () => {} })) }
  const queue = () => createFakeDownloadsSource([{ key: 'a', title: 'Alpha', state: 'downloading', receivedBytes: 1, totalBytes: 4 }])
  afterEach(() => { vi.unstubAllGlobals() })

  it('shows one line above Back and Continue at phone width while the queue has plugins', async () => {
    phone(true)
    const release = provideDownloadsSource(queue())
    await mountEntry()
    expect(screen.getByRole('button', { name: /1 left to install/ })).toBeTruthy()
    release()
  })

  it('shows nothing at a computer width', async () => {
    phone(false)
    const release = provideDownloadsSource(queue())
    await mountEntry()
    expect(screen.queryByRole('button', { name: /left to install/ })).toBeNull()
    release()
  })

  it('shows nothing when the queue is empty', async () => {
    phone(true)
    await mountEntry()
    expect(screen.queryByRole('button', { name: /left to install/ })).toBeNull()
  })
})
