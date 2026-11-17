import { describe, expect, it } from 'vitest'
import { InstallQueue, InstallRefusal, type InstallItem, type InstallOutcome, type InstallProgress } from '../src/index.ts'

interface Job {
  readonly key: string
  readonly signal: AbortSignal
  readonly progress: InstallProgress
  finish(outcome?: InstallOutcome): void
  fail(error: Error): void
}

function bench(options: { readonly concurrency?: number, readonly chats?: { count: number }, readonly persisted?: InstallItem[] } = {}) {
  const jobs: Job[] = []
  const reloads: number[] = []
  const saved: Array<readonly InstallItem[]> = []
  const chats = options.chats ?? { count: 0 }
  const queue = new InstallQueue({
    concurrency: options.concurrency ?? 2,
    run: (key, signal, progress) => new Promise<InstallOutcome>((resolve, reject) => {
      jobs.push({ key, signal, progress, finish: outcome => { resolve(outcome ?? { reloadNeeded: false }) }, fail: reject })
      signal.addEventListener('abort', () => { reject(new Error('aborted')) })
    }),
    reload: () => { reloads.push(reloads.length + 1); return Promise.resolve() },
    runningChats: () => chats.count,
    load: () => options.persisted ?? [],
    save: items => { saved.push(items) },
  })
  const states = () => Object.fromEntries(queue.snapshot().map(item => [item.key, item.state]))
  const settle = async () => { for (let i = 0; i < 6; i += 1) await Promise.resolve() }
  return { queue, jobs, reloads, saved, chats, states, settle }
}

describe('the install queue', () => {
  it('runs the configured number at once, first come first served, and numbers the line', () => {
    const { queue, jobs, states } = bench({ concurrency: 2 })
    for (const key of ['a', 'b', 'c', 'd']) queue.enqueue(key)
    expect(jobs.map(job => job.key)).toEqual(['a', 'b'])
    expect(states()).toEqual({ a: 'downloading', b: 'downloading', c: 'queued', d: 'queued' })
    expect(queue.snapshot().filter(item => item.state === 'queued').map(item => item.position)).toEqual([1, 2])
  })

  it('refuses a concurrency that is not a positive integer', () => {
    expect(() => bench({ concurrency: 0 })).toThrow(/positive integer/u)
  })

  it('holds one item for the same plugin, and starts a failed one again', async () => {
    const { queue, jobs, settle } = bench()
    queue.enqueue('a')
    queue.enqueue('a')
    expect(jobs).toHaveLength(1)
    jobs[0]!.fail(new Error('network'))
    await settle()
    expect(queue.snapshot()[0]).toMatchObject({ state: 'failed', failure: { code: 'failed', message: 'network' } })
    queue.enqueue('a')
    expect(jobs).toHaveLength(2)
  })

  it('shows progress, and a failure never stops the others', async () => {
    const { queue, jobs, states, settle } = bench()
    queue.enqueue('a')
    queue.enqueue('b')
    jobs[0]!.progress.bytes(50, 200)
    expect(queue.snapshot()[0]).toMatchObject({ receivedBytes: 50, totalBytes: 200 })
    jobs[0]!.progress.stage('verifying')
    jobs[0]!.fail(new InstallRefusal('offline', 'needs a connection'))
    jobs[1]!.finish()
    await settle()
    expect(states()).toEqual({ a: 'failed', b: 'ready' })
    expect(queue.snapshot()[0]!.failure).toEqual({ code: 'offline', message: 'needs a connection' })
  })

  it('cancels a queued item at once and aborts a working one', async () => {
    const { queue, jobs, states, settle } = bench({ concurrency: 1 })
    queue.enqueue('a')
    queue.enqueue('b')
    queue.cancel('b')
    expect(states()).toEqual({ a: 'downloading', b: 'cancelled' })
    queue.cancel('a')
    await settle()
    expect(jobs[0]!.signal.aborted).toBe(true)
    expect(states()).toEqual({ a: 'cancelled', b: 'cancelled' })
    queue.remove('b')
    expect(Object.keys(states())).toEqual(['a'])
  })

  it('reloads the Host once for many installs, only after the queue drains', async () => {
    const { queue, jobs, reloads, states, settle } = bench({ concurrency: 3 })
    for (const key of ['a', 'b', 'c']) queue.enqueue(key)
    jobs[0]!.finish({ reloadNeeded: true })
    jobs[1]!.finish({ reloadNeeded: true })
    await settle()
    expect(reloads).toEqual([])
    expect(states()).toMatchObject({ a: 'needs-reload', b: 'needs-reload', c: 'downloading' })
    jobs[2]!.finish({ reloadNeeded: true })
    await settle()
    expect(reloads).toEqual([1])
    expect(states()).toEqual({ a: 'ready', b: 'ready', c: 'ready' })
  })

  it('never reloads while a chat runs, and does so when the chats end', async () => {
    const { queue, jobs, reloads, chats, states, settle } = bench()
    chats.count = 1
    queue.enqueue('a')
    jobs[0]!.finish({ reloadNeeded: true })
    await settle()
    expect(reloads).toEqual([])
    expect(states()).toEqual({ a: 'needs-reload' })
    chats.count = 0
    queue.chatsChanged()
    await settle()
    expect(reloads).toEqual([1])
    expect(states()).toEqual({ a: 'ready' })
  })

  it('shows a failed reload instead of hiding it', async () => {
    const jobs: Array<() => void> = []
    const queue = new InstallQueue({
      concurrency: 1,
      run: () => new Promise<InstallOutcome>((resolve) => { jobs.push(() => { resolve({ reloadNeeded: true }) }) }),
      reload: () => Promise.reject(new Error('port busy')),
      runningChats: () => 0,
      load: () => [],
      save: () => undefined,
    })
    queue.enqueue('a')
    jobs[0]!()
    for (let i = 0; i < 8; i += 1) await Promise.resolve()
    expect(queue.snapshot()[0]).toMatchObject({ state: 'failed', failure: { message: expect.stringContaining('port busy') } })
  })

  it('restores the line after a restart: queued items start, interrupted ones fail, nothing is lost', () => {
    const persisted: InstallItem[] = [
      { key: 'working', state: 'installing', receivedBytes: 10, reloadNeeded: false },
      { key: 'waiting', state: 'queued', receivedBytes: 0, reloadNeeded: false },
      { key: 'done', state: 'ready', receivedBytes: 0, reloadNeeded: false },
    ]
    const { queue, jobs, states } = bench({ persisted })
    queue.restore()
    expect(states()).toEqual({ working: 'failed', waiting: 'downloading', done: 'ready' })
    expect(queue.snapshot()[0]!.failure?.code).toBe('interrupted')
    expect(jobs.map(job => job.key)).toEqual(['waiting'])
  })

  it('persists after every change and tells every subscriber', () => {
    const { queue, saved } = bench()
    const seen: number[] = []
    const stop = queue.subscribe(items => seen.push(items.length))
    queue.enqueue('a')
    expect(saved.length).toBeGreaterThan(0)
    expect(seen.at(-1)).toBe(1)
    stop()
    queue.enqueue('b')
    expect(seen.at(-1)).toBe(1)
  })
})
