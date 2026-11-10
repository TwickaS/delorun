/**
 * The home process's side of a work session (contract C21, "Work sessions"): the watcher loads each settled edit of
 * the open session's folder into the plugin's active directory and reloads the Host, goes back when the reload fails,
 * and follows sessions opened and ended by `delorun changes work` and `done`; Delo stopping ends the session, and a
 * start after a home process that did not stop ends it first.
 */
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync, type FSWatcher, type WatchListener } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { activeDirectory, attestTerminal, enforceApprovedContent, finishWork, readApproved, readChangeLog, readWorkFailure, readWorkSession, startWork, type ChangesContext, type ReloadHost, type ReloadOutcome } from '@delo/changes'
import type { DeloLogger } from '@delo/logs'
import { afterChangesBoot, startChanges } from '../src/changes/start.ts'
import { WORK_DEBOUNCE_MS, watchWork, type WorkWatch } from '../src/changes/work-watch.ts'

const watched = vi.hoisted(() => ({ calls: [] as { readonly path: string, readonly watcher: FSWatcher, readonly listener: WatchListener<string> }[] }))

vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>()
  return {
    ...fs,
    watch: (path: string, options: { readonly recursive: boolean, readonly persistent: boolean }, listener: WatchListener<string>) => {
      const watcher = fs.watch(path, options, listener)
      watched.calls.push({ path, watcher, listener })
      return watcher
    },
  }
})

// Each case writes real git histories, scans folders and waits for real file events; under a loaded host that takes a while.
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 })

const PROFILE = 'default'
const OK: ReloadOutcome = { ok: true }

let base: string
let home: string
let profileDir: string
let source: string
let logged: { readonly level: string, readonly message: string }[]
let logger: DeloLogger
let open: WorkWatch[]

beforeEach(async () => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'delorun-changes-work-')))
  home = join(base, '.delo')
  mkdirSync(home, { mode: 0o700 })
  source = join(base, 'plug')
  mkdirSync(source)
  writeFileSync(join(source, 'package.json'), '{"name":"plug","version":"1.0.0"}\n')
  writeFileSync(join(source, 'index.js'), 'export default "one"\n')
  profileDir = join(home, 'profiles', PROFILE)
  mkdirSync(join(profileDir, 'node_modules'), { recursive: true })
  writeFileSync(join(profileDir, 'package.json'), `${JSON.stringify({ name: `dsh-profile-${PROFILE}`, private: true, dependencies: { plug: `link:${source}` } }, undefined, 2)}\n`)
  symlinkSync(relative(join(profileDir, 'node_modules'), source), join(profileDir, 'node_modules', 'plug'))
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
})

afterEach(async () => {
  for (const watcher of open.splice(0)) await watcher.close()
  rmSync(base, { recursive: true, force: true })
})

/** @returns the context the library calls run with. */
function ctx(): ChangesContext {
  return { home, profile: PROFILE, profileDir }
}

/** @returns a proof that the person is at a terminal. */
function terminal(): ReturnType<typeof attestTerminal> {
  return attestTerminal({ stdin: { isTTY: true }, stdout: { isTTY: true } })
}

/**
 * A reload that answers each call with the next outcome, then `ok`.
 * @param outcomes - the first answers; undefined means Delo is not running.
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
 * @returns the watcher.
 */
function watching(reload: ReloadHost): WorkWatch {
  const watcher = watchWork({ home, profile: PROFILE, profileDir, reload, logger, debounceMs: 50 })
  open.push(watcher)
  return watcher
}

/** @returns the text of `index.js` in the plugin's active directory. */
function activeIndex(): string {
  return readFileSync(join(activeDirectory(home, PROFILE, 'plug'), 'index.js'), 'utf8')
}

/**
 * @param level - a log level.
 * @returns the messages logged at it.
 */
function messages(level: string): string[] {
  return logged.filter(entry => entry.level === level).map(entry => entry.message)
}

