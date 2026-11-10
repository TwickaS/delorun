// @vitest-environment jsdom
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { act } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ChatStatesApi } from '../src/client/api.ts'
import { ChatStateStore } from '../src/client/store.ts'
import type { ChatState, ChatStatesResponse } from '../src/wire.ts'

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

const sid = (id: string) => SessionId(id)

/** An observable number the spec changes, as the settings form's refresh interval does. */
function seconds(initial: number) {
  let value = initial
  const listeners = new Set<() => void>()
  return {
    source: { getSnapshot: () => value, subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } } },
    set: (next: number) => { value = next; for (const listener of [...listeners]) listener() },
    listeners,
  }
}

/** Routes that answer from a record the spec changes. */
function apiOf(chats: Record<string, ChatState> = {}) {
  const answer = (): ChatStatesResponse => ({ chats: { ...chats } })
  return {
    chats,
    list: vi.fn<ChatStatesApi['list']>(async () => answer()),
    set: vi.fn<ChatStatesApi['set']>(async () => answer()),
  }
}

/** A promise the spec settles by hand. */
function deferred<T>() {
  let resolve: (value: T) => void = () => {}
  let reject: (reason: unknown) => void = () => {}
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

describe('the chat state store', () => {
  it('shelves settled chats and chats snoozed until later, and wakes a snooze when it ends', async () => {
    vi.useFakeTimers({ now: 1_000 })
    const api = apiOf({ a: { settledAt: 900 }, b: { snoozedAt: 800, snoozedUntil: 3_000 }, c: { snoozedAt: 700, snoozedUntil: 500 } })
    const store = new ChatStateStore(api)
    const stop = store.start(seconds(30).source)
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect([...store.settled.getSnapshot()]).toEqual([[sid('a'), 900]])
    expect([...store.snoozed.getSnapshot()]).toEqual([[sid('b'), 800]])
    expect([...store.woke.getSnapshot()]).toEqual([[sid('c'), 500]])
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000) })
    expect(store.snoozed.getSnapshot().size).toBe(0)
    expect([...store.woke.getSnapshot().keys()].sort()).toEqual([sid('b'), sid('c')])
    stop()
  })

  it('reads again at the interval and on focus, and stops reading when it is stopped', async () => {
    vi.useFakeTimers({ now: 1_000 })
    const api = apiOf({ a: { settledAt: 900 } })
    const store = new ChatStateStore(api)
    const stop = store.start(seconds(30).source)
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    // Another browser's change shows at the next read, and on focus.
    api.chats['d'] = { settledAt: 2_500 }
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000) })
    expect(store.settled.getSnapshot().has(sid('d'))).toBe(true)
    const reads = api.list.mock.calls.length
    window.dispatchEvent(new Event('focus'))
    expect(api.list.mock.calls.length).toBe(reads + 1)
    stop()
    window.dispatchEvent(new Event('focus'))
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000) })
    expect(api.list.mock.calls.length).toBe(reads + 1)
  })

  it('re-arms the interval when the setting changes, and leaves it alone when the setting is written unchanged', async () => {
    vi.useFakeTimers({ now: 1_000 })
    const api = apiOf()
    const refresh = seconds(30)
    const store = new ChatStateStore(api)
    const stop = store.start(refresh.source)
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(api.list).toHaveBeenCalledTimes(1)
    refresh.set(30)
    await act(async () => { await vi.advanceTimersByTimeAsync(29_000) })
    expect(api.list).toHaveBeenCalledTimes(1)
    refresh.set(10)
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000) })
    expect(api.list).toHaveBeenCalledTimes(2)
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000) })
    expect(api.list).toHaveBeenCalledTimes(3)
    stop()
    expect(refresh.listeners.size).toBe(0)
  })

  it('keeps the last states when a read fails, and tries again at the next read', async () => {
    const api = apiOf({ a: { settledAt: 1 } })
    const store = new ChatStateStore(api)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await store.change({ action: 'settle', session: sid('a') })
    api.list.mockRejectedValueOnce(new Error('down'))
    const stop = store.start(seconds(30).source)
    await act(async () => { await Promise.resolve() })
    expect(store.settled.getSnapshot().size).toBe(1)
    expect(warn).toHaveBeenCalledOnce()
    window.dispatchEvent(new Event('focus'))
    await act(async () => { await Promise.resolve() })
    expect(warn).toHaveBeenCalledOnce()
    stop()
  })

  it('does not warn about a read that failed because it was stopped', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const reading = deferred<ChatStatesResponse>()
    const api = apiOf()
    api.list.mockReturnValueOnce(reading.promise)
    const stop = new ChatStateStore(api).start(seconds(30).source)
    stop()
    reading.reject(new DOMException('aborted', 'AbortError'))
    await act(async () => { await Promise.resolve() })
    expect(warn).not.toHaveBeenCalled()
  })

  it('shows a notice when a change fails, and clears it when the next change starts', async () => {
    const api = apiOf({ a: { settledAt: 1 } })
    const store = new ChatStateStore(api)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    api.set.mockRejectedValueOnce(new Error('down'))
    await store.change({ action: 'unsettle', session: sid('a') })
    expect(store.failed.getSnapshot()).toBe(true)
    expect(store.states.getSnapshot()).toEqual({})
    await store.change({ action: 'unsettle', session: sid('a') })
    expect(store.failed.getSnapshot()).toBe(false)
    expect(warn).toHaveBeenCalledOnce()
  })

  it('marks a chat whose snooze ended here as woke, until it is seen', async () => {
    vi.useFakeTimers({ now: 1_000 })
    const api = apiOf({ a: { snoozedAt: 800, snoozedUntil: 2_000 }, b: { wokeAt: 500 }, c: { keptAt: 400 } })
    const store = new ChatStateStore(api)
    const stop = store.start(seconds(30).source)
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect([...store.woke.getSnapshot()]).toEqual([[sid('b'), 500]])
    expect([...store.kept.getSnapshot()]).toEqual([[sid('c'), 400]])
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000) })
    expect([...store.woke.getSnapshot()]).toEqual([[sid('a'), 2_000], [sid('b'), 500]])
    stop()
  })

  it('keeps a snooze that ends beyond the longest browser timer snoozed until it ends', async () => {
    vi.useFakeTimers({ now: 0 })
    const day = 86_400_000
    const api = apiOf({ a: { snoozedAt: 0, snoozedUntil: 40 * day } })
    const store = new ChatStateStore(api, () => Date.now())
    const stop = store.start(seconds(3600).source)
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    await act(async () => { await vi.advanceTimersByTimeAsync(30 * day) })
    expect(store.snoozed.getSnapshot().has(sid('a'))).toBe(true)
    await act(async () => { await vi.advanceTimersByTimeAsync(10 * day) })
    expect(store.snoozed.getSnapshot().has(sid('a'))).toBe(false)
    expect(store.woke.getSnapshot().get(sid('a'))).toBe(40 * day)
    stop()
  })
})

