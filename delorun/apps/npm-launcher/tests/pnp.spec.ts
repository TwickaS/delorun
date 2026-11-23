/**
 * The launcher under Yarn's Plug'n'Play: it starts one plain Node process on its own entry file and ends as that process
 * ends, refuses a second re-run and a package that Yarn kept in a zip, and does nothing outside Plug'n'Play.
 */
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { launchEnvironment } from '../src/bin.ts'
import { insideZip, leavePnp, loopRefusal, packedRefusal, PNP_RERUN_ENV, signalStatus, type PnpChild, type PnpSurroundings, type StartPnpChild } from '../src/pnp.ts'

const ENTRY = '/work/.yarn/unplugged/delorun-npm-0.1.0/node_modules/delorun/dist/bin.js'

/** A child process a spec drives by hand. */
function fakeChild(): { child: PnpChild, killed: string[], close: (status: number | null, signal: NodeJS.Signals | null) => void, fail: (error: Error) => void } {
  const listeners: { close?: (status: number | null, signal: NodeJS.Signals | null) => void, error?: (error: Error) => void } = {}
  const killed: string[] = []
  const child: PnpChild = {
    kill: (signal) => { killed.push(signal); return true },
    once: (event: 'close' | 'error', listener: never) => { Object.assign(listeners, { [event]: listener }) },
  }
  return { child, killed, close: (status, signal) => listeners.close?.(status, signal), fail: error => listeners.error?.(error) }
}

