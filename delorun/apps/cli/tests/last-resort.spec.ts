/**
 * `delorun`'s last-resort handler: a failure no command caught prints as a redacted refusal in place of an `inspect()`
 * stack, its full detail goes to the home process's log when this process opened one, a registered teardown runs, and
 * the process exits 1.
 */
import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { newStartId } from '@delorun/home'
import { openHomeLog } from '@delorun/home-process'
import { TrashError } from '@delorun/trash'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { installCliLastResort, NO_LOG_POINTER, registerFatalRelease } from '../src/last-resort.ts'

/** A provider key in the form `@delorun/logs`'s redactor specs use. */
const PROVIDER_KEY = ['sk', '0123456789abcdef0123456789abcdef'].join('-')

/**
 * The handler installed on an emitter of its own.
 * @param argv - the command line.
 * @returns the emitter, the output, the exits and the uninstaller.
 */
function installed(argv: readonly string[] = []) {
  const emitter = new EventEmitter()
  const output: string[] = []
  const exits: number[] = []
  const uninstall = installCliLastResort(argv, { process: emitter, stderr: text => { output.push(text) }, exit: code => { exits.push(code) } })
  return { emitter, output, exits, uninstall }
}

const homes: string[] = []
afterAll(() => {
  for (const home of homes) rmSync(home, { recursive: true, force: true })
})

// The specs without a home log come first: a home log this process opens stays its log.
describe('the last-resort handler of a delorun process without a log', () => {
  it('prints an uncaught exception as a redacted refusal that says no log holds it, without a stack, and exits 1', async () => {
    const { emitter, output, exits, uninstall } = installed()
    emitter.emit('uncaughtException', new TypeError(`the key ${PROVIDER_KEY} is not valid`))
    expect(output.join('')).toBe(`Delorun stopped: the key [redacted:provider-key] is not valid\nWhat you can do:\n  ${NO_LOG_POINTER}\n`)
    expect(output.join('')).not.toContain('    at ')
    await vi.waitFor(() => { expect(exits).toEqual([1]) })
    uninstall()
  })

  it('describes an unhandled rejection with delorun\'s describers, redacted, and names the profile', async () => {
    const { emitter, output, exits, uninstall } = installed(['trash', 'restore', 'x', '--profile', 'work'])
    emitter.emit('unhandledRejection', new TrashError('TRASH_ITEM_NOT_FOUND', `no item ${PROVIDER_KEY}`))
    expect(output.join('')).toBe(`Delorun did not change the trash.\nWhy: TRASH_ITEM_NOT_FOUND: no item [redacted:provider-key]\nWhat you can do:\n  See what the trash holds: delorun trash list --profile work\n  ${NO_LOG_POINTER}\n`)
    await vi.waitFor(() => { expect(exits).toEqual([1]) })
    uninstall()
  })

  it('reports the first failure once, waits for the registered teardown, then exits 1', async () => {
    const { emitter, output, exits, uninstall } = installed()
    let finish!: () => void
    const unregister = registerFatalRelease(() => new Promise<void>((resolve) => { finish = resolve }))
    expect(() => registerFatalRelease(async () => {})).toThrow('already registered')
    emitter.emit('uncaughtException', new Error('first'))
    emitter.emit('unhandledRejection', new Error('second'))
    await new Promise(resolve => setImmediate(resolve))
    expect(exits).toEqual([])
    finish()
    await vi.waitFor(() => { expect(exits).toEqual([1]) })
    expect(output.join('')).toBe(`Delorun stopped: first\nWhat you can do:\n  ${NO_LOG_POINTER}\n`)
    unregister()
    uninstall()
  })

  it('exits inside the listener without a registered teardown, so a handler registered after it never runs', () => {
    const { emitter, output, exits, uninstall } = installed()
    const later: unknown[] = []
    // A stand-in for the exit: the real one ends the process, so the later listener records whether it would have run.
    emitter.on('uncaughtException', (error) => { if (exits.length === 0) later.push(error) })
    emitter.emit('uncaughtException', new Error('boom'))
    expect(exits).toEqual([1])
    expect(later).toEqual([])
    expect(output.join('')).toBe(`Delorun stopped: boom\nWhat you can do:\n  ${NO_LOG_POINTER}\n`)
    emitter.removeAllListeners('uncaughtException')
    uninstall()
  })

  it('exits 1 when the registered teardown fails or overruns upstream\'s bound', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const failing = installed()
      const unregisterFailing = registerFatalRelease(() => Promise.reject(new Error('the Host did not stop')))
      failing.emitter.emit('uncaughtException', new Error('first'))
      await vi.waitFor(() => { expect(failing.exits).toEqual([1]) })
      unregisterFailing()
      failing.uninstall()
      const hanging = installed()
      const unregisterHanging = registerFatalRelease(() => new Promise<void>(() => {}))
      hanging.emitter.emit('uncaughtException', new Error('second'))
      await vi.advanceTimersByTimeAsync(1_999)
      expect(hanging.exits).toEqual([])
      await vi.advanceTimersByTimeAsync(1)
      expect(hanging.exits).toEqual([1])
      unregisterHanging()
      hanging.uninstall()
    } finally {
      vi.useRealTimers()
    }
  })

  it('installs once per process, and the uninstaller removes its listeners', () => {
    const { emitter, uninstall } = installed()
    expect(emitter.listenerCount('uncaughtException')).toBe(1)
    expect(emitter.listenerCount('unhandledRejection')).toBe(1)
    expect(() => installCliLastResort([], { process: emitter, stderr: () => {}, exit: () => {} })).toThrow('already installed')
    uninstall()
    expect(emitter.listenerCount('uncaughtException')).toBe(0)
    expect(emitter.listenerCount('unhandledRejection')).toBe(0)
    installCliLastResort([], { process: emitter, stderr: () => {}, exit: () => {} })()
  })
})

describe('the last-resort handler of a home process', () => {
  it('writes the full detail to the home log, redacted with the log\'s secrets, and points at delorun logs home', async () => {
    const home = mkdtempSync(join(tmpdir(), 'delorun-last-resort-'))
    homes.push(home)
    const homeLog = openHomeLog({ home, profile: 'work', startId: newStartId(), level: 'info', onFailure: (error) => { throw error } })
    const token = 'start-token-value-0123456789'
    homeLog.redactor.register(token, 'start-token')
    const { emitter, output, exits, uninstall } = installed()
    const error = new Error(`the channel answered ${token} with ${PROVIDER_KEY}`)
    emitter.emit('uncaughtException', error)
    expect(output.join('')).toBe('Delorun stopped: the channel answered [redacted:start-token] with [redacted:provider-key]\nWhat you can do:\n  See the full detail in the home process\'s log: delorun logs home --profile work\n')
    expect(output.join('')).not.toContain('    at ')
    await vi.waitFor(() => { expect(exits).toEqual([1]) })
    homeLog.log.close()
    const records = readFileSync(join(home, 'logs', 'home-work', 'home.log'), 'utf8').trim().split('\n').map(line => JSON.parse(line) as { level: string, msg: string, err?: { stack?: string } })
    const fatal = records.find(record => record.level === 'error')
    expect(fatal?.msg).toMatch(/^an uncaught exception stopped the home process: delorun: fatal uncaught exception: Error: the channel answered \[redacted:start-token\] with \[redacted:provider-key\]\n {4}at /u)
    expect(fatal?.err?.stack).toContain('    at ')
    expect(JSON.stringify(records)).not.toContain(token)
    expect(JSON.stringify(records)).not.toContain(PROVIDER_KEY)
    uninstall()
  })
})
