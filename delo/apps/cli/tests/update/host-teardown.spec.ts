/**
 * The two ways the CLI home process stops its Host. `close`, as the process stops, goes through upstream's bounded
 * shutdown, which ends the process when the teardown overruns its 5 seconds. `suspend`, for an update's or a
 * rollback's switch, goes through the profile's own teardown and ends no process however long it takes, so a slow
 * teardown never kills the home process in the middle of a switch; the home process bounds that wait itself.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
// Upstream's bounded process shutdown, which its profile runner wraps every Host in, from the package's emitted types
// build, which keeps each module whole.
import { createProcessShutdown } from '@deepseek-ai/dsh/lib/types/process-shutdown.js'
import { runningHost, type BootedProfile } from '../../src/start.ts'

let home: string | undefined

afterEach(() => {
  vi.useRealTimers()
  if (home !== undefined) rmSync(home, { recursive: true, force: true })
  home = undefined
})

/**
 * A booted profile whose teardown takes 8 seconds, with upstream's real process shutdown around it.
 * @returns the profile, the exits upstream's shutdown asked for, and how many teardowns finished.
 */
function slowProfile(): { readonly booted: BootedProfile, readonly exits: number[], readonly disposed: () => number } {
  const exits: number[] = []
  let disposed = 0
  const dispose = async (): Promise<void> => {
    await new Promise(resolve => setTimeout(resolve, 8_000))
    disposed++
  }
  const shutdown = createProcessShutdown(dispose, (code) => { exits.push(code) }, () => undefined)
  return {
    booted: { rows: () => [], providerOf: () => undefined, releaseTurns: () => undefined, shutdown: code => shutdown.shutdown(code), dispose, watchChats: () => undefined, watchUpdates: () => Promise.resolve(), studio: () => undefined, studioLink: () => ({ kind: 'unavailable', reason: 'the Host serves no studio' }), reload: () => Promise.resolve({ ok: true }) },
    exits,
    disposed: () => disposed,
  }
}

describe('a Host whose teardown takes 8 seconds', () => {
  it('is suspended for a switch without any process exit, and only its close ends the process when it overruns', async () => {
    home = mkdtempSync(join(tmpdir(), 'delo-host-teardown-'))
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const { booted, exits, disposed } = slowProfile()
    const host = runningHost(booted, { home, profile: 'default' }, async () => undefined, async () => undefined)
    let suspended = false
    const suspending = host.suspend().then(() => { suspended = true })
    await vi.advanceTimersByTimeAsync(7_999)
    expect(suspended).toBe(false)
    expect(exits).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    await suspending
    expect(disposed()).toBe(1)
    expect(exits).toEqual([])
    // The process-stop path keeps upstream's bound: after 5 seconds the teardown is cut short and the process ends.
    const closing = host.close()
    await vi.advanceTimersByTimeAsync(5_000)
    expect(exits).toEqual([0])
    await vi.advanceTimersByTimeAsync(3_000)
    await closing
  })
})
