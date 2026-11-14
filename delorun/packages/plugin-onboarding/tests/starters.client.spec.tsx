// @vitest-environment jsdom
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { sessionSnapshot } from '@deepseek-ai/dsh-client-test-runtime'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { en } from '../src/client/locales.ts'
import { StarterPrompts, STARTERS, type StarterPromptsProps } from '../src/client/StarterPrompts.tsx'
import { t } from './fixtures.client.ts'

afterEach(cleanup)

const CHAT = SessionId('chat-1')
const click = async (element: HTMLElement) => { await act(async () => { fireEvent.click(element) }) }

/** The chips in the input dock of one chat, over a store holding the chat that offers them. */
function mount(options: { readonly offered?: string; readonly sessionId?: SessionId; readonly blank?: boolean; readonly draft?: string; readonly folder?: string } = {}) {
  const starter = createSnapshotStore(options.offered ?? CHAT)
  const prefill = vi.fn()
  const dismiss = vi.fn()
  const element = (draft: string, blank = options.blank ?? true) => (
    <StarterPrompts {...{
      t, sessionId: options.sessionId ?? CHAT, session: { ...sessionSnapshot(CHAT), blank },
      input: { draft, attachmentIds: [], draftRev: 0, phase: 'plain', occurrences: [], queue: [] }, starter, folder: () => options.folder ?? '', prefill, dismiss, bind: vi.fn(),
    } satisfies StarterPromptsProps} />
  )
  const view = render(element(options.draft ?? ''))
  return { ...view, starter, prefill, dismiss, show: (draft: string, blank?: boolean) => { view.rerender(element(draft, blank)) } }
}

describe('the starter prompts while they are pending', () => {
  const OLDER = SessionId('older')

  /** One dock instance, as the conversation mounts it for the chat it shows. */
  function dock(options: { readonly offered: string; readonly blank?: boolean }) {
    const starter = createSnapshotStore(options.offered)
    const bind = vi.fn()
    const element = (sessionId: SessionId, blank = options.blank ?? true) => (
      <StarterPrompts {...{
        t, sessionId, session: { ...sessionSnapshot(sessionId), blank },
        input: { draft: '', attachmentIds: [], draftRev: 0, phase: 'plain', occurrences: [], queue: [] }, starter, folder: () => '', prefill: vi.fn(), dismiss: vi.fn(), bind,
      } satisfies StarterPromptsProps} />
    )
    const view = render(element(OLDER))
    return { ...view, starter, bind, show: (sessionId: SessionId, blank?: boolean) => { view.rerender(element(sessionId, blank)) } }
  }

  it('go to an empty chat whose dock mounts while they are pending, and show no chips until then', () => {
    const { bind, container } = dock({ offered: 'pending' })
    expect(bind).toHaveBeenCalledExactlyOnceWith(OLDER)
    expect(container.textContent).toBe('')
  })

  it('do not go to a chat that already has a message', () => {
    const { bind } = dock({ offered: 'pending', blank: false })
    expect(bind).not.toHaveBeenCalled()
  })

  it('do not go to the chat that was open when they became pending, but to the next empty chat that opens', async () => {
    const { starter, bind, show } = dock({ offered: '' })
    await act(async () => { starter.set('pending') })
    expect(bind).not.toHaveBeenCalled()
    show(CHAT, false)
    expect(bind).not.toHaveBeenCalled()
    show(CHAT)
    expect(bind).toHaveBeenCalledExactlyOnceWith(CHAT)
  })

  it('treat the chat open at the next pending as older again after they were bound', async () => {
    const { starter, bind, show } = dock({ offered: 'pending' })
    expect(bind).toHaveBeenCalledOnce()
    await act(async () => { starter.set(OLDER) })
    show(CHAT)
    await act(async () => { starter.set('') })
    await act(async () => { starter.set('pending') })
    expect(bind).toHaveBeenCalledOnce()
  })
})

describe('the starter prompts', () => {
  it('show three chips with their labels above the message box of the chat onboarding opened', () => {
    mount()
    expect(screen.getAllByRole('button', { name: /^(What can you|Plan a|Suggest a)/ }).map(each => each.textContent)).toEqual([
      en['starter.general.1.label'], en['starter.general.2.label'], en['starter.general.3.label'],
    ])
    expect(STARTERS).toHaveLength(3)
    expect(screen.getByRole('group', { name: en['starter.lead'] })).toBeTruthy()
  })

  it.each(['empty', 'code', 'files'] as const)('offer the prompts that fit a folder onboarding read as %s, and the general ones for any other', (folder) => {
    mount({ folder })
    expect(screen.getAllByRole('button').slice(0, 3).map(each => each.textContent)).toEqual([1, 2, 3].map(n => en[`starter.${folder}.${n as 1 | 2 | 3}.label`]))
    cleanup()
    mount({ folder: 'unknown' })
    expect(screen.getAllByRole('button')[0]?.textContent).toBe(en['starter.general.1.label'])
  })

  it('write the prompt into the message box when a chip is pressed, and send nothing', async () => {
    const { prefill } = mount()
    await click(screen.getByRole('button', { name: en['starter.general.2.label'] }))
    expect(prefill).toHaveBeenCalledExactlyOnceWith(CHAT, en['starter.general.2.prompt'])
  })

  it('stay while the box holds one of their own prompts, mark it, and let another replace it', async () => {
    const { prefill } = mount({ draft: en['starter.general.2.prompt'] })
    expect(screen.getByRole('button', { name: en['starter.general.2.label'] }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByRole('button', { name: en['starter.general.1.label'] }).getAttribute('aria-pressed')).toBe('false')
    await click(screen.getByRole('button', { name: en['starter.general.1.label'] }))
    expect(prefill).toHaveBeenCalledWith(CHAT, en['starter.general.1.prompt'])
  })

  it('go when the person types their own text, and come back if the box is emptied while the chat is still empty', () => {
    const { show, container } = mount()
    show('Fix the login bug')
    expect(container.textContent).toBe('')
    show('   ')
    expect(screen.getAllByRole('button')).toHaveLength(4)
  })

  it('go once the chat has a message', () => {
    const { container } = mount({ blank: false })
    expect(container.textContent).toBe('')
  })

  it('show only in the chat that was opened, and not at all after they are dismissed or before onboarding opened one', () => {
    expect(mount({ sessionId: SessionId('other') }).container.textContent).toBe('')
    cleanup()
    expect(mount({ offered: '' }).container.textContent).toBe('')
  })

  it('go when the chat that offers them changes, and the dismiss button asks to stop offering them', async () => {
    const { starter, dismiss, container } = mount()
    await click(screen.getByRole('button', { name: en['starter.dismiss'] }))
    expect(dismiss).toHaveBeenCalledOnce()
    await act(async () => { starter.set('') })
    expect(container.textContent).toBe('')
  })
})
