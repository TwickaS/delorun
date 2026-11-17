/** `registerLists` contributes the row, trigger and hand-off positions, each as an effect. */
import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { HAND_OFF_TOOLS, registerLists } from '../src/client/lists/index.ts'

describe('registerLists', () => {
  it('registers a dictionary, the four menu positions and one line per hand-off tool', () => {
    const registered: { name: string; key?: string; id?: string }[] = []
    const openSession = vi.fn()
    const clocks: string[] = []
    const ctx = {
      effect: (fn: () => unknown) => fn(),
      locale: { register: vi.fn() },
      uiWorkspace: { openSession },
      slots: {
        inject: (_name: string, fn: () => unknown) => fn(),
        register: (options: { name: string; key?: string; id?: string; inject?: () => { openChild?: (p: string, c: string) => void; clock?: (ms: number) => string } }) => {
          registered.push(options)
          const injected = options.inject?.()
          injected?.openChild?.('lead', 'c1')
          if (injected?.clock !== undefined) clocks.push(injected.clock(0))
          return () => undefined
        },
      },
    } as never as Context
    registerLists(ctx)
    expect(registered.map(entry => entry.name)).toEqual([
      'conversation.session.header.actions.subagent.row.lead',
      'conversation.session.header.actions.subagent.row.detail',
      'conversation.session.header.actions.subagent.row.trail',
      'conversation.session.header.actions.subagent.trigger',
      'tool.call.toolview',
      'tool.call.toolview',
    ])
    expect(registered.filter(entry => entry.key !== undefined).map(entry => entry.key)).toEqual(Object.keys(HAND_OFF_TOOLS))
    expect(clocks).toHaveLength(3)
    expect(clocks.every(text => text !== '')).toBe(true)
    expect(openSession).toHaveBeenCalledWith({ parentSessionId: 'lead', childSessionId: 'c1', mode: 'continuable' })
  })
})
