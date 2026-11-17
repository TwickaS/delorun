// @vitest-environment jsdom
/** The panel's source over the `packs` remote: mapping, refresh triggers, and the unlock wait. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { InstallItem, PacksResult, PacksSnapshot } from '@delorun/plugin-packs/wire'
import { createRemoteDownloadsSource, needsUnlock, type PacksPanelRemote } from '../src/client/remote.ts'

const queued = (key: string, patch: Partial<InstallItem> = {}): InstallItem => ({ key, state: 'queued', receivedBytes: 0, reloadNeeded: false, ...patch })
const snapshot = (queue: InstallItem[]): PacksSnapshot => ({ supported: true, release: '0.1.0', packs: [], queue })
const ok = (queue: InstallItem[]): PacksResult => ({ ok: true, value: snapshot(queue) })

function fake(initial: InstallItem[]) {
  let queue = initial
  const calls: string[] = []
  const refusal = { code: 'remote-access/denied', message: 'denied', details: { reason: 'elevation-required: packs/retry' } }
  const state = { refuse: false }
  const guarded = (name: string, change: (key: string) => void) => (request: { name: string }): Promise<PacksResult> => {
    calls.push(`${name}:${request.name}`)
    if (state.refuse) return Promise.reject(refusal)
    change(request.name)
    return Promise.resolve(ok(queue))
  }
  const remote: PacksPanelRemote = {
    list: () => { calls.push('list'); return Promise.resolve(snapshot(queue)) },
    cancel: guarded('cancel', key => { queue = queue.map(item => (item.key === key ? { ...item, state: 'cancelled' } : item)) }),
    retry: guarded('retry', key => { queue = queue.map(item => (item.key === key ? { ...item, state: 'queued', failure: undefined } : item)) }),
    remove: guarded('remove', key => { queue = queue.filter(item => item.key !== key) }),
    dismiss: guarded('dismiss', key => { queue = queue.filter(item => item.key !== key) }),
  }
  return { remote, calls, state, set: (next: InstallItem[]) => { queue = next } }
}

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

describe('the downloads source over the packs remote', () => {
  it('maps the install list and keeps one array until it changes', async () => {
    const f = fake([queued('a', { state: 'downloading', receivedBytes: 5, totalBytes: 10 }), queued('b', { position: 1 })])
    const source = createRemoteDownloadsSource(f.remote, { follow: () => () => {}, pollMs: 1000 })
    const seen = vi.fn()
    const stop = source.subscribe(seen)
    await vi.advanceTimersByTimeAsync(0)
    const first = source.snapshot()
    expect(first.map(item => [item.key, item.state, item.position])).toEqual([['a', 'downloading', undefined], ['b', 'queued', 1]])
    await vi.advanceTimersByTimeAsync(1000)
    expect(source.snapshot()).toBe(first)
    expect(seen).toHaveBeenCalledTimes(1)
    stop()
  })

  it('reads again when the Host announces progress, and polls only while something is working, and stops with the last subscriber', async () => {
    const f = fake([queued('a')])
    let announce = () => {}
    const unfollow = vi.fn()
    const source = createRemoteDownloadsSource(f.remote, { follow: (refresh) => { announce = refresh; return unfollow }, pollMs: 1000 })
    const stop = source.subscribe(() => {})
    await vi.advanceTimersByTimeAsync(0)
    f.calls.length = 0
    await vi.advanceTimersByTimeAsync(2000)
    expect(f.calls.filter(call => call === 'list')).toHaveLength(2)
    f.set([queued('a', { state: 'ready' })])
    await vi.advanceTimersByTimeAsync(1000)
    f.calls.length = 0
    await vi.advanceTimersByTimeAsync(3000)
    expect(f.calls).toEqual([])
    announce()
    await vi.advanceTimersByTimeAsync(0)
    expect(f.calls).toEqual(['list'])
    stop()
    expect(unfollow).toHaveBeenCalledOnce()
    f.calls.length = 0
    await vi.advanceTimersByTimeAsync(5000)
    expect(f.calls).toEqual([])
  })

  it('sends cancel, retry and remove and shows the answer', async () => {
    const f = fake([queued('a', { state: 'failed', failure: { code: 'failed', message: 'x' } }), queued('b', { state: 'ready' })])
    const source = createRemoteDownloadsSource(f.remote, { follow: () => () => {}, pollMs: 1000 })
    source.subscribe(() => {})
    await vi.advanceTimersByTimeAsync(0)
    source.retry('a')
    await vi.advanceTimersByTimeAsync(0)
    expect(source.snapshot()[0]?.state).toBe('queued')
    source.cancel('a')
    await vi.advanceTimersByTimeAsync(0)
    expect(source.snapshot()[0]?.state).toBe('cancelled')
    source.remove('b')
    await vi.advanceTimersByTimeAsync(0)
    expect(source.snapshot().map(item => item.key)).toEqual(['a'])
    expect(f.calls).toContain('remove:b')
    source.remove('a')
    await vi.advanceTimersByTimeAsync(0)
    expect(f.calls).toContain('dismiss:a')
    expect(source.snapshot()).toEqual([])
  })

  it('shows waiting-for-unlock when remote access wants an unlock, and clears it when the call goes through', async () => {
    const f = fake([queued('a', { state: 'failed', failure: { code: 'failed', message: 'x' } })])
    const source = createRemoteDownloadsSource(f.remote, { follow: () => () => {}, pollMs: 1000 })
    source.subscribe(() => {})
    await vi.advanceTimersByTimeAsync(0)
    f.state.refuse = true
    source.retry('a')
    await vi.advanceTimersByTimeAsync(0)
    expect(source.snapshot()[0]?.state).toBe('waiting-for-unlock')
    f.state.refuse = false
    source.retry('a')
    await vi.advanceTimersByTimeAsync(0)
    expect(source.snapshot()[0]?.state).toBe('queued')
  })

  it('keeps the row as it is, and warns, when a call fails for another reason', async () => {
    const f = fake([queued('a', { state: 'failed', failure: { code: 'failed', message: 'x' } })])
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    f.remote.retry = () => Promise.reject(new Error('connection lost'))
    const source = createRemoteDownloadsSource(f.remote, { follow: () => () => {}, pollMs: 1000 })
    source.subscribe(() => {})
    await vi.advanceTimersByTimeAsync(0)
    source.retry('a')
    await vi.advanceTimersByTimeAsync(0)
    expect(source.snapshot()[0]?.state).toBe('failed')
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('recognises an unlock refusal by its reason or message only', () => {
    expect(needsUnlock({ details: { reason: 'elevation-required: packs/retry' } })).toBe(true)
    expect(needsUnlock(new Error('elevation-required: packs/retry'))).toBe(true)
    expect(needsUnlock({ details: { reason: 'loopback-required: x' } })).toBe(false)
    expect(needsUnlock('elevation-required')).toBe(false)
    expect(needsUnlock(undefined)).toBe(false)
  })
})
