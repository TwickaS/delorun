/**
 * The home process's live reload while protection is off (contract C21, "The protection setting"): the watcher loads
 * each settled save in a linked plugin's folder into the running Host as an applied change decided `unreviewed`, goes
 * back when the reload fails, follows the protection setting and the profile's links without a restart, leaves `.git`
 * out, and waits for a load in progress when it closes. The watches and `loadUnreviewed` are the real ones, observed
 * through wrappers.
 */
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync, type FSWatcher, type WatchListener } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { withFileLock } from '@deepseek-ai/dsh-atomic-write'
import { activeDirectory, attestTerminal, ChangesError, enforceApprovedContent, prepareReload, readApproved, readChangeLog, setProtection, type ReloadHost, type ReloadOutcome, type UnreviewedSync } from '@delorun/changes'
import type { DelorunLogger } from '@delorun/logs'
import { openHistory } from '@delorun/profile-safety'
import { watchUnreviewed, type UnreviewedWatch } from '../src/changes/unreviewed-watch.ts'

/** Every watch opened, and whether it was closed. */
const watched = vi.hoisted(() => ({ calls: [] as { readonly path: string, readonly watcher: FSWatcher, readonly listener: WatchListener<string>, closed: boolean }[] }))

/** What the wrapped `loadUnreviewed` and `unreviewedFolders` do besides calling the real ones. */
const hooks = vi.hoisted(() => ({
  loads: [] as string[],
  /** How many loads have finished. */
  settled: 0,
  /** Runs before the real load; a result replaces it. */
  beforeLoad: undefined as ((plugin: string) => Promise<UnreviewedSync | undefined>) | undefined,
  /** Thrown by the next look at which folders to watch. */
  foldersError: undefined as Error | undefined,
}))

vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>()
  return {
    ...fs,
    watch: (path: string, options: { readonly recursive: boolean, readonly persistent: boolean }, listener: WatchListener<string>) => {
      const watcher = fs.watch(path, options, listener)
      const call = { path, watcher, listener, closed: false }
      const close = watcher.close.bind(watcher)
      watcher.close = () => {
        call.closed = true
        close()
      }
      watched.calls.push(call)
      return watcher
    },
  }
})

/** How long each profile-lock acquisition waited, in milliseconds. */
const lockWaits = vi.hoisted(() => ({ ms: [] as number[] }))

vi.mock('@deepseek-ai/dsh-atomic-write', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@deepseek-ai/dsh-atomic-write')>()
  return {
    ...actual,
    withFileLock: async <T>(filename: string, operation: () => Promise<T>, options?: { readonly waitMs?: number }): Promise<T> => {
      const asked = Date.now()
      return actual.withFileLock(filename, () => {
        lockWaits.ms.push(Date.now() - asked)
        return operation()
      }, options)
    },
  }
})

vi.mock('@delorun/changes', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@delorun/changes')>()
  return {
    ...actual,
    loadUnreviewed: async (...args: Parameters<typeof actual.loadUnreviewed>) => {
      hooks.loads.push(args[1])
      try {
        const replaced = await hooks.beforeLoad?.(args[1])
        return replaced ?? await actual.loadUnreviewed(...args)
      } finally {
        hooks.settled += 1
      }
    },
    unreviewedFolders: async (...args: Parameters<typeof actual.unreviewedFolders>) => {
      const error = hooks.foldersError
      hooks.foldersError = undefined
      if (error !== undefined) throw error
      return actual.unreviewedFolders(...args)
    },
  }
})

// Each case writes real git histories, scans folders and waits for real file events; under a loaded host that takes a while.
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 })

const PROFILE = 'default'
const OK: ReloadOutcome = { ok: true }
const WAIT = { timeout: 60_000, interval: 50 }
const DEBOUNCE_MS = 50

let base: string
let home: string
let profileDir: string
let source: string
let logged: { readonly level: string, readonly message: string }[]
let logger: DelorunLogger
let open: UnreviewedWatch[]

beforeEach(async () => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'delorun-unreviewed-watch-')))
  home = join(base, '.delorun')
  mkdirSync(home, { mode: 0o700 })
  profileDir = join(home, 'profiles', PROFILE)
  mkdirSync(join(profileDir, 'node_modules'), { recursive: true })
  writeFileSync(join(profileDir, 'package.json'), `${JSON.stringify({ name: `dsh-profile-${PROFILE}`, private: true, dependencies: {} }, undefined, 2)}\n`)
  source = linkFolder('plug')
  // The home has no protection record, so protection is off.
  await enforceApprovedContent({ home, profile: PROFILE, profileDir })
  logged = []
  logger = {
    error: (message) => { logged.push({ level: 'error', message }) },
    warn: (message) => { logged.push({ level: 'warn', message }) },
    info: (message) => { logged.push({ level: 'info', message }) },
    debug: () => {},
  }
  open = []
  watched.calls = []
  hooks.loads = []
  hooks.settled = 0
  hooks.beforeLoad = undefined
  hooks.foldersError = undefined
  lockWaits.ms = []
})

