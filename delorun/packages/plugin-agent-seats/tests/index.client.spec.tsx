// @vitest-environment jsdom
/** `apply` mounts the banner, composer line, approval card and tool cards, each as an effect. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { apply, inject, name, RECORD_TOOL_NAMES, SEAT_ROUTES, SLOT_ORDER } from '../src/client/index.ts'

afterEach(() => { vi.unstubAllGlobals() })

interface Options {
  readonly name: string
  readonly id?: string
  readonly key?: string
  readonly select?: unknown
  readonly priority?: number
  readonly inject?: () => Record<string, unknown>
}

function mount(reachService?: unknown) {
  const registered: Options[] = []
  const ctx = {
    effect: (fn: () => unknown) => fn(),
    locale: { register: vi.fn() },
    get: vi.fn(() => reachService),
    slots: {
      inject: (_name: string, fn: () => unknown) => fn(),
      register: (options: Options) => { registered.push(options); return () => undefined },
    },
  } as never as Context
  apply(ctx)
  return { registered, ctx }
}

describe('apply', () => {
  it('names the entry and the services it needs', () => {
    expect(name).toBe('delorun-agent-seats')
    expect(inject).toEqual(['slots', 'locale', 'uiWorkspace'])
    expect(SLOT_ORDER).toEqual({ banner: 0, composerNote: 0 })
  })

  it('registers the lists, the banner, the composer line, the approval card and one card per record tool', () => {
    const { registered } = mount()
    const names = registered.map(entry => entry.name)
    expect(names).toContain('conversation.session.banner')
    expect(names).toContain('conversation.input.dock')
    expect(names).toContain('conversation.composer')
    expect(registered.filter(entry => entry.name === 'tool.call.toolview' && RECORD_TOOL_NAMES.includes(entry.key ?? ''))).toHaveLength(RECORD_TOOL_NAMES.length)
  })

  it('elects the approval card before upstream\'s approval panel, which has priority 1 and takes every question', () => {
    const card = mount().registered.find(entry => entry.name === 'conversation.composer')
    expect(card?.priority).toBeLessThan(1)
  })

  it('injects the studio\'s clipboard, clock and Host routes into the banner', async () => {
    const writeText = vi.fn(() => Promise.resolve())
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    const fetch = vi.fn(() => Promise.resolve(new Response('{}', { status: 200 })))
    vi.stubGlobal('fetch', fetch)
    const injected = mount().registered.find(entry => entry.id === 'agent-seat')?.inject?.() as {
      client: { resume: (id: string) => Promise<void> }; copy: (text: string) => Promise<void>; clock: (ms: number) => string
    }
    await injected.copy('delorun agents login codex')
    expect(writeText).toHaveBeenCalledWith('delorun agents login codex')
    expect(typeof injected.clock(0)).toBe('string')
    await injected.client.resume('s1')
    expect(fetch).toHaveBeenCalledWith(SEAT_ROUTES.resume, expect.objectContaining({ method: 'POST' }))
  })

  it('injects the page\'s reach service, when there is one, into the approval card', () => {
    const service = { get: () => ({ kind: 'computer' }), subscribe: () => () => undefined }
    const card = (reach?: unknown) => mount(reach).registered.find(entry => entry.name === 'conversation.composer')
    expect(card(service)?.inject?.()['reach']).toBe(service)
    expect(card()?.inject?.()['reach']).toBeUndefined()
    expect(card()?.select).toBeTypeOf('function')
  })
})
