// @vitest-environment jsdom
/** The studio half's registrations: the copy and the dock entry, only under the Delorun look, and nothing left after unload. */
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { apply, CostPill, DOCK_ENTRY, en, inject, NS, zh, type CostPillInjected } from '../src/client/index.ts'
import { sid } from './fixtures.client.ts'

/** The services the studio half injects, recording what it registers. */
async function studio(options: { readonly look?: boolean } = {}) {
  const ctx = new Context()
  const dictionaries = new Map<string, unknown>()
  ctx.provide('locale', {
    register: (ns: string, dicts: unknown) => { dictionaries.set(ns, dicts); return () => { dictionaries.delete(ns) } },
  } as never)
  const entries = new Map<string, { slot: Record<string, unknown>; component: unknown }>()
  ctx.provide('slots', {
    inject: (_: string, register: () => () => void) => register(),
    register: (slot: { name: string; id: string }, component: unknown) => {
      entries.set(`${slot.name}#${slot.id}`, { slot, component })
      return () => { entries.delete(`${slot.name}#${slot.id}`) }
    },
  } as never)
  const refreshProjections = vi.fn((id: string) => id === 'broken' ? Promise.reject(new Error('offline')) : Promise.resolve())
  ctx.provide('sessions', { refreshProjections } as never)
  if (options.look !== false) ctx.provide('delorunStudio', {} as never)
  const fiber = ctx.plugin({ name: 'delorun-cost-meter', inject: [...inject], apply })
  await fiber
  return { ctx, fiber, dictionaries, entries, refreshProjections }
}

const DOCK = `conversation.composer.dock#${DOCK_ENTRY.id}`

describe('the studio half', () => {
  it('registers its dictionaries and the cost pill after the stock pills while the Delorun look is on', async () => {
    const h = await studio()
    expect(h.dictionaries.get(NS)).toEqual({ en, zh })
    const entry = h.entries.get(DOCK)
    expect(entry?.component).toBe(CostPill)
    expect(entry?.slot).toMatchObject({ name: 'conversation.composer.dock', id: 'cost', order: 2, locale: NS })
  })

  it('asks the harness for each missing agent\'s projections, and keeps going when one request fails', async () => {
    const h = await studio()
    const injected = (h.entries.get(DOCK)?.slot['inject'] as () => CostPillInjected)()
    injected.loadCosts([sid('broken'), sid('ok')])
    await Promise.resolve()
    expect(h.refreshProjections.mock.calls).toEqual([[sid('broken')], [sid('ok')]])
  })

  it('registers nothing under the stock look', async () => {
    const h = await studio({ look: false })
    expect(h.entries.size).toBe(0)
    expect(h.dictionaries.size).toBe(0)
  })

  it('registers once the Delorun look arrives and removes everything when it leaves', async () => {
    const h = await studio({ look: false })
    const look = h.ctx.plugin({ apply: (scope: Context) => { scope.provide('delorunStudio', {} as never) } })
    await look
    expect(h.entries.size).toBe(1)
    await look.dispose()
    expect(h.entries.size).toBe(0)
    expect(h.dictionaries.size).toBe(0)
  })

  it('removes the pill and the dictionaries when the plugin unloads', async () => {
    const h = await studio()
    expect(h.entries.size).toBe(1)
    await h.fiber.dispose()
    expect(h.entries.size).toBe(0)
    expect(h.dictionaries.size).toBe(0)
  })
})
