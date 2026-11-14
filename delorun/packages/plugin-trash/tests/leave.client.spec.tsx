// @vitest-environment jsdom
/** Where the main pane and the keyboard go after the chat the main pane shows moved to the trash. */
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { COMPOSER_CARD, TrashLeave, type TrashLeaveDeps } from '../src/client/leave.ts'

type WorkspaceId = ReturnType<TrashLeaveDeps['workspaceOf']> & string

const sid = (id: string) => SessionId(id)
const wid = (id: string) => id as WorkspaceId

/** A page with one open chat in a workspace, whose open chat and workspace list a test changes. */
function page(fields: { open?: string; workspace?: string | null } = {}) {
  let open: string | undefined = fields.open ?? 'chat-1'
  let listed = new Set(['ws-1', 'ws-2'])
  const listeners = new Set<() => void>()
  const started: Array<string | undefined> = []
  const deps: TrashLeaveDeps = {
    openChat: () => (open === undefined ? undefined : sid(open)),
    workspaceOf: id => (id === sid('chat-1') && fields.workspace !== null ? wid(fields.workspace ?? 'ws-1') : undefined),
    listed: id => listed.has(id),
    startChat: (id) => { started.push(id) },
    subscribe: (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    document,
  }
  const notify = (): void => { for (const listener of [...listeners]) listener() }
  return {
    leave: new TrashLeave(deps), started, listeners,
    show: (id: string | undefined) => { open = id; notify() },
    unlist: (id: string) => { listed = new Set([...listed].filter(each => each !== id)); notify() },
  }
}

/** Upstream's composer card, as the conversation renders it. */
function composerCard(): HTMLElement {
  const card = document.createElement('div')
  card.tabIndex = -1
  card.setAttribute('data-composer-card', '')
  document.body.append(card)
  return card
}

/** Let the frame the step waits for pass. */
const nextFrame = () => new Promise<void>((resolve) => { requestAnimationFrame(() => { resolve() }) })

afterEach(() => {
  document.body.replaceChildren()
  vi.restoreAllMocks()
})

describe('after a chat moved', () => {
  it('names upstream\'s composer card', () => {
    expect(composerCard().matches(COMPOSER_CARD)).toBe(true)
  })

  it('has no step when the main pane shows another chat', () => {
    expect(page({ open: 'other' }).leave.chat(sid('chat-1'))).toBeUndefined()
  })

  it('opens a new chat in its workspace, then moves a keyboard left on the page body to the composer card', async () => {
    const { leave, started, show } = page()
    const card = composerCard()
    const step = leave.chat(sid('chat-1'))
    step?.()
    expect(started).toEqual(['ws-1'])
    await nextFrame()
    expect(document.activeElement).toBe(document.body)
    show('blank-1')
    await nextFrame()
    expect(document.activeElement).toBe(card)
  })

  it('opens a new chat in the current or latest workspace for a chat in no workspace, and settles once the main pane is empty', async () => {
    const { leave, started, show } = page({ workspace: null })
    const card = composerCard()
    leave.chat(sid('chat-1'))?.()
    expect(started).toEqual([undefined])
    show(undefined)
    await nextFrame()
    expect(document.activeElement).toBe(card)
  })

  it('keeps the focus the composer or the person already moved', async () => {
    const { leave, show } = page()
    composerCard()
    const field = document.createElement('input')
    document.body.append(field)
    field.focus()
    leave.chat(sid('chat-1'))?.()
    show('blank-1')
    await nextFrame()
    expect(document.activeElement).toBe(field)
  })

  it('leaves the focus on the body when no composer is on the page', async () => {
    const { leave, show } = page()
    leave.chat(sid('chat-1'))?.()
    show('blank-1')
    await nextFrame()
    expect(document.activeElement).toBe(document.body)
  })

  it('does nothing once disposed, and stops the waits and the frame it had started', async () => {
    const first = page()
    const card = composerCard()
    first.leave.chat(sid('chat-1'))?.()
    expect(first.listeners.size).toBe(1)
    first.leave.dispose()
    expect(first.listeners.size).toBe(0)
    const late = first.leave.chat(sid('chat-1'))
    late?.()
    expect(first.started).toEqual(['ws-1'])

    const second = page()
    second.leave.chat(sid('chat-1'))?.()
    second.show('blank-1')
    second.leave.dispose()
    await nextFrame()
    expect(document.activeElement).not.toBe(card)
  })
})

describe('after a workspace moved', () => {
  it('has no step when the main pane shows no chat, or a chat of another workspace', () => {
    const empty = page()
    empty.show(undefined)
    expect(empty.leave.workspace(wid('ws-1'))).toBeUndefined()
    expect(page().leave.workspace(wid('ws-2'))).toBeUndefined()
  })

  it('waits until the list drops the workspace, then opens a new chat in the current or latest workspace', () => {
    const { leave, started, unlist, show } = page()
    leave.workspace(wid('ws-1'))?.()
    show('chat-1')
    expect(started).toEqual([])
    unlist('ws-1')
    expect(started).toEqual([undefined])
  })

  it('does nothing when the step comes after disposal', () => {
    const { leave, started, unlist, listeners } = page()
    const step = leave.workspace(wid('ws-1'))
    leave.dispose()
    step?.()
    unlist('ws-1')
    expect([started, listeners.size]).toEqual([[], 0])
  })

  it('opens the new chat at once when the list already dropped the workspace', () => {
    const { leave, started, unlist } = page()
    const step = leave.workspace(wid('ws-1'))
    unlist('ws-1')
    step?.()
    expect(started).toEqual([undefined])
  })
})
