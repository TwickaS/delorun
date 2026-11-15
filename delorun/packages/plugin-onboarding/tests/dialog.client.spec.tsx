// @vitest-environment jsdom
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { WorkspaceId } from '@deepseek-ai/dsh-api-workspace-controller/client'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OnboardingStepEntry, UPSTREAM_KEY_STEP, type OnboardingStepEntryProps } from '../src/client/Onboarding.tsx'
import { en } from '../src/client/locales.ts'
import type { FolderChoice, OnboardingStep, ReachState, StartTarget } from '../src/client/types.ts'
import type { OnboardingSettings } from '../src/config.ts'
import { NO_RECORD, type SetupRecord } from '../src/wire.ts'
import { DEFAULT_PATH, DEFAULT_WORKSPACE, hostFake, liveForm, noticeFace, settings, startFace, stepServices, t } from './fixtures.client.ts'

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
  const completeStep = vi.fn((_id: string) => {})
  const startChat = vi.fn((_workspaceId?: string, _folder?: string) => Promise.resolve())
  const loadRecord = vi.fn(() => Promise.resolve(options.record ?? NO_RECORD))
  const host = hostFake({ reach: options.reach ?? 'absent' })
  const start = options.start ?? startFace()
  const services = stepServices({ notice: options.notice?.face, host: host.host, start: start.face })
  const props = {
    t, complete, completeStep, renderSection: (id: string) => `section ${id}`, ...options.explicit === undefined ? {} : { explicit: options.explicit },
    progress: progress.form, extra, loadRecord, services, startChat,
  } satisfies OnboardingStepEntryProps
  const view = render(<OnboardingStepEntry {...props} />)
  await settle()
  await settle()
  return { ...view, progress, extra, complete, completeStep, startChat, loadRecord, services, host, start }
}

/** The steps a first run shows with nothing configured. */
const BASE = [en['step.welcome'], en['step.providers'], en['step.look'], en['step.agents'], en['step.workspace'], en['step.ready']]

