// @vitest-environment jsdom
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OnboardingStepEntry, type OnboardingStepEntryProps } from '../src/client/Onboarding.tsx'
import { en } from '../src/client/locales.ts'
import type { OnboardingStep, ReachState, StartTarget } from '../src/client/types.ts'
import type { OnboardingSettings } from '../src/config.ts'
import { NO_RECORD, type SetupRecord } from '../src/wire.ts'
import { DEFAULT_WORKSPACE, liveForm, noticeFace, reachFace, settings, startFace, stepServices, t } from './fixtures.client.ts'

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

const settle = async () => { await act(async () => { await Promise.resolve() }) }
const click = async (element: HTMLElement) => { await act(async () => { fireEvent.click(element) }) }
const button = (name: string) => screen.getByRole('button', { name })

interface Options {
  readonly settings?: OnboardingSettings | undefined
  readonly status?: 'loading' | 'ready' | 'unavailable'
  readonly explicit?: boolean
  readonly record?: SetupRecord | Promise<SetupRecord>
  readonly notice?: ReturnType<typeof noticeFace>
  readonly extra?: readonly OnboardingStep[]
  readonly writeResult?: boolean | 'reject'
  readonly reach?: ReachState
  readonly start?: ReturnType<typeof startFace>
}

/** The step entry over fakes, as the Settings shell mounts it. */
async function mountEntry(options: Options = {}) {
  const progress = liveForm<OnboardingSettings>(options.settings ?? settings(), {
    status: options.status ?? 'ready', ...options.writeResult === undefined ? {} : { result: options.writeResult },
  })
  const extra = createSnapshotStore<readonly OnboardingStep[]>(options.extra ?? [])
  const complete = vi.fn()
  const startChat = vi.fn((_workspaceId?: string) => Promise.resolve())
  const loadRecord = vi.fn(() => Promise.resolve(options.record ?? NO_RECORD))
  const reach = reachFace(options.reach)
  const start = options.start ?? startFace()
  const services = stepServices({ notice: options.notice?.face, reach: reach.face, start: start.face })
  const props = {
    t, complete, ...options.explicit === undefined ? {} : { explicit: options.explicit },
    progress: progress.form, extra, loadRecord, services, startChat,
  } satisfies OnboardingStepEntryProps
  const view = render(<OnboardingStepEntry {...props} />)
  await settle()
  await settle()
  return { ...view, progress, extra, complete, startChat, loadRecord, services, reach, start }
}

const titles = () => within(screen.getByRole('navigation')).getAllByRole('listitem').map(each => each.textContent?.replace(/^(\d+|✓)/, ''))
const heading = () => screen.getByRole('heading', { level: 2 })