describe('a work session\'s edits load live', () => {
  it('copies a folder edit into the active directory and reloads the Host once', async () => {
    const watcherHost = host()
    const watcher = watching(watcherHost.reload)
    await startWork(ctx(), 'plug', terminal(), host())
    writeFileSync(join(source, 'index.js'), 'export default "two"\n')
    await vi.waitFor(() => {
      expect(activeIndex()).toBe('export default "two"\n')
      expect(messages('info')).toContain('Loaded plug from its folder in your work session.')
    }, { timeout: 60_000, interval: 50 })
    await watcher.close()
    expect(watcherHost.calls()).toBe(1)
    expect((await readWorkSession(home, PROFILE))?.lastLoaded).toBeDefined()
  })

  it('leaves out edits inside .git, and stops watching the folder when the session ends', async () => {
    const watcherHost = host()
    watching(watcherHost.reload)
    await startWork(ctx(), 'plug', terminal(), host())
    await vi.waitFor(() => { expect(watched.calls.map(call => call.path)).toContain(source) }, { timeout: 60_000, interval: 50 })
    mkdirSync(join(source, '.git'))
    writeFileSync(join(source, '.git', 'HEAD'), 'ref: refs/heads/main\n')
    const folderWatch = watched.calls.find(call => call.path === source)!
    folderWatch.listener('rename', null)
    writeFileSync(join(source, 'index.js'), 'export default "two"\n')
    await vi.waitFor(() => { expect(activeIndex()).toBe('export default "two"\n') }, { timeout: 60_000, interval: 50 })
    await finishWork(ctx(), 'plug', terminal(), host())
    await vi.waitFor(() => { expect(messages('info')).toContain(`Delo no longer watches ${source}: the work session on it ended.`) }, { timeout: 60_000, interval: 50 })
    expect(watcherHost.calls()).toBe(1)
    expect(await readWorkSession(home, PROFILE)).toBeUndefined()
  })
})

describe('a failed reload in a work session leaves the previous version running', () => {
  it('puts the content that last loaded back, names the error in changes-work.json, and keeps the session open', async () => {
    const watcherHost = host(OK, { ok: false, error: 'plug threw at start' }, { ok: false, error: 'the old version failed too' })
    watching(watcherHost.reload)
    await startWork(ctx(), 'plug', terminal(), host())
    writeFileSync(join(source, 'index.js'), 'export default "two"\n')
    await vi.waitFor(() => { expect(messages('info')).toContain('Loaded plug from its folder in your work session.') }, { timeout: 60_000, interval: 50 })
    writeFileSync(join(source, 'index.js'), 'throw new Error("broken")\n')
    await vi.waitFor(async () => { expect(await readWorkFailure(home, PROFILE)).toMatchObject({ schema: 'delo.changes-work/1', plugin: 'plug', error: 'plug threw at start' }) }, { timeout: 60_000, interval: 50 })
    await vi.waitFor(() => { expect(messages('error')).toEqual(['Loading the version of plug that last loaded also failed: the old version failed too. Restart Delo.']) }, { timeout: 60_000, interval: 50 })
    expect(activeIndex()).toBe('export default "two"\n')
    expect((await readWorkSession(home, PROFILE))?.plugin).toBe('plug')
    expect(messages('warn')).toContain('plug failed to load from its folder: plug threw at start. Delo went back to the version that last loaded.')
  })

  it('reports a failure when going back finds Delo stopped, and loads nothing while Delo is not running', async () => {
    const watcherHost = host({ ok: false, error: 'plug threw' }, undefined, undefined)
    watching(watcherHost.reload)
    await startWork(ctx(), 'plug', terminal(), host())
    writeFileSync(join(source, 'index.js'), 'throw new Error("broken")\n')
    await vi.waitFor(() => { expect(messages('warn')).toContain('plug failed to load from its folder: plug threw. Delo went back to the version that last loaded.') }, { timeout: 60_000, interval: 50 })
    writeFileSync(join(source, 'index.js'), 'export default "three"\n')
    await vi.waitFor(() => { expect(activeIndex()).toBe('export default "three"\n') }, { timeout: 60_000, interval: 50 })
    expect(messages('error')).toEqual([])
  })
})

