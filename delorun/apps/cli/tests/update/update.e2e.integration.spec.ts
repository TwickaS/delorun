/**
 * `delorun update` and `delorun recover rollback` end to end over a temporary home: fake releases signed with keys
 * generated here are installed into C1's store, a home process runs in this process with the CLI's real update
 * support (the store, the report's readers, the profile history, the session-data copies and the one rollback
 * function), each successor is a fake runtime's own process answering the handover, and the commands run as a person
 * runs them. The four rounds: an update that passes its health check; one that fails it and rolls back on its own;
 * one whose data changes, taken with a copy, then rolled back, which restores the copy and sets the newer chat aside;
 * and the same without a copy, whose rollback refuses until `--profile-only`.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import { composition, HARNESS_RECORD_SCHEMA, readHarnessLog, readHarnessRecord, storeFileVersion, withHarnessLock, writeHarnessRecord, type ChangeId, type HarnessRecord } from '@delorun/changes'
import { DELORUN_HOME_ENTRIES, TRUST_FILES, type RuntimeVersion } from '@delorun/contract-home-layout'
import { ensureHomeTree, newStartId, processExists, readHomeLock, runDirectory } from '@delorun/home'
import { CountingChatGate, HomeProcess, journalPath, readJournal, updateChannelProbe, type RunningHost } from '@delorun/home-process'
import { Redactor, type DelorunLogger } from '@delorun/logs'
import { RuntimeStore, type TrustedRootSource } from '@delorun/runtime-store'
import { EXIT } from '../../src/exit.ts'
import { main } from '../../src/main.ts'
import { runtimePlatformOf } from '../../src/update/channel.ts'
import { runUpdate, type UpdatePrompts } from '../../src/update/command.ts'
import { storeReportSources } from '../../src/update/sources.ts'
import { homeUpdateSupport } from '../../src/update/support.ts'
import { FakeChannel, fakeClosure, signedRelease, throwawayRoot, writeClosure, type FakeBehaviour } from './support.ts'
import { preStartSteps, runPreStartSteps } from '../../src/pre-start.ts'

const PROFILE = 'default'
const TIMEOUT = { timeout: 120_000 }
const platform = runtimePlatformOf(process.platform, process.arch)
const v = (text: string): RuntimeVersion => brandString<RuntimeVersion>(text)
const SAME = 'a'.repeat(64)
const NEWER = 'b'.repeat(64)

/** The fake releases: 1.1.0 reads 1.0.0's data; 1.2.0 fails its health check; 1.2.0 and 1.3.0 change the data. */
const RELEASES = new Map<string, FakeBehaviour>([
  ['1.0.0', { healthy: true, persistence: SAME }],
  ['1.1.0', { healthy: true, persistence: SAME }],
  ['1.2.0', { healthy: false, persistence: NEWER }],
  ['1.3.0', { healthy: true, persistence: NEWER }],
])

const SILENT: DelorunLogger = { error: () => {}, warn: () => {}, info: () => {}, debug: () => {} }
const NO_TERMINAL: UpdatePrompts = { confirm: async () => Promise.resolve(false), copy: async () => Promise.resolve(true), agree: async () => Promise.resolve(undefined) }

let base: string
let home: string
let osHome: string
let channel: FakeChannel
let store: RuntimeStore
/** The stored root, anchored as the launcher's roots would anchor it: the throwaway root the home stores. */
let anchored: TrustedRootSource

