/**
 * The plugin as mounted: the chat-gate slot, the install targets the plugin manager reads, the `packs` remote's
 * methods and the install-state announcements, and the concurrency field's validation.
 */
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import * as plugin from '../src/index.ts'
import { PacksService } from '../src/service.ts'

describe('the configuration', () => {
  it('defaults the concurrency to 2 and refuses less than 1 or a fraction', () => {
    expect(plugin.Config({} as plugin.Config).concurrency).toBe(2)
    expect(() => plugin.Config({ concurrency: 0 })).toThrow()
    expect(() => plugin.Config({ concurrency: 1.5 })).toThrow()
  })
})

describe('the mounted plugin', () => {
  it('provides the chat-gate slot, which counts the attached gate\'s chats and tells listeners a chat ended', async () => {
    const ctx = new Context()
    await ctx.plugin(plugin, {} as plugin.Config)
    const slot = ctx.get('delorunChatGate')!
    expect(slot.running()).toBe(0)
    const detach = slot.attach({ running: () => 3 })
    expect(slot.running()).toBe(3)
    let ended = 0
    slot.onChatEnded(() => { ended += 1 })
    slot.chatEnded()
    expect(ended).toBe(1)
    detach()
    expect(slot.running()).toBe(0)
  })

  it('answers the remote\'s methods from the hub and announces each listed item on install-state', async () => {
    const ctx = new Context()
    const announced: { requestId: string, phase: string }[] = []
    ctx.on('plugin-manager/install-state', (progress: { requestId: string, phase: string }) => { announced.push(progress) })
    type Snapshot = { supported: boolean, packs: never[], queue: { key: string, state: string }[] }
    const empty: Snapshot = { supported: true, packs: [], queue: [] }
    const calls: string[] = []
    const result = { ok: true, value: empty } as const
    let publish: (snapshot: Snapshot) => void = () => {}
    await ctx.plugin(PacksService, {
      subscribe: (listener: (snapshot: Snapshot) => void) => { publish = listener; return () => {} },
      snapshot: () => Promise.resolve(empty),
      enqueue: (names: readonly string[]) => { calls.push(`enqueue ${names.join(',')}`); return Promise.resolve(result) },
      cancel: (name: string) => { calls.push(`cancel ${name}`); return Promise.resolve(result) },
      remove: (name: string) => { calls.push(`remove ${name}`); return Promise.resolve(result) },
      retry: (name: string) => { calls.push(`retry ${name}`); return Promise.resolve(result) },
    } as never)
    publish({ ...empty, queue: [{ key: 'one', state: 'downloading' }, { key: 'two', state: 'needs-reload' }] })
    expect(announced).toEqual([{ requestId: 'pack:one', phase: 'installing' }, { requestId: 'pack:two', phase: 'applying' }])
    expect(calls).toEqual([])
  })
})