describe('answers that arrive out of order', () => {
  it('shows the answer to the later change when the earlier change is answered after it', async () => {
    const first = deferred<ChatStatesResponse>()
    const second = deferred<ChatStatesResponse>()
    const api = apiOf()
    api.set.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    const store = new ChatStateStore(api)
    const settling = store.change({ action: 'settle', session: sid('a') })
    const returning = store.change({ action: 'unsettle', session: sid('a') })
    second.resolve({ chats: { a: { keptAt: 2 } } })
    await returning
    first.resolve({ chats: { a: { settledAt: 1 } } })
    await settling
    expect(store.states.getSnapshot()).toEqual({ a: { keptAt: 2 } })
    expect(store.settled.getSnapshot().size).toBe(0)
  })

  it('drops a read that was sent while a change was waiting for its answer', async () => {
    const reading = deferred<ChatStatesResponse>()
    const changing = deferred<ChatStatesResponse>()
    const api = apiOf()
    api.set.mockReturnValueOnce(changing.promise)
    const store = new ChatStateStore(api)
    const change = store.change({ action: 'settle', session: sid('a') })
    api.list.mockReturnValueOnce(reading.promise)
    const stop = store.start(seconds(30).source)
    changing.resolve({ chats: { a: { settledAt: 1 } } })
    await change
    reading.resolve({ chats: {} })
    await act(async () => { await Promise.resolve() })
    expect(store.states.getSnapshot()).toEqual({ a: { settledAt: 1 } })
    stop()
  })

  it('drops a read that a change was sent after, and shows the read that follows', async () => {
    const reading = deferred<ChatStatesResponse>()
    const api = apiOf({ a: { settledAt: 1 } })
    api.list.mockReturnValueOnce(reading.promise)
    const store = new ChatStateStore(api)
    const stop = store.start(seconds(30).source)
    await store.change({ action: 'settle', session: sid('a') })
    reading.resolve({ chats: {} })
    await act(async () => { await Promise.resolve() })
    expect(store.states.getSnapshot()).toEqual({ a: { settledAt: 1 } })
    api.chats['b'] = { settledAt: 2 }
    window.dispatchEvent(new Event('focus'))
    await act(async () => { await Promise.resolve() })
    expect(Object.keys(store.states.getSnapshot())).toEqual(['a', 'b'])
    stop()
  })

  it('does not show a read that was answered after the store stopped', async () => {
    const reading = deferred<ChatStatesResponse>()
    const api = apiOf()
    api.list.mockReturnValueOnce(reading.promise)
    const store = new ChatStateStore(api)
    const stop = store.start(seconds(30).source)
    stop()
    reading.resolve({ chats: { a: { settledAt: 1 } } })
    await act(async () => { await Promise.resolve() })
    expect(store.states.getSnapshot()).toEqual({})
  })
})