beforeAll(async () => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'dup-')))
  osHome = join(base, 'o')
  home = join(base, 'h')
  mkdirSync(osHome, { mode: 0o700 })
  await ensureHomeTree(home, PROFILE)
  const root = throwawayRoot()
  anchored = async () => Promise.resolve(root.metadata)
  writeFileSync(join(home, DELORUN_HOME_ENTRIES.trust, TRUST_FILES.root), root.bytes, { mode: 0o600 })
  // The roots of the launcher that started this Delorun, which `delorun recover rollback` anchors the stored root on.
  mkdirSync(join(base, 'launcher-roots'), { mode: 0o700 })
  writeFileSync(join(base, 'launcher-roots', '1.root.json'), root.bytes)
  const profileDir = join(home, 'profiles', PROFILE)
  mkdirSync(profileDir, { recursive: true, mode: 0o700 })
  writeFileSync(join(profileDir, 'package.json'), `${JSON.stringify({ name: 'dsh-profile-default', private: true, dependencies: {}, dsh: { profile: { bundles: [] } } }, undefined, 2)}\n`)
  writeFileSync(join(profileDir, 'cordis.patch.yml'), '')
  mkdirSync(join(home, 'sessions', 'from-before'), { recursive: true })
  writeFileSync(join(home, 'sessions', 'from-before', 'log.jsonl'), 'before\n')
  store = new RuntimeStore({ home, platform, logger: SILENT })
  channel = new FakeChannel(home, root.metadata, root.keys.targets, platform, RELEASES, v('1.1.0'))
  const first = fakeClosure('1.0.0', RELEASES.get('1.0.0')!)
  await store.install({ version: v('1.0.0'), root: root.metadata, fill: async (directory) => {
    writeClosure(directory, first)
    return Promise.resolve(signedRelease(root.keys.targets, platform, '1.0.0', first))
  } })
})

afterAll(() => {
  // Installed runtimes are read-only, as C1 installs them; the owner's write permission comes back before removal.
  execFileSync('chmod', ['-R', 'u+rwX', base], { timeout: 30_000 })
  rmSync(base, { recursive: true, force: true })
})

/** A started in-process home process on the version `current` names, and how to end it. */
interface Running {
  readonly exits: number[]
  readonly end: () => Promise<void>
}

/** A Host that boots at once, counts no chats and passes the health check. */
function host(): RunningHost {
  return { chats: new CountingChatGate(), failedRows: () => [], rows: () => [], protection: () => undefined, studio: () => undefined, studioLink: () => ({ kind: 'unavailable', reason: 'the Host serves no studio' }), check: async () => Promise.resolve({ passed: true }), reload: async () => Promise.resolve({ ok: true }), close: async () => Promise.resolve(), suspend: async () => Promise.resolve() }
}

/**
 * Wait until the process the home lock names has ended. After a commit the lock names the successor, a fake runtime's
 * process that ends a moment after its commit and that this process then reaps; a home process, or a `recover
 * rollback` with none running, that takes the lock before then meets a live holder that no longer answers.
 */
async function successorEnded(): Promise<void> {
  await until(() => {
    const holder = readHomeLock(runDirectory(home, PROFILE))
    return holder === undefined || !processExists(holder.pid)
  }, 'the previous successor\'s exit')
}

/**
 * Start the home process on the version `current` names, with the CLI's update support.
 * @returns the process's exit codes and its stop.
 */
async function startHome(): Promise<Running> {
  await successorEnded()
  const { current } = await store.pointers()
  const exits: number[] = []
  const listeners: (() => void)[] = []
  const process_ = await HomeProcess.start({
    home, profile: PROFILE, running: current, startId: newStartId(), host: { boot: async () => Promise.resolve(host()) },
    preStart: () => runPreStartSteps(preStartSteps({ migrations: () => [], pluginChanges: () => Promise.resolve() }), { home, profile: PROFILE, kind: 'cli', successor: false, output: { stdout: () => undefined, stderr: () => undefined } }),
    probe: updateChannelProbe(home, PROFILE), logger: SILENT, redactor: new Redactor(),
    updates: homeUpdateSupport({ home, profile: PROFILE, store, root: anchored, fullCheckDays: 7, openChannel: channel.open, sources: storeReportSources({ home, profile: PROFILE, store, running: current, root: anchored, fullCheckDays: 7 }), now: () => new Date() }),
    supervisor: undefined,
    onExit: (listener) => { listeners.push(listener) },
    onSignal: () => () => {},
    exit: (code) => { exits.push(code) },
  })
  return {
    exits,
    end: async () => {
      if (exits.length === 0) await process_.shutdown(0)
      for (const listener of listeners.splice(0)) listener()
    },
  }
}

/**
 * Run `delorun` in this process against the temporary home.
 * @param args - the arguments.
 * @returns the exit code and both outputs.
 */
