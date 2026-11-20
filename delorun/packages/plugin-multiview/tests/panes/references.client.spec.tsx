// @vitest-environment jsdom
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { PaneReferences, usePaneReferences, type PaneSessions } from '../../src/panes/references.ts'

afterEach(cleanup)

const id = (value: string): SessionId => value as SessionId

/** A sessions service that counts the live references of each chat by source. */
function fakeSessions() {
  const live = new Map<string, number>()
  const retained: Array<{ target: unknown; source: string }> = []
  const sessions: PaneSessions = {
    subagentAddress: (chat) => (chat === 'agent' ? { parentSessionId: id('main'), childSessionId: chat, mode: 'continuable' as const } : undefined),
    retain: (target, options) => {
      const chat = typeof target === 'string' ? target : target.childSessionId
      retained.push({ target, source: options.source })
      live.set(chat, (live.get(chat) ?? 0) + 1)
      let released = false
      return {
        sessionId: chat as SessionId,
        release: () => { if (!released) { released = true; live.set(chat, (live.get(chat) ?? 0) - 1) } },
      } as never
    },
  }
  return { sessions, live, retained }
}

describe('the pane references', () => {
  it('retains each pane chat once with the multiviewPane source, and the child chat through its address', () => {
    const { sessions, retained } = fakeSessions()
    const holder = new PaneReferences(sessions)
    holder.sync([id('main'), id('agent')])
    holder.sync([id('main'), id('agent')])
    expect(retained.map(entry => entry.source)).toEqual(['multiviewPane', 'multiviewPane'])
    expect(retained[0]!.target).toBe('main')
    expect(retained[1]!.target).toEqual({ parentSessionId: 'main', childSessionId: 'agent', mode: 'continuable' })
    expect(holder.size).toBe(2)
  })

  it('releases a chat as soon as its pane leaves the layout, leaving the others untouched', () => {
    const { sessions, live } = fakeSessions()
    const holder = new PaneReferences(sessions)
    holder.sync([id('main'), id('a'), id('b')])
    holder.sync([id('main'), id('b')])
    expect([...live.entries()]).toEqual([['main', 1], ['a', 0], ['b', 1]])
    expect(holder.size).toBe(2)
  })

  it('publishes a new snapshot only when the set changes', () => {
    const { sessions } = fakeSessions()
    const holder = new PaneReferences(sessions)
    const listener = vi.fn()
    holder.subscribe(listener)
    holder.sync([id('a')])
    const first = holder.getSnapshot()
    holder.sync([id('a')])
    expect(holder.getSnapshot()).toBe(first)
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('holds references while mounted and releases every one on unmount: zero after close', () => {
    const { sessions, live } = fakeSessions()
    function Probe({ ids }: { ids: readonly SessionId[] }) {
      usePaneReferences(sessions, ids)
      return null
    }
    const view = render(<Probe ids={[id('main'), id('a')]} />)
    expect([...live.values()]).toEqual([1, 1])
    act(() => { view.rerender(<Probe ids={[id('main')]} />) })
    expect(live.get('a')).toBe(0)
    view.unmount()
    expect([...live.values()].every(count => count === 0)).toBe(true)
  })
})