describe('the watcher', () => {
  it('reports a folder that is gone, one it cannot watch, a watch error and a record it cannot read', async () => {
    await startWork(ctx(), 'plug', terminal(), host())
    rmSync(source, { recursive: true })
    watching(host().reload)
    await vi.waitFor(() => {
      expect(messages('warn')).toEqual(expect.arrayContaining([
        expect.stringMatching(new RegExp(`^Delo cannot watch ${source} for your work session: .*ENOENT`)),
        'The folder of plug is gone; Delo keeps running the version that last loaded.',
      ]))
    }, { timeout: 60_000, interval: 50 })
    const sessions = watched.calls.find(call => call.path.endsWith(join('profiles', PROFILE)))!
    sessions.watcher.emit('error', new Error('the watch broke'))
    expect(messages('warn')).toContain(`Delo stopped watching ${sessions.path} for your work session: the watch broke`)
    sessions.listener('change', null)
    writeFileSync(join(sessions.path, 'work-session.json'), '{}\n', { mode: 0o600 })
    await vi.waitFor(() => { expect(messages('warn')).toEqual(expect.arrayContaining([expect.stringMatching(/^Delo could not load your work session's folder: .*work-session\.json is not a record Delo wrote/)])) }, { timeout: 60_000, interval: 50 })
  })

  it('reports a failure that is not one of Changes, and closes without a session', async () => {
    const watcher = watching(async () => Promise.reject(new Error('the Host is gone')))
    await startWork(ctx(), 'plug', terminal(), host())
    writeFileSync(join(source, 'index.js'), 'export default "two"\n')
    await vi.waitFor(() => { expect(messages('warn')).toContain('Delo could not load your work session\'s folder: Error: the Host is gone') }, { timeout: 60_000, interval: 50 })
    await watcher.close()
    const idle = watchWork({ home, profile: PROFILE, profileDir, reload: host().reload, logger })
    await idle.close()
    expect(WORK_DEBOUNCE_MS).toBeGreaterThan(0)
  })
})

describe('Delo stopping ends the work session', () => {
  it('stops following sessions and approves what the folder holds when the Host closes', async () => {
    const watcherHost = host()
    const end = afterChangesBoot({ home, profile: PROFILE, logger }, { reload: watcherHost.reload })
    await startWork(ctx(), 'plug', terminal(), host())
    writeFileSync(join(source, 'index.js'), 'export default "two"\n')
    await vi.waitFor(() => { expect(watcherHost.calls()).toBe(1) }, { timeout: 60_000, interval: 50 })
    writeFileSync(join(source, 'index.js'), 'export default "three"\n')
    await end()
    expect(await readWorkSession(home, PROFILE)).toBeUndefined()
    const approved = (await readApproved(profileDir)).plugins.plug
    expect(activeIndex()).toBe('export default "three"\n')
    expect((await readChangeLog(home, PROFILE)).entries.at(-1)).toMatchObject({ kind: 'plugin-edit', state: 'applied', to: approved?.version, decidedFrom: 'terminal' })
    expect(messages('info')).toContain(`Your work session on plug ended as Delo stopped. The folder's content is now the approved version of plug (${(await readChangeLog(home, PROFILE)).entries.at(-1)!.id}).`)
    await afterChangesBoot({ home, profile: PROFILE, logger }, { reload: host().reload })()
  })

  it('logs a session it cannot end, which the next start ends', async () => {
    await startWork(ctx(), 'plug', terminal(), host())
    chmodSync(source, 0o000)
    await afterChangesBoot({ home, profile: PROFILE, logger }, { reload: host().reload })()
    chmodSync(source, 0o700)
    expect(messages('warn')).toEqual(expect.arrayContaining([expect.stringMatching(/^Delo could not end your work session as it stopped; the next start ends it: .*EACCES/)]))
    writeFileSync(join(home, 'changes', 'profiles', PROFILE, 'work-session.json'), '{}\n', { mode: 0o600 })
    await afterChangesBoot({ home, profile: PROFILE, logger }, { reload: host().reload })()
    expect(messages('warn')).toEqual(expect.arrayContaining([expect.stringMatching(/^Delo could not end your work session as it stopped; the next start ends it: .*not a record Delo wrote/)]))
  })
})

describe('a start after a crash finishes the open work session first', () => {
  it('ends a session a home process that did not stop left open before it loads anything, and says so', async () => {
    const context = { printed: [] as string[] }
    await startWork(ctx(), 'plug', terminal(), host())
    writeFileSync(join(source, 'index.js'), 'export default "two"\n')
    await startChanges({ home, profile: PROFILE }, text => void context.printed.push(text))
    expect((await readWorkSession(home, PROFILE))?.plugin).toBe('plug')
    await startChanges({ home, profile: PROFILE, ownsHome: true }, text => void context.printed.push(text))
    expect(await readWorkSession(home, PROFILE)).toBeUndefined()
    const entry = (await readChangeLog(home, PROFILE)).entries.at(-1)!
    expect(entry).toMatchObject({ kind: 'plugin-edit', state: 'applied' })
    expect(context.printed.join('')).toContain(`Your work session on plug ended when Delo stopped. The folder's content is now the approved version of plug (${entry.id}).\n`)
    expect(activeIndex()).toBe('export default "two"\n')
  })
})
