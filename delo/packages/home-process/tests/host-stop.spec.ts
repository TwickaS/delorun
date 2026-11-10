/**
 * The bounded Host teardown a failed start, a refused boot and a switch wait for: it reports a teardown that finished,
 * failed or overran its bound, ends no process, and a refused Host whose teardown did not finish is reported with the
 * refusal it carries.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HostNotStoppedError, hostStopFailure, refuseBootedHost, REFUSED_HOST_STOP_S, stopHostWithin, type HostStopOutcome } from '../src/index.ts'

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
})

afterEach(() => {
  vi.useRealTimers()
})

/**
 * Follow a promise's settlement without awaiting it.
 * @param promise - the promise.
 * @returns a reader of its state: `pending`, or its value or reason.
 */
function watch<T>(promise: Promise<T>): () => T | unknown {
  let state: T | unknown = 'pending'
  promise.then((value) => { state = value }, (error: unknown) => { state = error })
  return () => state
}

describe('stopHostWithin', () => {
  it('waits for a teardown that finishes within the bound, however long it takes', async () => {
    const outcome = watch(stopHostWithin(async () => new Promise<void>((resolve) => { setTimeout(resolve, 8_000) }), 60))
    await vi.advanceTimersByTimeAsync(7_999)
    expect(outcome()).toBe('pending')
    await vi.advanceTimersByTimeAsync(1)
    expect(outcome()).toEqual({ stopped: true })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('reports a teardown still running at the bound as overran, exactly then', async () => {
    const outcome = watch(stopHostWithin(async () => new Promise<void>(() => {}), 5))
    await vi.advanceTimersByTimeAsync(4_999)
    expect(outcome()).toBe('pending')
    await vi.advanceTimersByTimeAsync(1)
    expect(outcome()).toEqual({ stopped: false, kind: 'overran', limitS: 5 })
  })

  it('reports a teardown that rejects or throws as failed, carrying the error', async () => {
    const failure = new Error('a row did not dispose')
    expect(await stopHostWithin(async () => Promise.reject(failure), 5)).toEqual({ stopped: false, kind: 'failed', error: failure })
    expect(await stopHostWithin(() => { throw failure }, 5)).toEqual({ stopped: false, kind: 'failed', error: failure })
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('refuseBootedHost', () => {
  const refusal = new Error('delorun: the CLI profile default was refused')

  it('throws the refusal itself once the refused Host has stopped', async () => {
    await expect(refuseBootedHost(async () => Promise.resolve(), refusal)).rejects.toBe(refusal)
  })

  it(`throws a HostNotStoppedError carrying the refusal when the teardown overruns ${String(REFUSED_HOST_STOP_S)} seconds`, async () => {
    const outcome = watch(refuseBootedHost(async () => new Promise<void>(() => {}), refusal))
    await vi.advanceTimersByTimeAsync(REFUSED_HOST_STOP_S * 1000 - 1)
    expect(outcome()).toBe('pending')
    await vi.advanceTimersByTimeAsync(1)
    const error = outcome()
    expect(error).toBeInstanceOf(HostNotStoppedError)
    expect(error).toMatchObject({ cause: refusal, outcome: { stopped: false, kind: 'overran', limitS: REFUSED_HOST_STOP_S } })
    expect((error as HostNotStoppedError).message).toBe(`delorun: the CLI profile default was refused; the refused Host did not stop within ${String(REFUSED_HOST_STOP_S)} seconds and may still run in this process`)
  })

  it('throws a HostNotStoppedError when the teardown fails, naming its error', async () => {
    const error = await refuseBootedHost(async () => Promise.reject(new Error('a row did not dispose')), refusal).catch((thrown: unknown) => thrown)
    expect(error).toBeInstanceOf(HostNotStoppedError)
    expect((error as HostNotStoppedError).message).toBe('delorun: the CLI profile default was refused; the refused Host failed to stop (a row did not dispose) and may still run in this process')
  })
})

describe('hostStopFailure', () => {
  it.each<[Exclude<HostStopOutcome, { readonly stopped: true }>, string]>([
    [{ stopped: false, kind: 'overran', limitS: 5 }, 'did not stop within 5 seconds'],
    [{ stopped: false, kind: 'failed', error: 'plain' }, 'failed to stop (plain)'],
  ])('describes %j', (outcome, clause) => {
    expect(hostStopFailure(outcome)).toBe(clause)
  })
})
