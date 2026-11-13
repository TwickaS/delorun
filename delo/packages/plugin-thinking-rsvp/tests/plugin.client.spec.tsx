import { Context } from '@deepseek-ai/cordis'
import { MutableSessionEventSource } from '@deepseek-ai/dsh-api-session-controller/client'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ReadingFeed } from '../src/client/feed.ts'
import { apply, inject, TAB_ID, TAB_KIND } from '../src/client/index.ts'
import { en, NS, zh } from '../src/client/locales.ts'
import type { ThinkingPaneInjected } from '../src/client/types.ts'

interface Registration {
  readonly name: string
  readonly key?: string
  readonly locale?: string
  readonly inject?: (sessionId: string) => ThinkingPaneInjected
}

interface TabType {
  readonly id: string
  readonly kind: string
  readonly keepMounted?: boolean
  readonly title: (address: string) => string
}

afterEach(() => { vi.restoreAllMocks() })

// The studio services the tab uses, as far as it uses them, and one Session whose scope a spec ends.
async function mount(options: { readonly look?: boolean } = {}) {
  const ctx = new Context()
  const dictionaries = new Map<string, Readonly<Record<string, unknown>>>()
  ctx.provide('locale', {
    bind: () => makeTranslate(en),
    register: (ns: string, dicts: Readonly<Record<string, unknown>>) => { dictionaries.set(ns, dicts); return () => { dictionaries.delete(ns) } },
  })
  const bodies = new Set<Registration>()
  ctx.provide('slots', {
    inject: (_: string, register: () => () => void) => register(),
    register: (options: Registration) => { bodies.add(options); return () => { bodies.delete(options) } },
  })
  const tabs = new Set<TabType>()
  ctx.provide('sidebarRightTabs', { register: (definition: TabType) => { tabs.add(definition); return () => { tabs.delete(definition) } } })
  const session = new Context()
  let sessionCtx: Context | undefined
  const sessionFiber = session.plugin({ apply: (scoped: Context) => { sessionCtx = scoped } })
  await sessionFiber.await()
  const binding = { sessionId: 's1', eventSource: new MutableSessionEventSource(), get ctx() { return sessionCtx } }
  ctx.provide('sessions', { binding: (id: string) => id === 's1' ? binding : undefined })
  if (options.look !== false) ctx.provide('deloStudio', {} as never)
  const fiber = ctx.plugin({ inject: [...inject], apply })
  await fiber.await()
  const body = (): Registration => {
    const found = [...bodies][0]
    if (found === undefined) throw new Error('no tab body registered')
    return found
  }
  return { fiber, sessionFiber, dictionaries, tabs, bodies, body }
}

describe('the studio half', () => {
  it('registers its dictionaries, a kept tab type and its body, which its disposal removes', async () => {
    const { fiber, dictionaries, tabs, bodies, body } = await mount()
    expect(dictionaries.get(NS)).toEqual({ en, zh })
    const [tab] = tabs
    expect([tab?.id, tab?.kind, tab?.keepMounted, tab?.title('')]).toEqual([TAB_ID, TAB_KIND, true, en['tab.title']])
    expect([body().name, body().key, body().locale]).toEqual(['sidebar.right.pane.tab', TAB_ID, NS])
    await fiber.dispose()
    expect([dictionaries.size, tabs.size, bodies.size]).toEqual([0, 0, 0])
  })

  it('registers nothing while the stock look is on', async () => {
    const { dictionaries, tabs, bodies } = await mount({ look: false })
    expect([dictionaries.size, tabs.size, bodies.size]).toEqual([0, 0, 0])
  })

  it('gives each Session one feed, and refuses a Session it cannot find', async () => {
    const { body } = await mount()
    const first = body().inject?.('s1').hooks.reading
    expect(first).toBeInstanceOf(ReadingFeed)
    expect(body().inject?.('s1').hooks.reading).toBe(first)
    expect(() => body().inject?.('gone')).toThrow('thinking-rsvp: unknown Session "gone"')
  })

  it('releases a Session’s feed when the Session’s scope ends', async () => {
    const dispose = vi.spyOn(ReadingFeed.prototype, 'dispose')
    const { sessionFiber, body, fiber } = await mount()
    body().inject?.('s1')
    await sessionFiber.dispose()
    expect(dispose).toHaveBeenCalledTimes(1)
    // The plugin's own disposal does not release it again.
    await fiber.dispose()
    expect(dispose).toHaveBeenCalledTimes(1)
  })

  it('releases every feed when the plugin unloads', async () => {
    const dispose = vi.spyOn(ReadingFeed.prototype, 'dispose')
    const { fiber, body } = await mount()
    body().inject?.('s1')
    await fiber.dispose()
    expect(dispose).toHaveBeenCalledTimes(1)
  })
})