/** Surroundings under Plug'n'Play, with a process start and signal registry the spec owns. */
function surroundings(overrides: Partial<PnpSurroundings> & { start?: StartPnpChild } = {}): PnpSurroundings & { registered: Map<string, () => void> } {
  const registered = new Map<string, () => void>()
  return {
    pnp: '3',
    entryUrl: pathToFileURL(ENTRY).href,
    argv: ['--profile', 'work', 'install'],
    env: { PATH: '/bin', NODE_OPTIONS: '--require /work/.pnp.cjs --experimental-loader file:///work/.pnp.loader.mjs', NODE_PATH: '/work/.pnp', LD_PRELOAD: '/tmp/hook.so', HOME: '/home/someone' },
    execPath: '/usr/bin/node',
    pid: 4000,
    parentId: 3999,
    listen: (signal, listener) => { registered.set(signal, listener) },
    unlisten: (signal) => { registered.delete(signal) },
    registered,
    ...overrides,
  }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('leaving Plug\'n\'Play', () => {
  it('starts one plain Node process on the same entry file with the same arguments, without NODE_OPTIONS, NODE_PATH or LD_PRELOAD', async () => {
    const fake = fakeChild()
    const starts: { command: string, args: readonly string[], env: Record<string, string>, stdio: string }[] = []
    const start: StartPnpChild = (command, args, options) => { starts.push({ command, args, env: options.env, stdio: options.stdio }); return fake.child }
    const run = leavePnp(surroundings({ start }))
    expect(starts).toHaveLength(1)
    expect(starts[0]).toMatchObject({ command: '/usr/bin/node', args: [ENTRY, '--profile', 'work', 'install'], stdio: 'inherit' })
    for (const name of ['NODE_OPTIONS', 'NODE_PATH', 'LD_PRELOAD']) expect(starts[0]!.env).not.toHaveProperty(name)
    expect(starts[0]!.env).toMatchObject({ PATH: '/bin', HOME: '/home/someone', [PNP_RERUN_ENV]: '4000' })
    fake.close(0, null)
    await expect(run).resolves.toEqual({ action: 'exit', code: 0 })
  })

  it('keeps the child\'s exit code', async () => {
    const fake = fakeChild()
    const run = leavePnp(surroundings({ start: () => fake.child }))
    fake.close(7, null)
    await expect(run).resolves.toEqual({ action: 'exit', code: 7 })
  })

  it('reports the signal that ended the child, so the caller can raise it', async () => {
    const fake = fakeChild()
    const run = leavePnp(surroundings({ start: () => fake.child }))
    fake.close(null, 'SIGTERM')
    await expect(run).resolves.toEqual({ action: 'signal', signal: 'SIGTERM' })
    expect(signalStatus('SIGTERM')).toBe(143)
  })

  it('passes SIGTERM and SIGHUP on to the child while it runs, leaves SIGINT to the terminal, and stops listening when it ends', async () => {
    const fake = fakeChild()
    const given = surroundings({ start: () => fake.child })
    const run = leavePnp(given)
    expect([...given.registered.keys()].sort()).toEqual(['SIGHUP', 'SIGINT', 'SIGTERM'])
    // The terminal already sends Ctrl-C to the child; this listener only keeps the default from ending the parent.
    given.registered.get('SIGINT')?.()
    expect(fake.killed).toEqual([])
    for (const signal of ['SIGTERM', 'SIGHUP']) given.registered.get(signal)?.()
    expect(fake.killed).toEqual(['SIGTERM', 'SIGHUP'])
    fake.close(130, null)
    await run
    expect(given.registered.size).toBe(0)
  })

  it('rejects, and stops listening, when the child cannot start', async () => {
    const fake = fakeChild()
    const given = surroundings({ start: () => fake.child })
    const run = leavePnp(given)
    fake.fail(new Error('spawn ENOENT'))
    await expect(run).rejects.toThrow('spawn ENOENT')
    expect(given.registered.size).toBe(0)
  })

  it('re-runs nothing without Plug\'n\'Play', async () => {
    const start = vi.fn<StartPnpChild>()
    await expect(leavePnp(surroundings({ pnp: undefined, start }))).resolves.toEqual({ action: 'continue' })
    expect(start).not.toHaveBeenCalled()
  })

  it('refuses a second re-run, and starts no process', async () => {
    const start = vi.fn<StartPnpChild>()
    const outcome = await leavePnp(surroundings({ start, env: { PATH: '/bin', [PNP_RERUN_ENV]: '3999' } }))
    expect(outcome).toEqual({ action: 'refuse', line: loopRefusal() })
    expect(loopRefusal()).not.toContain('\n')
    expect(start).not.toHaveBeenCalled()
  })

  it('re-runs once more for a launcher started by another process that inherited a stale marker', async () => {
    const fake = fakeChild()
    const start = vi.fn<StartPnpChild>(() => fake.child)
    const run = leavePnp(surroundings({ start, env: { PATH: '/bin', [PNP_RERUN_ENV]: '12' } }))
    expect(start).toHaveBeenCalledTimes(1)
    fake.close(0, null)
    await run
  })

  it('refuses with one line when Yarn kept the package in a zip, and starts no process', async () => {
    const zipped = '/work/.yarn/cache/delorun-npm-0.1.0-abc.zip/node_modules/delorun/dist/bin.js'
    const start = vi.fn<StartPnpChild>()
    const outcome = await leavePnp(surroundings({ start, entryUrl: pathToFileURL(zipped).href }))
    expect(outcome).toEqual({ action: 'refuse', line: packedRefusal(zipped) })
    expect(packedRefusal(zipped)).not.toContain('\n')
    expect(packedRefusal(zipped)).toContain('nodeLinker: node-modules')
    expect(packedRefusal(zipped)).toContain('npx delorun')
    expect(start).not.toHaveBeenCalled()
  })

  it('tells a zip path from a real one', () => {
    expect(insideZip('/a/.yarn/cache/x.zip/node_modules/delorun/dist/bin.js')).toBe(true)
    expect(insideZip('/home/someone/.yarn/berry/cache/x.zip/node_modules/delorun/dist/bin.js')).toBe(true)
    expect(insideZip('C:\\a\\.yarn\\cache\\x.zip\\node_modules\\delorun\\dist\\bin.js')).toBe(true)
    // A project folder that happens to be called `x.zip` is a real folder.
    expect(insideZip('/work/x.zip/.yarn/unplugged/delorun-npm-0.1.0/node_modules/delorun/dist/bin.js')).toBe(false)
    expect(insideZip('/work/x.zip/node_modules/delorun/dist/bin.js')).toBe(false)
    expect(insideZip(ENTRY)).toBe(false)
    expect(insideZip('/a/zip/delorun/dist/bin.js')).toBe(false)
  })

  it('keeps the marker out of the runtime\'s environment', () => {
    const runtime = launchEnvironment({ PATH: '/bin', [PNP_RERUN_ENV]: '4000' }, {})
    expect(runtime).toEqual({ PATH: '/bin' })
  })
})