describe('a profile that has finished onboarding', () => {
  it('completes upstream\'s step at once and shows nothing, without asking the harness for the record', async () => {
    const { complete, loadRecord, container } = await mountEntry({ settings: settings({ done: true }) })
    expect(complete).toHaveBeenCalledOnce()
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(container.textContent).toBe('')
    expect(loadRecord).not.toHaveBeenCalled()
  })

  it('completes at once when the settings are not served, and waits while they load', async () => {
    const unavailable = await mountEntry({ status: 'unavailable', settings: settings() })
    expect(unavailable.complete).toHaveBeenCalledOnce()
    cleanup()
    const loading = await mountEntry({ status: 'loading', settings: undefined })
    expect(loading.complete).not.toHaveBeenCalled()
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('shows the flow again, from the first screen after the notice, when Settings reopens it, and keeps the finished mark until the end', async () => {
    const notice = noticeFace()
    const { complete, progress } = await mountEntry({ settings: settings({ done: true }), explicit: true, notice })
    expect(screen.getByRole('dialog')).toBeTruthy()
    expect(heading().textContent).toBe(en['step.look'])
    expect(titles()).toEqual([en['step.look'], en['step.agents'], en['step.start']])
    expect(complete).not.toHaveBeenCalled()
    expect(progress.set).not.toHaveBeenCalled()
    await click(button(en.continue))
    expect(heading().textContent).toBe(en['step.agents'])
    expect(notice.acknowledge).not.toHaveBeenCalled()
  })
})

describe('the first run', () => {
  it('waits for the record before it shows anything', async () => {
    let release: (record: SetupRecord) => void = () => {}
    const { container } = await mountEntry({ record: new Promise<SetupRecord>((resolve) => { release = resolve }) })
    expect(container.textContent).toBe('')
    await act(async () => { release({ reachSetUp: false }) })
    expect(screen.getByRole('dialog')).toBeTruthy()
  })

  it('does not show a flow whose record arrives after the dialog was removed', async () => {
    let release: (record: SetupRecord) => void = () => {}
    const { unmount, container } = await mountEntry({ record: new Promise<SetupRecord>((resolve) => { release = resolve }) })
    unmount()
    await act(async () => { release(NO_RECORD) })
    expect(container.textContent).toBe('')
  })

  it('starts on the preview notice, shows its copy from the Privacy dictionary and acknowledges it only on Continue', async () => {
    const notice = noticeFace()
    await mountEntry({ notice })
    expect(heading().textContent).toBe('Preview')
    expect(screen.getByText('Delo is a pre-release community fork.')).toBeTruthy()
    expect(titles()).toEqual([en['step.notice'], en['step.look'], en['step.agents'], en['step.start']])
    expect(screen.getByText('Step 1 of 4')).toBeTruthy()
    expect(screen.queryByRole('button', { name: en.back })).toBeNull()
    expect(screen.queryByRole('button', { name: en.skip })).toBeNull()
    expect(notice.acknowledge).not.toHaveBeenCalled()
    await click(button(en.continue))
    expect(notice.acknowledge).toHaveBeenCalledOnce()
    expect(heading().textContent).toBe(en['step.look'])
  })

  it('names the dialog by the step\'s heading and takes focus onto it, and again at each step', async () => {
    await mountEntry({ notice: noticeFace() })
    expect(screen.getByRole('dialog').getAttribute('aria-label')).toBe('Preview')
    expect(document.activeElement).toBe(heading())
    await click(button(en.continue))
    expect(screen.getByRole('dialog').getAttribute('aria-label')).toBe(en['step.look'])
    expect(document.activeElement).toBe(heading())
  })

  it('starts on language and look where the notice is already acknowledged, and where there is no notice', async () => {
    const acknowledged = noticeFace(true)
    await mountEntry({ notice: acknowledged })
    expect(heading().textContent).toBe(en['step.look'])
    expect(titles()).not.toContain(en['step.notice'])
    cleanup()
    await mountEntry()
    expect(heading().textContent).toBe(en['step.look'])
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

  it('is closed by its buttons only: Escape and a click on the mask change nothing', async () => {
    const { progress, complete } = await mountEntry({ notice: noticeFace() })
    await act(async () => { fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' }) })
    const mask = screen.getByRole('dialog').previousElementSibling as HTMLElement
    await click(mask)
    expect(screen.getByRole('dialog')).toBeTruthy()
    expect(progress.set).not.toHaveBeenCalled()
    expect(complete).not.toHaveBeenCalled()
  })

  it('goes forward and back, saving the step reached, and ends on the Start step with a button that says what it does', async () => {
    const { progress, startChat, complete } = await mountEntry()
    expect(screen.getByText('Step 1 of 3')).toBeTruthy()
    expect(screen.queryByRole('button', { name: en.back })).toBeNull()
    await click(button(en.continue))
    expect(progress.value()?.step).toBe('agents')
    await click(button(en.back))
    expect(progress.value()?.step).toBe('look')
    await click(button(en.continue))
    await click(button(en.continue))
    expect(heading().textContent).toBe(en['step.start'])
    expect(screen.queryByRole('button', { name: en.continue })).toBeNull()
    expect(startChat).not.toHaveBeenCalled()
    await click(button(en.start))
    expect(progress.value()).toMatchObject({ done: true, step: '' })
    expect(complete).toHaveBeenCalled()
    expect(startChat).toHaveBeenCalledExactlyOnceWith()
  })

  it('lists the steps with the current one marked and the earlier ones done', async () => {
    await mountEntry()
    await click(button(en.continue))
    const items = within(screen.getByRole('navigation')).getAllByRole('listitem')
    expect(items.map(each => each.getAttribute('data-state'))).toEqual(['done', 'current', 'next'])
    expect(items.map(each => each.getAttribute('aria-current'))).toEqual([null, 'step', null])
    expect(items[0]?.textContent?.startsWith('✓')).toBe(true)
  })

  it('skips without opening a chat, and records that onboarding is done', async () => {
    const { progress, complete, startChat } = await mountEntry()
    await click(button(en.skip))
    expect(progress.value()).toMatchObject({ done: true, step: '' })
    expect(complete).toHaveBeenCalled()
    expect(startChat).not.toHaveBeenCalled()
  })

  it('resumes at the step reached, and begins again when that step is gone or the notice is still owed', async () => {
    await mountEntry({ settings: settings({ step: 'agents' }) })
    expect(heading().textContent).toBe(en['step.agents'])
    cleanup()
    await mountEntry({ settings: settings({ step: 'vanished' }) })
    expect(heading().textContent).toBe(en['step.look'])
    cleanup()
    await mountEntry({ settings: settings({ step: 'agents' }), notice: noticeFace() })
    expect(heading().textContent).toBe('Preview')
  })

  it('warns, and goes on, when progress cannot be saved', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await mountEntry({ writeResult: 'reject' })
    await click(button(en.continue))
    await settle()
    expect(heading().textContent).toBe(en['step.agents'])
    expect(warn).toHaveBeenCalledWith('delo onboarding: progress was not saved', expect.any(Error))
  })
})

describe('which steps apply', () => {
  it('adds recommended plugins when packages are configured, and leaves the step out otherwise', async () => {
    await mountEntry({ settings: settings({ plugins: ['@scope/p'] }) })
    expect(titles()).toEqual([en['step.look'], en['step.agents'], en['step.plugins'], en['step.start']])
    await click(button(en.continue))
    await click(button(en.continue))
    expect(heading().textContent).toBe(en['step.plugins'])
    expect(screen.getByRole('heading', { level: 4 }).textContent).toBe('@scope/p')
    cleanup()
    await mountEntry()
    expect(titles()).not.toContain(en['step.plugins'])
  })

  it('leaves out reach where no reach service says it is available, whatever the terminal setup recorded', async () => {
    await mountEntry({ reach: 'unavailable', record: { reachSetUp: false, sections: ['reach'] } })
    expect(titles()).not.toContain(en['step.reach'])
    expect(screen.getByText('Step 1 of 3')).toBeTruthy()
  })

  it('shows reach, before Start, where the reach service is available and reach is not set up, including when setup only listed it as skipped', async () => {
    await mountEntry({ reach: 'available', record: { reachSetUp: false, sections: ['reach', 'start'] } })
    expect(titles()).toEqual([en['step.look'], en['step.agents'], en['step.reach'], en['step.start']])
    await click(button(en.continue))
    await click(button(en.continue))
    expect(heading().textContent).toBe(en['step.reach'])
    expect(screen.getByText(en['reach.limits'])).toBeTruthy()
  })

  it('leaves out reach when the terminal setup set it up, or the reach service says it is', async () => {
    await mountEntry({ reach: 'available', record: { reachSetUp: true } })
    expect(titles()).not.toContain(en['step.reach'])
    cleanup()
    await mountEntry({ reach: 'set-up', record: { reachSetUp: false } })
    expect(titles()).not.toContain(en['step.reach'])
  })

  it('follows the reach service as it comes and goes while the dialog is open', async () => {
    const { reach } = await mountEntry({ reach: 'unavailable' })
    expect(titles()).not.toContain(en['step.reach'])
    await act(async () => { reach.set('available') })
    expect(titles()).toContain(en['step.reach'])
    await act(async () => { reach.set('unavailable') })
    expect(titles()).not.toContain(en['step.reach'])
  })

  it('leaves out the steps whose section the terminal covered, but never the notice or start', async () => {
    await mountEntry({ settings: settings({ plugins: ['@scope/p'] }), record: { reachSetUp: false, sections: ['look', 'agents', 'plugins', 'notice'] }, notice: noticeFace() })
    expect(titles()).toEqual([en['step.notice'], en['step.start']])
  })

  it('places steps other plugins added by their order, before Start, and hands them the way forward', async () => {
    const Body = ({ next }: { next: () => void }) => <button type="button" onClick={next}>Added body</button>
    const added: OnboardingStep = { id: 'thinking.reader', order: 600, title: () => 'Reader', component: Body }
    const { extra } = await mountEntry({ extra: [added] })
    expect(titles()).toEqual([en['step.look'], en['step.agents'], 'Reader', en['step.start']])
    await click(button(en.continue))
    await click(button(en.continue))
    expect(heading().textContent).toBe('Reader')
    await click(button('Added body'))
    expect(heading().textContent).toBe(en['step.start'])
    await click(button(en.back))
    expect(heading().textContent).toBe('Reader')
    await act(async () => { extra.set([]) })
    expect(titles()).not.toContain('Reader')
    expect(heading().textContent).toBe(en['step.start'])
  })

  it('uses the agents step\'s bundle installer and refreshes it when the step opens', async () => {
    const { services } = await mountEntry()
    await click(button(en.continue))
    expect(services.spies.refresh).toHaveBeenCalled()
  })
})

describe('the last button', () => {
  const toStart = async () => {
    await click(button(en.continue))
    await click(button(en.continue))
  }

  it('looks up the default workspace when the dialog opens, so the Start step already knows', async () => {
    const { start } = await mountEntry()
    expect(start.resolve).toHaveBeenCalledOnce()
  })

  it.each<readonly [string, 'checking' | 'default' | 'other']>([
    ['is still being looked up', 'checking'],
    ['resolved', 'default'],
    ['is not there but others are', 'other'],
  ])('starts a chat, without a folder chooser, where the default workspace %s', async (_, kind) => {
    const start = startFace(kind === 'default' ? { kind, workspaceId: DEFAULT_WORKSPACE } : { kind })
    const { startChat, complete } = await mountEntry({ start })
    await toStart()
    await click(button(en.start))
    expect(start.chooseFolder).not.toHaveBeenCalled()
    expect(startChat).toHaveBeenCalledExactlyOnceWith()
    expect(complete).toHaveBeenCalled()
  })

  it('says it chooses a folder where no default workspace resolves, and does not start a chat until one is chosen', async () => {
    const start = startFace({ kind: 'none' }, { kind: 'chosen', workspaceId: DEFAULT_WORKSPACE })
    const { startChat, progress } = await mountEntry({ start })
    await toStart()
    expect(screen.queryByRole('button', { name: en.start })).toBeNull()
    expect(startChat).not.toHaveBeenCalled()
    await click(button(en.chooseFolder))
    expect(start.chooseFolder).toHaveBeenCalledOnce()
    expect(progress.value()).toMatchObject({ done: true, step: '' })
    expect(startChat).toHaveBeenCalledExactlyOnceWith(DEFAULT_WORKSPACE)
  })

  it('closes the dialog and hands over to the sidebar\'s in-page folder flow where the host has no native chooser', async () => {
    const start = startFace({ kind: 'none' }, { kind: 'in-page' })
    const { startChat, complete, progress } = await mountEntry({ start })
    await toStart()
    await click(button(en.chooseFolder))
    expect(progress.value()).toMatchObject({ done: true, step: '' })
    expect(complete).toHaveBeenCalled()
    expect(start.openInPage).toHaveBeenCalledOnce()
    expect(startChat).not.toHaveBeenCalled()
  })

  it('keeps the dialog open and the button ready when the chooser is closed without a folder', async () => {
    const start = startFace({ kind: 'none' }, { kind: 'cancelled' })
    const { startChat, complete, progress } = await mountEntry({ start })
    await toStart()
    await click(button(en.chooseFolder))
    expect(startChat).not.toHaveBeenCalled()
    expect(complete).not.toHaveBeenCalled()
    expect(progress.value()?.done).toBe(false)
    expect((button(en.chooseFolder) as HTMLButtonElement).disabled).toBe(false)
  })

  it('opens the workspace UI\'s own New Session when the chooser cannot run, and disables the button while it is open', async () => {
    const start = startFace({ kind: 'none' })
    let release: (choice: { kind: 'unavailable' }) => void = () => {}
    start.chooseFolder.mockImplementationOnce(() => new Promise((resolve) => { release = resolve }))
    const { startChat } = await mountEntry({ start })
    await toStart()
    await click(button(en.chooseFolder))
    expect((button(en.chooseFolder) as HTMLButtonElement).disabled).toBe(true)
    await act(async () => { release({ kind: 'unavailable' }) })
    expect(startChat).toHaveBeenCalledExactlyOnceWith(undefined)
  })

  it('holds the default-workspace notice while it shows and drops it once the Start step said there is no default workspace', async () => {
    const start = startFace({ kind: 'none' }, { kind: 'chosen', workspaceId: DEFAULT_WORKSPACE })
    await mountEntry({ start })
    expect(start.holdNotice).toHaveBeenCalledOnce()
    await toStart()
    expect(start.release).not.toHaveBeenCalled()
    await click(button(en.chooseFolder))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(start.release).toHaveBeenCalledExactlyOnceWith(true)
  })

  it.each<readonly [string, StartTarget, () => Promise<void>]>([
    ['the default workspace resolved', { kind: 'default', workspaceId: DEFAULT_WORKSPACE }, async () => { await toStart(); await click(button(en.start)) }],
    ['the person skipped before the Start step', { kind: 'none' }, () => click(button(en.skip))],
  ])('lets the held notice show when the dialog closes and %s', async (_, target, close) => {
    const start = startFace(target)
    await mountEntry({ start })
    await close()
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(start.release).toHaveBeenCalledExactlyOnceWith(false)
  })

  it('changes the button when the lookup settles while the person is on the Start step', async () => {
    const start = startFace({ kind: 'checking' })
    await mountEntry({ start })
    await toStart()
    expect(button(en.start)).toBeTruthy()
    await act(async () => { start.set({ kind: 'none' }) })
    expect(button(en.chooseFolder)).toBeTruthy()
    expect(screen.getByText(en['start.lead.none'])).toBeTruthy()
  })
})
