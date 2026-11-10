// @vitest-environment jsdom
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OnboardingStepEntry, type OnboardingStepEntryProps } from '../src/client/Onboarding.tsx'
import { en } from '../src/client/locales.ts'
import type { OnboardingStep } from '../src/client/types.ts'
import type { OnboardingSettings } from '../src/config.ts'
import { NO_RECORD, type SetupRecord } from '../src/wire.ts'
import { liveForm, noticeFace, settings, stepServices, t } from './fixtures.client.ts'

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
}

/** The step entry over fakes, as the Settings shell mounts it. */
async function mountEntry(options: Options = {}) {
  const progress = liveForm<OnboardingSettings>(options.settings ?? settings(), {
    status: options.status ?? 'ready', ...options.writeResult === undefined ? {} : { result: options.writeResult },
  })
  const extra = createSnapshotStore<readonly OnboardingStep[]>(options.extra ?? [])
  const complete = vi.fn()
  const startChat = vi.fn(() => Promise.resolve())
  const loadRecord = vi.fn(() => Promise.resolve(options.record ?? NO_RECORD))
  const services = stepServices({ notice: options.notice?.face })
  const props = {
    t, complete, ...options.explicit === undefined ? {} : { explicit: options.explicit },
    progress: progress.form, extra, loadRecord, services, startChat,
  } satisfies OnboardingStepEntryProps
  const view = render(<OnboardingStepEntry {...props} />)
  await settle()
  await settle()
  return { ...view, progress, extra, complete, startChat, loadRecord, services }
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
    expect(titles()).toEqual([en['step.look'], en['step.agents'], en['step.reach'], en['step.start']])
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
    expect(titles()).toEqual([en['step.notice'], en['step.look'], en['step.agents'], en['step.reach'], en['step.start']])
    expect(screen.getByText('Step 1 of 5')).toBeTruthy()
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
    expect(screen.getByText('Step 1 of 4')).toBeTruthy()
    expect(screen.queryByRole('button', { name: en.back })).toBeNull()
    await click(button(en.continue))
    expect(progress.value()?.step).toBe('agents')
    await click(button(en.back))
    expect(progress.value()?.step).toBe('look')
    await click(button(en.continue))
    await click(button(en.continue))
    expect(heading().textContent).toBe(en['step.reach'])
    await click(button(en.continue))
    expect(heading().textContent).toBe(en['step.start'])
    expect(screen.queryByRole('button', { name: en.continue })).toBeNull()
    expect(startChat).not.toHaveBeenCalled()
    await click(button(en.start))
    expect(progress.value()).toMatchObject({ done: true, step: '' })
    expect(complete).toHaveBeenCalled()
    expect(startChat).toHaveBeenCalledOnce()
  })

  it('lists the steps with the current one marked and the earlier ones done', async () => {
    await mountEntry()
    await click(button(en.continue))
    const items = within(screen.getByRole('navigation')).getAllByRole('listitem')
    expect(items.map(each => each.getAttribute('data-state'))).toEqual(['done', 'current', 'next', 'next'])
    expect(items.map(each => each.getAttribute('aria-current'))).toEqual([null, 'step', null, null])
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
    expect(titles()).toEqual([en['step.look'], en['step.agents'], en['step.plugins'], en['step.reach'], en['step.start']])
    await click(button(en.continue))
    await click(button(en.continue))
    expect(heading().textContent).toBe(en['step.plugins'])
    expect(screen.getByRole('heading', { level: 4 }).textContent).toBe('@scope/p')
    cleanup()
    await mountEntry()
    expect(titles()).not.toContain(en['step.plugins'])
  })

  it('leaves out reach when the terminal setup set it up, and shows it when setup only listed it as skipped', async () => {
    await mountEntry({ record: { reachSetUp: true } })
    expect(titles()).not.toContain(en['step.reach'])
    cleanup()
    await mountEntry({ record: { reachSetUp: false, sections: ['reach', 'start'] } })
    expect(titles()).toContain(en['step.reach'])
    expect(titles()).toContain(en['step.start'])
  })

  it('leaves out the steps whose section the terminal covered, but never the notice, reach or start', async () => {
    await mountEntry({ settings: settings({ plugins: ['@scope/p'] }), record: { reachSetUp: false, sections: ['look', 'agents', 'plugins', 'notice'] }, notice: noticeFace() })
    expect(titles()).toEqual([en['step.notice'], en['step.reach'], en['step.start']])
  })

  it('places steps other plugins added by their order, before Start, and hands them the way forward', async () => {
    const Body = ({ next }: { next: () => void }) => <button type="button" onClick={next}>Added body</button>
    const added: OnboardingStep = { id: 'thinking.reader', order: 600, title: () => 'Reader', component: Body }
    const { extra } = await mountEntry({ extra: [added] })
    expect(titles()).toEqual([en['step.look'], en['step.agents'], en['step.reach'], 'Reader', en['step.start']])
    await click(button(en.continue))
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