afterEach(async () => {
  for (const watcher of open.splice(0)) await watcher.close()
  rmSync(base, { recursive: true, force: true })
})

/**
 * A plugin folder linked into the profile, as `delorun plugin add link:<folder>` leaves it.
 * @param name - the package name and the folder's name.
 * @param parent - the folder that holds the plugin's folder.
 * @returns the folder.
 */
function linkFolder(name: string, parent = base): string {
  const folder = join(parent, name)
  mkdirSync(folder, { recursive: true })
  writeFileSync(join(folder, 'package.json'), `{"name":"${name}","version":"1.0.0"}\n`)
  writeFileSync(join(folder, 'index.js'), 'export default "one"\n')
  const manifestPath = join(profileDir, 'package.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { dependencies: Record<string, string> }
  manifest.dependencies[name] = `link:${folder}`
  writeFileSync(manifestPath, `${JSON.stringify(manifest, undefined, 2)}\n`)
  symlinkSync(relative(join(profileDir, 'node_modules'), folder), join(profileDir, 'node_modules', name))
  return folder
}

/**
 * A reload that answers each call with the next outcome, then `ok`.
 * @param outcomes - the first answers; undefined means Delorun is not running.
 * @returns the reload and its number of calls.
 */
function host(...outcomes: (ReloadOutcome | undefined)[]): { readonly reload: ReloadHost, readonly calls: () => number } {
  let calls = 0
  return {
    reload: async () => {
      calls += 1
      return Promise.resolve(outcomes.length === 0 ? OK : outcomes.shift())
    },
    calls: () => calls,
  }
}

/**
 * Start a watcher that the spec closes afterwards.
 * @param reload - the Host's reload.
 * @param debounceMs - how long events settle.
 * @returns the watcher.
 */
function watching(reload: ReloadHost, debounceMs = DEBOUNCE_MS): UnreviewedWatch {
  const watcher = watchUnreviewed({ home, profile: PROFILE, profileDir, reload, logger, debounceMs })
  open.push(watcher)
  return watcher
}

/**
 * Wait until the folder is watched and the load the new watch schedules has finished.
 * @param folder - the plugin's folder.
 * @param loads - how many loads have finished by then.
 * @returns the folder's open watch.
 */
async function watchedFolder(folder: string, loads = 1): Promise<(typeof watched.calls)[number]> {
  await vi.waitFor(() => {
    expect(watched.calls.some(call => call.path === folder && !call.closed)).toBe(true)
    expect(hooks.settled).toBeGreaterThanOrEqual(loads)
  }, WAIT)
  return watched.calls.findLast(call => call.path === folder && !call.closed)!
}

/**
 * @param level - a log level.
 * @returns the messages logged at it.
 */
function messages(level: string): string[] {
  return logged.filter(entry => entry.level === level).map(entry => entry.message)
}

/** @returns the text of `index.js` in plug's active directory. */
function activeIndex(): string {
  return readFileSync(join(activeDirectory(home, PROFILE, 'plug'), 'index.js'), 'utf8')
}

/** @returns the changes logged as loaded without review. */
async function unreviewedEntries(): Promise<Awaited<ReturnType<typeof readChangeLog>>['entries']> {
  return (await readChangeLog(home, PROFILE)).entries.filter(entry => entry.decidedFrom === 'unreviewed')
}

describe('a save in a linked plugin\'s folder loads live while protection is off', () => {
  it('lets several packs install back to back, and a start with them settle, without one profile-lock wait over a second', async () => {
    const names = ['one', 'two', 'three', 'four']
    watching(host().reload)
    await watchedFolder(source)
    lockWaits.ms = []
    const started = Date.now()
    for (const name of names) {
      // A pack install as the plugin manager runs it: the profile lock held while the link is written and the Host reloads.
      const pack = linkFolder(name, join(home, 'packs', 'current'))
      await withFileLock(join(profileDir, 'package.json'), async () => {
        await enforceApprovedContent({ home, profile: PROFILE, profileDir, lockWaitMs: 1_000 }).catch(() => undefined)
        await new Promise<void>((resolve) => { setTimeout(resolve, 1_200) })
      }, { waitMs: 5_000 })
      writeFileSync(join(pack, 'index.js'), 'export default "later"\n')
    }
    // A start's watcher over the same profile.
    const restarted = watching(host().reload)
    await new Promise<void>((resolve) => { setTimeout(resolve, DEBOUNCE_MS * 10) })
    await restarted.close()
    expect(Math.max(...lockWaits.ms)).toBeLessThan(1_000)
    expect(Date.now() - started).toBeLessThan(15_000)
    expect(messages('warn')).toEqual([])
    expect(hooks.loads.filter(plugin => names.includes(plugin))).toEqual([])
  })

  it('neither watches nor loads an unpacked plugin pack, so a pack install and a start never queue it for the profile lock', async () => {
    const pack = linkFolder('packed', join(home, 'packs', 'current'))
    await enforceApprovedContent({ home, profile: PROFILE, profileDir })
    watching(host().reload)
    await watchedFolder(source)
    writeFileSync(join(pack, 'index.js'), 'export default "two"\n')
    await new Promise<void>((resolve) => { setTimeout(resolve, DEBOUNCE_MS * 6) })
    expect(watched.calls.some(call => call.path === pack)).toBe(false)
    expect(hooks.loads).not.toContain('packed')
  })

  it('reloads the Host and logs an applied change decided unreviewed with one history version', async () => {
    const from = (await readApproved(profileDir)).plugins.plug!.version
    const watcherHost = host()
    watching(watcherHost.reload)
    await watchedFolder(source)
    const versions = (await openHistory({ profileDir }).list(50)).length
    writeFileSync(join(source, 'index.js'), 'export default "two"\n')
    await vi.waitFor(async () => { expect(await unreviewedEntries()).toHaveLength(1) }, WAIT)
    const [entry] = await unreviewedEntries()
    await vi.waitFor(() => { expect(messages('info')).toContain(`Loaded plug from its folder without review, because protection is off (${entry!.id}).`) }, WAIT)
    expect(entry).toMatchObject({ kind: 'plugin-edit', state: 'applied', from, subject: { plugin: 'plug', source }, historyVersion: expect.stringMatching(/^[0-9a-f]{40}$/u) })
    expect(watcherHost.calls()).toBe(1)
    expect(activeIndex()).toBe('export default "two"\n')
    expect((await readApproved(profileDir)).plugins.plug!.version).toBe(entry!.to)
    const history = await openHistory({ profileDir }).list(50)
    expect(history).toHaveLength(versions + 1)
    expect(history[0]!.summary).toBe(`Loaded without review: plug: changes in ${source}`)
  })

  it('a burst of saves within the debounce loads once, with the last save', async () => {
    const watcherHost = host()
    watching(watcherHost.reload, 1_000)
    await watchedFolder(source)
    const before = hooks.loads.length
    for (const text of ['two', 'three', 'four']) {
      writeFileSync(join(source, 'index.js'), `export default "${text}"\n`)
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    await vi.waitFor(() => {
      expect(watcherHost.calls()).toBe(1)
      expect(hooks.settled).toBe(before + 1)
    }, WAIT)
    expect(activeIndex()).toBe('export default "four"\n')
    expect(hooks.loads.length - before).toBe(1)
    expect(await unreviewedEntries()).toHaveLength(1)
  })

  it('logs that Delorun is not running when no Host answers, and the content loads at the next start', async () => {
    watching(host(undefined).reload)
    await watchedFolder(source)
    writeFileSync(join(source, 'index.js'), 'export default "two"\n')
    await vi.waitFor(() => { expect(messages('info')).toEqual([expect.stringMatching(/^Loaded plug from its folder without review, because protection is off \(c[0-9a-f]{10}\)\.$/u)]) }, WAIT)
    expect(activeIndex()).toBe('export default "two"\n')
  })
})

describe('a failed live reload goes back', () => {
  it('puts back what ran before and logs the change pending with the failure', async () => {
    const from = (await readApproved(profileDir)).plugins.plug!.version
    const watcherHost = host({ ok: false, error: 'plug threw at start' }, { ok: false, error: 'the old version failed too' })
    watching(watcherHost.reload)
    await watchedFolder(source)
    writeFileSync(join(source, 'index.js'), 'throw new Error("broken")\n')
    await vi.waitFor(() => { expect(messages('error')).toEqual(['Loading the version of plug that ran before also failed: the old version failed too. Restart Delorun.']) }, WAIT)
    const entry = (await readChangeLog(home, PROFILE)).entries.at(-1)!
    expect(entry).toMatchObject({ kind: 'plugin-edit', state: 'pending', lastFailure: { failure: 'plug threw at start' } })
    expect(messages('warn')).toEqual([`plug failed to load from its folder: plug threw at start. Delorun went back to the version that ran before (${entry.id}).`])
    expect((await readApproved(profileDir)).plugins.plug!.version).toBe(from)
    expect(activeIndex()).toBe('export default "one"\n')
    expect(watcherHost.calls()).toBe(2)
  })

  it('logs no second failure when going back loads, or finds Delorun stopped', async () => {
    for (const again of [OK, undefined]) {
      logged.length = 0
      const watcher = watching(host({ ok: false, error: 'plug threw' }, again).reload)
      await watchedFolder(source, hooks.settled + 1)
      writeFileSync(join(source, 'index.js'), `throw new Error("${String(again?.ok)}")\n`)
      await vi.waitFor(() => { expect(messages('warn')).toEqual([expect.stringMatching(/^plug failed to load from its folder: plug threw\. Delorun went back/u)]) }, WAIT)
      await watcher.close()
      expect(messages('error')).toEqual([])
    }
  })
})

describe('the watcher follows the protection setting and the profile', () => {
  it('turning protection on stops the live loads without a restart, and turning it off again resumes them', async () => {
    const watcherHost = host()
    watching(watcherHost.reload)
    const first = await watchedFolder(source)
    await setProtection(home, 'on', attestTerminal({ stdin: { isTTY: true }, stdout: { isTTY: true } }))
    await vi.waitFor(() => { expect(first.closed).toBe(true) }, WAIT)
    writeFileSync(join(source, 'index.js'), 'export default "two"\n')
    expect(watched.calls.filter(call => call.path === source && !call.closed)).toEqual([])
    rmSync(join(home, 'changes', 'protection.json'))
    await vi.waitFor(() => { expect(watcherHost.calls()).toBe(1) }, WAIT)
    expect(activeIndex()).toBe('export default "two"\n')
    expect(watched.calls.filter(call => call.path === source)).toHaveLength(2)
    expect(await unreviewedEntries()).toHaveLength(1)
  })

  it('a plugin linked while Delorun runs is watched, and an event for another file of the profile changes nothing', async () => {
    const watcherHost = host()
    watching(watcherHost.reload)
    await watchedFolder(source)
    const manifestWatch = watched.calls.find(call => call.path === profileDir)!
    manifestWatch.listener('change', 'package-lock.json')
    const other = linkFolder('other')
    // `delorun plugin add link:<folder>` moves the link to the active directory, which loads the folder while protection is off.
    await prepareReload({ home, profile: PROFILE, profileDir })
    const otherWatch = await watchedFolder(other)
    writeFileSync(join(other, 'index.js'), 'export default "two"\n')
    await vi.waitFor(() => { expect(watcherHost.calls()).toBe(1) }, WAIT)
    expect(readFileSync(join(activeDirectory(home, PROFILE, 'other'), 'index.js'), 'utf8')).toBe('export default "two"\n')
    expect(watched.calls.filter(call => call.path === source)).toHaveLength(1)
    // A plugin removed from the profile is no longer watched.
    const manifestPath = join(profileDir, 'package.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { dependencies: Record<string, string> }
    delete manifest.dependencies.other
    writeFileSync(manifestPath, `${JSON.stringify(manifest, undefined, 2)}\n`)
    await vi.waitFor(() => { expect(otherWatch.closed).toBe(true) }, WAIT)
  })

  it('leaves out events inside .git and for other files of changes/', async () => {
    watching(host().reload)
    const folder = await watchedFolder(source)
    const setting = watched.calls.find(call => call.path === join(home, 'changes'))!
    const before = hooks.loads.length
    folder.listener('rename', join('.git', 'HEAD'))
    setting.listener('change', 'store')
    await new Promise(resolve => setTimeout(resolve, DEBOUNCE_MS * 6))
    expect(hooks.loads.length).toBe(before)
    expect(watched.calls.filter(call => call.path === source)).toHaveLength(1)
    folder.listener('change', null)
    await vi.waitFor(() => { expect(hooks.loads.length).toBe(before + 1) }, WAIT)
  })

  it('reports a folder it cannot watch, which it tries again when the profile changes', async () => {
    rmSync(source, { recursive: true })
    const reloads = host()
    watching(reloads.reload)
    await vi.waitFor(() => { expect(messages('warn')).toEqual([expect.stringMatching(new RegExp(`^Delorun cannot watch ${source} to reload plug live: .*ENOENT`, 'u'))]) }, WAIT)
    mkdirSync(source)
    writeFileSync(join(source, 'package.json'), '{"name":"plug","version":"1.0.0"}\n')
    writeFileSync(join(source, 'index.js'), 'export default "back"\n')
    watched.calls.find(call => call.path === profileDir)!.listener('change', 'package.json')
    await vi.waitFor(() => { expect(reloads.calls()).toBe(1) }, WAIT)
    expect(activeIndex()).toBe('export default "back"\n')
  })

  it('reports when it cannot tell which folders to watch, as a refusal of Changes or another failure', async () => {
    hooks.foldersError = new Error('the disk is gone')
    watching(host().reload)
    await vi.waitFor(() => { expect(messages('warn')).toEqual(['Delorun could not tell which plugin folders to reload live: Error: the disk is gone']) }, WAIT)
    writeFileSync(join(home, 'changes', 'protection.json'), '{}\n', { mode: 0o600 })
    await vi.waitFor(() => { expect(messages('warn')[1]).toMatch(/^Delorun could not tell which plugin folders to reload live: .*protection\.json/u) }, WAIT)
  })
})

describe('what one live load reports', () => {
  it('logs a folder it cannot read and a failed load, and nothing for a load with nothing to do', async () => {
    const results: (UnreviewedSync | Error)[] = [
      { kind: 'unreadable', plugin: 'plug', detail: 'it changed while it was read' },
      new ChangesError('RECORD_UNREADABLE', 'log.json', 'log.json is not a record Delorun wrote'),
      new Error('the Host is gone'),
      { kind: 'protected', plugin: 'plug' },
      { kind: 'skipped', plugin: 'plug' },
    ]
    hooks.beforeLoad = async () => {
      const next = results.shift()
      if (next instanceof Error) throw next
      return Promise.resolve(next ?? { kind: 'unchanged', plugin: 'plug' })
    }
    watching(host().reload)
    // The load the new watch schedules reports the first result.
    const folder = await watchedFolder(source)
    for (let index = 0; index < 4; index += 1) {
      folder.listener('change', 'index.js')
      await vi.waitFor(() => { expect(hooks.loads).toHaveLength(index + 2) }, WAIT)
    }
    await vi.waitFor(() => {
      expect(messages('warn')).toEqual([
        'Delorun could not read the folder of plug, so it keeps running what it ran: it changed while it was read',
        'Delorun could not load plug from its folder: log.json is not a record Delorun wrote',
        'Delorun could not load plug from its folder: Error: the Host is gone',
      ])
    }, WAIT)
    expect(messages('info')).toEqual([])
  })
})

describe('closing the watcher', () => {
  it('waits for a load in progress, and runs no load that was queued behind it', async () => {
    let release = (): void => {}
    let entered = 0
    hooks.beforeLoad = async () => {
      entered += 1
      if (entered !== 2) return undefined
      return new Promise<undefined>((resolve) => { release = () => { resolve(undefined) } })
    }
    const watcherHost = host()
    const watcher = watchUnreviewed({ home, profile: PROFILE, profileDir, reload: watcherHost.reload, logger, debounceMs: DEBOUNCE_MS })
    const folder = await watchedFolder(source)
    writeFileSync(join(source, 'index.js'), 'export default "two"\n')
    folder.listener('change', 'index.js')
    await vi.waitFor(() => { expect(entered).toBe(2) }, WAIT)
    // A save while the load runs queues one more load behind it.
    folder.listener('change', 'index.js')
    await new Promise(resolve => setTimeout(resolve, DEBOUNCE_MS * 4))
    let closed = false
    const closing = watcher.close().then(() => { closed = true })
    await new Promise(resolve => setImmediate(resolve))
    expect(closed).toBe(false)
    release()
    await closing
    expect(activeIndex()).toBe('export default "two"\n')
    expect(watcherHost.calls()).toBe(1)
    expect(entered).toBe(2)
    expect(watched.calls.every(call => call.closed)).toBe(true)
  })

  it('closes at once after it started, before it looked at the profile', async () => {
    const watcher = watchUnreviewed({ home, profile: PROFILE, profileDir, reload: host().reload, logger })
    await watcher.close()
    expect(watched.calls.map(call => call.path)).toEqual([join(home, 'changes'), profileDir])
    expect(hooks.loads).toEqual([])
  })
})
