// @vitest-environment jsdom
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { MULTIVIEW_PANEL_ID, type MultiviewService } from '../../src/client/contract.ts'
import { registerPanel } from '../../src/panel/register.ts'
import { PANES_NS } from '../../src/panes/locales.ts'
import { A, CHAT } from '../entry/fixtures.ts'

interface Registered { readonly options: { name: string; key?: string; id?: string; order?: number; locale?: string; inject?: () => unknown; children?: Record<string, unknown> } }

function setup(address: object | undefined = undefined) {
  const ctx = new Context()
  const registered: Registered[] = []
  const dictionaries: string[] = []
  const openSession = vi.fn()
  ctx.provide('locale', { register: (ns: string) => { dictionaries.push(ns); return () => undefined } } as never)
  ctx.provide('slots', {
    inject: (_name: string, register: () => (() => void) | Generator<() => void>) => {
      const result = register()
      if (typeof result === 'function') return result
      const disposers = [...result]
      return () => { for (const dispose of disposers) dispose() }
    },
    register: (options: Registered['options']) => { registered.push({ options }); return () => undefined },
  } as never)
  ctx.provide('sessions', { subagentAddress: () => address } as never)
  ctx.provide('uiWorkspace', { openSession } as never)
  const clock = vi.fn((epochMs: number) => `at ${String(epochMs)}`)
  const fiber = ctx.plugin({
    name: 'panel-under-test', inject: ['slots', 'locale', 'sessions', 'uiWorkspace'],
    apply: (inner: Context) => { registerPanel(inner, { multiview: {} as MultiviewService, clock }) },
  })
  return { registered, dictionaries, openSession, clock, fiber }
}

describe('registering the panel', () => {
  it('registers the multiview main panel with its pane slots, the pane header and body, and the dots in the dock', async () => {
    const { registered, dictionaries, fiber } = setup()
    await fiber.await()
    expect(dictionaries).toEqual([PANES_NS])
    const names = registered.map(entry => entry.options.name)
    expect(names).toEqual(['main', 'multiview.pane.header', 'multiview.pane.body', 'conversation.input.dock'])
    const panel = registered[0]!.options
    expect(panel.key).toBe(MULTIVIEW_PANEL_ID)
    expect(Object.keys(panel.children!)).toEqual(['conversation.header', 'multiview.pane.header', 'multiview.pane.body'])
    expect(registered[3]!.options).toMatchObject({ id: 'multiview-dots', order: 100, locale: PANES_NS })
  })

  it('opens a pane chat in the main view through its subagent address, or its id when it has none', async () => {
    const address = { parentSessionId: CHAT, childSessionId: A, mode: 'continuable' }
    const withAddress = setup(address)
    await withAddress.fiber.await()
    ;(withAddress.registered[0]!.options.inject!() as { openFull: (id: typeof A) => void }).openFull(A)
    expect(withAddress.openSession).toHaveBeenCalledWith(address)
    const plain = setup()
    await plain.fiber.await()
    ;(plain.registered[0]!.options.inject!() as { openFull: (id: typeof A) => void }).openFull(A)
    expect(plain.openSession).toHaveBeenCalledWith(A)
  })

  it('hands the panel one injected object and the dots entry the same dots store', async () => {
    const { registered, fiber } = setup()
    await fiber.await()
    const panel = registered[0]!.options.inject!() as { dots: unknown; clock: unknown }
    expect(registered[0]!.options.inject!()).toBe(panel)
    expect((registered[3]!.options.inject!() as { dots: unknown }).dots).toBe(panel.dots)
  })
})