/** Press Continue a number of times. */
// The Models step has its own buttons until its summary: leaving it by Skip for now stands in for Continue.
const forward = async (times: number) => {
  for (let n = 0; n < times; n++) {
    await settle()
    await click(screen.queryByRole('button', { name: en.continue }) ?? button(en['providers.skip']))
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
    expect(titles()).toEqual(BASE)
    expect(screen.getByText('Step 1 of 6')).toBeTruthy()
    expect(screen.queryByRole('button', { name: en.back })).toBeNull()
    expect(screen.queryByRole('button', { name: en.skip })).toBeNull()
    expect(notice.acknowledge).not.toHaveBeenCalled()
    await forward(2)
    expect(notice.acknowledge).toHaveBeenCalledOnce()
    expect(heading().textContent).toBe(en['step.look'])
    expect(button(en.skip)).toBeTruthy()
    await click(button(en.back))
    await click(button(en.back))
    expect(screen.getByText('Delorun is a pre-release community fork.')).toBeTruthy()
  })

  it('names the dialog by the step\'s heading and takes focus onto it, and again at each step', async () => {
    await mountEntry()
    expect(screen.getByRole('dialog').getAttribute('aria-label')).toBe(en['step.welcome'])
    expect(document.activeElement).toBe(heading())
    await forward(2)
    expect(screen.getByRole('dialog').getAttribute('aria-label')).toBe(en['step.look'])
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

  it('is closed by its buttons only: Escape and a click on the mask change nothing', async () => {
    const { progress, complete } = await mountEntry({ notice: noticeFace() })
    await act(async () => { fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' }) })
    const mask = screen.getByRole('dialog').previousElementSibling as HTMLElement
    await click(mask)
    expect(screen.getByRole('dialog')).toBeTruthy()
    expect(progress.set).not.toHaveBeenCalled()
    expect(complete).not.toHaveBeenCalled()
  })

  it('goes forward and back, saving the step reached, and starts the chat in the default workspace from Ready', async () => {
    const { progress, startChat, complete, completeStep } = await mountEntry()
    await forward(1)
    expect(progress.value()?.step).toBe('providers')
    await forward(1)
    expect(progress.value()?.step).toBe('look')
    await click(button(en.back))
    expect(progress.value()?.step).toBe('providers')
    await forward(4)
    expect(heading().textContent).toBe(en['step.ready'])
    expect(screen.queryByRole('button', { name: en.continue })).toBeNull()
    expect(screen.getByText(DEFAULT_PATH)).toBeTruthy()
    expect(startChat).not.toHaveBeenCalled()
    await click(button(en.start))
    expect(progress.value()).toMatchObject({ done: true, step: '' })
    expect(complete).toHaveBeenCalled()
    expect(completeStep).toHaveBeenCalledExactlyOnceWith(UPSTREAM_KEY_STEP)
    expect(UPSTREAM_KEY_STEP).toBe('deepseek-official')
    expect(startChat).toHaveBeenCalledExactlyOnceWith(DEFAULT_WORKSPACE, undefined)
  })

  it('lists the steps with the current one marked and the earlier ones done', async () => {
    await mountEntry()
    await forward(1)
    const items = within(screen.getByRole('navigation')).getAllByRole('listitem')
    expect(items.map(each => each.getAttribute('data-state'))).toEqual(['done', 'current', 'next', 'next', 'next', 'next'])
    expect(items.map(each => each.getAttribute('aria-current'))).toEqual([null, 'step', null, null, null, null])
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
    await mountEntry({ settings: settings({ step: 'agents' }) })
    expect(heading().textContent).toBe(en['step.agents'])
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
    await forward(2)
    await settle()
    expect(heading().textContent).toBe(en['step.look'])
    expect(warn).toHaveBeenCalledWith('delorun onboarding: progress was not saved', expect.any(Error))
  })
})

describe('which steps apply', () => {
  it('adds recommended plugins when only bundled rows are configured', async () => {
    await mountEntry({ settings: settings({ optionalRows: ['delorun-cost-meter'] }) })
    expect(titles()).toContain(en['step.plugins'])
  })

  it('adds recommended plugins when packages are configured, and leaves the step out otherwise', async () => {
    await mountEntry({ settings: settings({ plugins: ['@scope/p'] }) })
    expect(titles()).toEqual([en['step.welcome'], en['step.providers'], en['step.look'], en['step.agents'], en['step.plugins'], en['step.workspace'], en['step.ready']])
    await forward(4)
    expect(heading().textContent).toBe(en['step.plugins'])
    await settle()
    expect(screen.getByRole('heading', { level: 4 }).textContent).toBe('P')
  })

  it.each<readonly [string, ReachState, SetupRecord, boolean]>([
    ['the home has reach and it is off', 'off', { reachSetUp: false, sections: ['reach'] }, true],
    ['the home has no reach', 'absent', { reachSetUp: false }, false],
    ['reach is set up', 'set-up', { reachSetUp: false }, false],
    ['the terminal setup set reach up', 'off', { reachSetUp: true }, false],
  ])('shows phone access, before Workspace, only while %s', async (_, reach, record, shown) => {
    await mountEntry({ reach, record })
    expect(titles().includes(en['step.reach'])).toBe(shown)
    if (!shown) return
    expect(titles().slice(-3)).toEqual([en['step.reach'], en['step.workspace'], en['step.ready']])
    await forward(titles().indexOf(en['step.reach']))
    expect(heading().textContent).toBe(en['step.reach'])
  })

  it('leaves out the phone access step in a studio opened from a phone', async () => {
    await mountEntry({ reach: 'remote', record: { reachSetUp: false } })
    expect(titles().includes(en['step.reach'])).toBe(false)
  })

  it('counts phone access as on in Ready when the terminal setup set it up', async () => {
    await mountEntry({ reach: 'off', record: { reachSetUp: true } })
    await forward(titles().length - 1)
    expect(heading().textContent).toBe(en['step.ready'])
    const term = [...document.querySelectorAll('dt')].find(each => each.textContent === 'Phone access')
    expect(term?.nextElementSibling?.textContent).toBe('On')
  })

  it('leaves out the steps whose section the terminal covered, but never Welcome, Workspace or Ready', async () => {
    await mountEntry({ settings: settings({ plugins: ['@scope/p'] }), record: { reachSetUp: false, sections: ['look', 'agents', 'plugins', 'welcome', 'workspace', 'ready'] } })
    expect(titles()).toEqual([en['step.welcome'], en['step.providers'], en['step.workspace'], en['step.ready']])
  })

  it('places steps other plugins added by their order, before Workspace, and hands them the way forward', async () => {
    const Body = ({ next }: { next: () => void }) => <button type="button" onClick={next}>Added body</button>
    const added: OnboardingStep = { id: 'thinking.reader', order: 600, title: () => 'Reader', component: Body }
    const { extra } = await mountEntry({ extra: [added] })
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
    await mountEntry({ start })
    expect(start.resolve).toHaveBeenCalledOnce()
    await forward(4)
    expect(screen.getByText(en['start.lead.checking'])).toBeTruthy()
    await act(async () => { start.set({ kind: 'default', workspaceId: DEFAULT_WORKSPACE, path: DEFAULT_PATH }) })
    expect(screen.getByText(DEFAULT_PATH)).toBeTruthy()
  })

  it('starts the chat in a folder the Workspace step added, with what the folder holds', async () => {
    const start = startFace(undefined, { kind: 'chosen', workspaceId: 'workspace-2' as WorkspaceId, path: '/home/person/app', folder: 'code' })
    const { startChat } = await mountEntry({ start })
    await forward(4)
    await click(screen.getByRole('radio', { name: en['workspace.mode.folder'] }))
    await click(button(en['workspace.folder.choose']))
    await settle()
    await forward(1)
    expect(screen.getByText('/home/person/app')).toBeTruthy()
    await click(button(en.start))
    expect(startChat).toHaveBeenCalledExactlyOnceWith('workspace-2', 'code')
  })

  it('starts the chat through the workspace UI where other workspaces exist but no default', async () => {
    const { startChat } = await mountEntry({ start: startFace({ kind: 'other' }) })
    await forward(5)
    await click(button(en.start))
    expect(startChat).toHaveBeenCalledExactlyOnceWith(undefined, undefined)
  })

  it('sends the person back to Workspace from Ready while no folder is chosen and there is no default', async () => {
    const start = startFace({ kind: 'none' }, { kind: 'chosen', workspaceId: 'workspace-2' as WorkspaceId, path: '/home/person/app', folder: 'empty' })
    const { startChat, complete } = await mountEntry({ start })
    await forward(5)
    expect(screen.queryByRole('button', { name: en.start })).toBeNull()
    await click(button(en.chooseFolder))
    expect(heading().textContent).toBe(en['step.workspace'])
    expect([startChat.mock.calls.length, complete.mock.calls.length]).toEqual([0, 0])
    await click(button(en['workspace.folder.choose']))
    await settle()
    await forward(1)
    await click(button(en.start))
    expect(startChat).toHaveBeenCalledExactlyOnceWith('workspace-2', 'empty')
  })

  it.each<readonly [string, FolderChoice, string]>([
    ['refuses the home directory', { kind: 'refused', problem: 'home-directory' }, en['problem.home-directory']],
    ['cannot add the folder', { kind: 'failed' }, en['problem.failed']],
  ])('keeps the dialog open and says why when the harness %s', async (_, choice, text) => {
    const start = startFace({ kind: 'none' }, choice)
    const { startChat, complete } = await mountEntry({ start })
    await forward(4)
    await click(button(en['workspace.folder.choose']))
    await settle()
    expect(screen.getByRole('alert').textContent).toBe(`✕${text}`)
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

  it('puts focus in the message box after Finish later, instead of leaving it on the page body', async () => {
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
    const { progress, complete } = await mountEntry()
    await forward(2)
    const before = heading().textContent
    await click(button(en.skip))
    expect(heading().textContent).not.toBe(before)
    expect(screen.getByRole('dialog')).toBeTruthy()
    expect(complete).not.toHaveBeenCalled()
    expect(progress.value()).not.toMatchObject({ done: true })
  })
})