async function delorun(args: readonly string[]): Promise<{ readonly code: number | undefined, readonly stdout: string, readonly stderr: string }> {
  let stdout = ''
  let stderr = ''
  const context = { env: { ...process.env, HOME: osHome, USERPROFILE: osHome, DELORUN_HOME: home, DELORUN_LAUNCHER_ROOTS: join(base, 'launcher-roots') }, stdout: (text: string) => { stdout += text }, stderr: (text: string) => { stderr += text } }
  const code = args[0] === 'update' ? await runUpdate(args.slice(1), context, NO_TERMINAL, { runtime: () => ({ version: brandString<RuntimeVersion>('1.0.0'), store: true }) }) : await main(args, context)
  return { code, stdout, stderr }
}

/**
 * Wait until a condition holds.
 * @param condition - the condition.
 * @param what - what is awaited, for the failure.
 */
async function until(condition: () => boolean | Promise<boolean>, what: string): Promise<void> {
  const deadline = Date.now() + 60_000
  while (!await condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise(resolve => setTimeout(resolve, 50))
  }
}

/** Whether a chat directory exists under `sessions/`. */
const chat = (name: string): boolean => existsSync(join(home, 'sessions', name))

describe('delorun update end to end', TIMEOUT, () => {
  it('commits an update that passes its health check, without a copy when the data does not change', async () => {
    const running = await startHome()
    try {
      const result = await delorun(['update', '--yes'])
      expect(result.stderr).toBe('')
      expect(result.code).toBe(EXIT.ok)
      expect(result.stdout).toContain('Update from Delorun 1.0.0 (DSH 0.2.2) to Delorun 1.1.0')
      expect(result.stdout).toContain('… checking\n✔ Found release 1.1.0 on the stable channel\n… installing\n')
      expect(channel.recorded).toEqual([v('1.1.0')])
      expect(result.stdout).not.toContain('Chat data:')
      expect(result.stdout).toContain('Delorun 1.1.0 runs now.')
      expect((await store.pointers()).current).toBe('1.1.0')
      await until(async () => (await readJournal(journalPath(home, PROFILE)).catch(() => undefined))?.phase === 'committed', 'the successor\'s commit')
      expect(readdirSync(join(home, 'data-copies'))).toEqual([])
    } finally {
      await running.end()
    }
  })

  it('rolls an update that fails its health check back on its own, restoring the copy it took', async () => {
    channel.next = v('1.2.0')
    const running = await startHome()
    try {
      const result = await delorun(['update', '--yes'])
      expect(result.stdout).toContain('Chat data: Delorun 1.2.0 keeps chat data in a format Delorun 1.1.0 may not read.')
      expect(result.code).toBe(EXIT.failed)
      expect(result.stderr).toContain('Delorun 1.2.0 failed its health check (HEALTH_CHECK_FAILED); Delorun 1.1.0 runs again')
      expect((await store.pointers()).current).toBe('1.1.0')
      expect(chat('opened-by-1.2.0')).toBe(false)
      expect(chat('from-before')).toBe(true)
      expect(readdirSync(join(home, 'data-set-aside'))).toHaveLength(1)
    } finally {
      await running.end()
    }
  })

  it('c03-yes-takes-the-copy, then c03-pointer-swap-applies-the-table: the rollback restores the copy and sets the newer chat aside', async () => {
    channel.next = v('1.3.0')
    // The person approved a change to a file of Delorun 1.1.0 itself, which 1.3.0 ships unchanged.
    const file = 'app/node_modules/@delorun/cli/package.json'
    const stored = async (text: string): Promise<Awaited<ReturnType<typeof storeFileVersion>>> => storeFileVersion(home, file, Buffer.from(text), false)
    const approved: HarnessRecord = {
      schema: HARNESS_RECORD_SCHEMA, runtime: '1.1.0',
      files: { [file]: { version: await stored('{"name":"@delorun/cli","type":"module","edited":true}\n'), signed: await stored('{"name":"@delorun/cli","type":"module"}\n'), change: 'c0123456789' as ChangeId, approvedAt: '2026-11-11T00:00:00.000Z' } },
    }
    await withHarnessLock(home, async () => writeHarnessRecord(home, approved))
    const composed = await composition(home, '1.1.0')
    const running = await startHome()
    try {
      const result = await delorun(['update', '--yes'])
      expect(result.code).toBe(EXIT.ok)
      expect(result.stdout).toContain(`Your change to ${file} carries over to Delorun 1.3.0.`)
      expect((await readHarnessRecord(home, '1.3.0')).files[file]?.version).toBe(approved.files[file]!.version)
      expect((await readHarnessLog(home)).entries).toMatchObject([{ state: 'applied', decidedFrom: 'update', subject: { file, runtime: '1.3.0' } }])
      expect(result.stdout).toContain('Without the copy, Delorun cannot go back to 1.1.0 after 1.3.0 first starts.')
      expect(result.stdout).toContain('The chat data from before is copied in data-copies/1.3.0.')
      await until(async () => (await readJournal(journalPath(home, PROFILE)).catch(() => undefined))?.phase === 'committed', 'the successor\'s commit')
    } finally {
      await running.end()
    }
    expect(await readJournal(journalPath(home, PROFILE))).toMatchObject({ from: '1.1.0', to: '1.3.0', dataDiffers: true, copy: true, targetStarted: true })
    expect(chat('opened-by-1.3.0')).toBe(true)
    const status = await delorun(['recover', 'status'])
    expect(status.stdout).toContain('Chat-data copy: data-copies/1.3.0')
    await successorEnded()
    const rolled = await delorun(['recover', 'rollback'])
    expect(rolled.stderr).toBe('')
    expect(rolled.code).toBe(EXIT.ok)
    expect(rolled.stdout).toContain('Went back from Delorun 1.3.0 to Delorun 1.1.0')
    expect(rolled.stdout).toMatch(/1 chat\(s\) created or changed since the update are set aside in data-set-aside\/1\.3\.0-/u)
    expect(await store.pointers()).toEqual({ current: '1.1.0', previous: '1.3.0' })
    expect(chat('opened-by-1.3.0')).toBe(false)
    expect(chat('from-before')).toBe(true)
    expect(readdirSync(join(home, 'data-set-aside')).some(name => name.startsWith('1.3.0-'))).toBe(true)
    // Delorun 1.1.0 runs its own approved files again: the update wrote nothing of its harness.
    expect(await readHarnessRecord(home, '1.1.0')).toEqual(approved)
    expect(await composition(home, '1.1.0')).toEqual(composed)
    // The record goes once Delorun 1.1.0 starts healthy, which the next round's start does.
    expect(await readJournal(journalPath(home, PROFILE))).toMatchObject({ phase: 'rolling-back', from: '1.1.0', to: '1.3.0' })
  })

  it('without a copy, the rollback refuses with ROLLBACK_NEEDS_DATA_COPY and --profile-only keeps the target', async () => {
    const running = await startHome()
    // Delorun 1.1.0 started healthy: the rollback's record went, and the record of the update to 1.1.0 is back.
    expect(await readJournal(journalPath(home, PROFILE))).toMatchObject({ phase: 'committed', from: '1.0.0', to: '1.1.0' })
    try {
      const result = await delorun(['update', '--yes', '--no-data-copy'])
      expect(result.code).toBe(EXIT.ok)
      expect(result.stdout).toContain('Continuing without the copy.')
      await until(async () => (await readJournal(journalPath(home, PROFILE)).catch(() => undefined))?.phase === 'committed', 'the successor\'s commit')
    } finally {
      await running.end()
    }
    await successorEnded()
    const refused = await delorun(['recover', 'rollback'])
    expect(refused.code).toBe(EXIT.failed)
    expect(refused.stderr).toContain('ROLLBACK_NEEDS_DATA_COPY')
    expect(refused.stderr).toContain('--profile-only')
    expect((await store.pointers()).current).toBe('1.3.0')
    expect(chat('opened-by-1.3.0')).toBe(true)
    const profileOnly = await delorun(['recover', 'rollback', '--profile-only'])
    expect(profileOnly.code).toBe(EXIT.ok)
    expect(profileOnly.stdout).toContain('Delorun 1.3.0 keeps running.')
    expect((await store.pointers()).current).toBe('1.3.0')
    expect(chat('opened-by-1.3.0')).toBe(true)
    expect(JSON.parse(readFileSync(join(home, 'profiles', PROFILE, 'delorun-safety.json'), 'utf8'))).toMatchObject({ update: { from: '1.1.0', to: '1.3.0', state: 'rolled-back' } })
  })
})
