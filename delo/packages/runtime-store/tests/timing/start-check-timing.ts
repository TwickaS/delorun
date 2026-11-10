/**
 * Timing probe (not part of the package) for the start check, the install and an update's prepare, on a signed
 * synthetic runtime of a real runtime's size in a throwaway home. It compares the behaviour before the identity record
 * (every start hashing every file, an install re-reading every staged file, each check of an update hashing again) with
 * the behaviour after it (a start comparing recorded identities, an install confirming the identities its fill
 * reported, an update sharing one check per runtime). Install and prepare times leave out the fill's own writes, which
 * both sides share; `sync` runs before each install so one side's writeback does not slow the other.
 *
 * `node_modules/.bin/tsx delo/packages/runtime-store/tests/timing/start-check-timing.ts [--files 35287]
 * [--megabytes 770] [--repeat 3] [--base <directory>]`. It needs about four times the runtime's size free under the
 * base directory, the system's temporary directory by default, and removes everything it wrote.
 * `DELO_TIMING_CPU_PROFILE=<directory>` writes a CPU profile of each fresh-process start check there.
 */
import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statfsSync, writeFileSync } from 'node:fs'
import { open } from 'node:fs/promises'
import { cpus, loadavg, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { DELO_HOME_ENTRIES, TRUST_FILES } from '@delo/contract-home-layout'
import type { RuntimeFileList } from '@delo/contract-release-manifest'
import { identityOf, installedFileMode, RuntimeStore, SUPPORTED, type FilledRelease } from '../../src/index.ts'
import { makeWritable, PLATFORM, RecordingLogger, rootFile, sha256, signedRelease, throwawayKeys, version } from '../support.ts'

/** What one run measures. */
interface Options {
  readonly files: number
  readonly megabytes: number
  readonly repeat: number
  readonly base: string
}

/**
 * The command line's options.
 * @param argv - the arguments after the script.
 * @returns the options.
 */
function options(argv: readonly string[]): Options {
  const value = (name: string, fallback: string): string => {
    const at = argv.indexOf(`--${name}`)
    return at === -1 ? fallback : argv[at + 1] ?? fallback
  }
  return { files: Number(value('files', '35287')), megabytes: Number(value('megabytes', '770')), repeat: Number(value('repeat', '3')), base: value('base', tmpdir()) }
}

/**
 * Milliseconds an operation takes.
 * @param work - the operation.
 * @returns the elapsed milliseconds.
 */
async function timed(work: () => Promise<unknown>): Promise<number> {
  const started = performance.now()
  await work()
  return performance.now() - started
}

/**
 * The median of samples.
 * @param samples - the samples.
 * @returns the median.
 */
function median(samples: readonly number[]): number {
  const sorted = [...samples].sort((left, right) => left - right)
  return sorted[Math.floor(sorted.length / 2)]!
}

/**
 * A synthetic closure's paths and contents: launch protocol 1's two files, then files in package directories of about
 * a dozen files each, with lengths spread around the mean, cut from a shared random pool so hashing costs what a
 * real file of that length costs.
 * @param count - the number of files.
 * @param bytes - their total length.
 * @returns the closure's file list entries and a function giving each file's bytes.
 */
function closure(count: number, bytes: number): { readonly entries: RuntimeFileList['files'], readonly content: (index: number) => Buffer } {
  const pool = randomBytes(32 * 1024 * 1024)
  const mean = Math.floor(bytes / count)
  const paths = ['app/node_modules/@delo/cli/src/bin.js', 'node/bin/node']
  for (let index = paths.length; index < count; index++) paths.push(`app/node_modules/package-${String(Math.floor(index / 12)).padStart(5, '0')}/lib/file-${String(index % 12)}.js`)
  paths.sort()
  const content = (index: number): Buffer => {
    const length = Math.max(16, Math.floor(mean * (0.1 + 1.8 * ((index * 7919) % 1000) / 1000)))
    const offset = (index * 104_729) % (pool.length - length)
    return Buffer.concat([Buffer.from(`${String(index)}\n`), pool.subarray(offset, offset + length)])
  }
  const entries = paths.map((path, index) => {
    const data = content(index)
    return { path, length: data.byteLength, sha256: sha256(data), mode: path === 'node/bin/node' ? '0755' as const : '0644' as const }
  })
  return { entries, content }
}

/**
 * A fill that writes every file the way the launcher's extraction does: created exclusively at its installed mode
 * from bytes in memory, with its identity taken after the write when `report` is set.
 * @param entries - the file list's entries.
 * @param content - each file's bytes.
 * @param release - the signed release files.
 * @param report - whether to report the identities.
 * @returns the fill.
 */
function fill(entries: RuntimeFileList['files'], content: (index: number) => Buffer, release: FilledRelease, report: boolean): (directory: string) => Promise<FilledRelease> {
  return async (directory) => {
    const identities = new Map<string, string>()
    const made = new Set<string>()
    for (const [index, entry] of entries.entries()) {
      const target = join(directory, ...entry.path.split('/'))
      if (!made.has(dirname(target))) {
        mkdirSync(dirname(target), { recursive: true, mode: 0o755 })
        made.add(dirname(target))
      }
      const handle = await open(target, 'wx', installedFileMode(entry.mode))
      await handle.writeFile(content(index))
      identities.set(entry.path, identityOf(await handle.stat({ bigint: true })))
      await handle.close()
    }
    const manifest = JSON.parse(Buffer.from(release.manifest).toString('utf8')) as { signed: { runtime: Record<string, { files: { sha256: string } }> } }
    return report ? { ...release, staged: { fileList: manifest.signed.runtime[PLATFORM]!.files.sha256, identities } } : release
  }
}

/**
 * The conditions of the run: the machine, the file system and the load.
 * @param base - the directory measured under.
 * @returns one line.
 */
function conditions(base: string): string {
  const pressure = (() => {
    try {
      return readFileSync('/proc/pressure/io', 'utf8').split('\n')[0]!
    } catch {
      // No pressure stall information on this kernel.
      return 'unavailable'
    }
  })()
  return `${String(cpus().length)} CPUs (${cpus()[0]!.model.trim()}), Node ${process.version}, file system 0x${statfsSync(base).type.toString(16)}, load ${loadavg().map(value => value.toFixed(1)).join(' ')}, I/O pressure ${pressure}`
}

const MODES = { child: 'child' } as const

if (process.argv[2] === MODES.child) {
  // A fresh process: open the store, run one start check and report its own elapsed time.
  const [, , , home = '', days = '7'] = process.argv
  const started = performance.now()
  const store = new RuntimeStore({ home, platform: PLATFORM, logger: new RecordingLogger() })
  const root = JSON.parse(readFileSync(join(home, DELO_HOME_ENTRIES.trust, TRUST_FILES.root), 'utf8')) as { signed: Parameters<RuntimeStore['checkRuntime']>[1] }
  await store.prepareLaunch({ launcher: SUPPORTED, root: root.signed, mode: 'enforce', fullCheckDays: Number(days), profile: 'default', args: [] })
  process.stdout.write(`${String(performance.now() - started)}\n`)
} else {
  const run = options(process.argv.slice(2))
  const home = mkdtempSync(join(run.base, 'delo-start-check-timing-'))
  try {
    for (const entry of [DELO_HOME_ENTRIES.runtimes, DELO_HOME_ENTRIES.staging, DELO_HOME_ENTRIES.trust]) mkdirSync(join(home, entry), { mode: 0o700 })
    const keys = throwawayKeys()
    const root = rootFile(keys)
    writeFileSync(join(home, DELO_HOME_ENTRIES.trust, TRUST_FILES.root), root.bytes, { mode: 0o600 })
    const logger = new RecordingLogger()
    const store = new RuntimeStore({ home, platform: PLATFORM, logger })
    const before = conditions(home)
    const { entries, content } = closure(run.files, run.megabytes * 1024 * 1024)
    const total = entries.reduce((sum, entry) => sum + entry.length, 0)
    const signed = (release: string): FilledRelease => signedRelease(keys.targets, release, entries)
    const rows: Array<[string, number]> = []
    const flush = (): void => { spawnSync('sync', { timeout: 300_000 }) }
    /** Install a version and return the time the store spent beyond the fill's own writes. */
    const install = async (release: string, report: boolean): Promise<number> => {
      const write = fill(entries, content, signed(release), report)
      let filling = 0
      flush()
      const total = await timed(() => store.install({ version: version(release), root: root.metadata, fill: async (directory) => {
        const started = performance.now()
        const result = await write(directory)
        filling = performance.now() - started
        return result
      } }))
      return total - filling
    }
    rows.push(['Install, the store re-reading every staged file, beyond the fill (before)', await install('1.0.0', false)])
    rows.push(['Install, the store confirming the reported identities, beyond the fill (after)', await install('2.0.0', true)])
    await store.switchTo(version('1.0.0'), version('2.0.0'))
    const launch = (days: number) => () => store.prepareLaunch({ launcher: SUPPORTED, root: root.metadata, mode: 'enforce', fullCheckDays: days, profile: 'default', args: [] })
    flush()
    rows.push(['First start after that install, in process (after)', await timed(launch(7))])
    const samples = async (work: () => Promise<unknown>): Promise<number> => {
      const all: number[] = []
      for (let index = 0; index < run.repeat; index++) all.push(await timed(work))
      return median(all)
    }
    rows.push(['Start check hashing every file, in process (before)', await samples(launch(0))])
    rows.push(['Start check with a settled record, in process (after)', await samples(launch(7))])
    const fresh = (days: number) => async (): Promise<void> => {
      const profile = process.env['DELO_TIMING_CPU_PROFILE']
      const child = spawnSync(process.execPath, [...process.execArgv, ...profile === undefined ? [] : ['--cpu-prof', `--cpu-prof-dir=${profile}`], process.argv[1]!, MODES.child, home, String(days)], { encoding: 'utf8', timeout: 600_000 })
      if (child.status !== 0) throw new Error(`the timing child failed: ${child.stderr}`)
    }
    rows.push(['Start check hashing every file, fresh process with module loading (before)', await samples(fresh(0))])
    rows.push(['Start check with a settled record, fresh process with module loading (after)', await samples(fresh(7))])
    /** An update's prepare: the opener's check of the running runtime, the target's install, then the report's four checks. */
    const prepare = async (target: string, report: boolean): Promise<number> => {
      const running = version('2.0.0')
      const opener = await timed(() => store.checkRuntime(running, root.metadata))
      const installing = await install(target, report)
      const reading = await timed(() => Promise.all([
        store.checkRuntime(running, root.metadata),
        store.checkRuntime(running, root.metadata),
        store.checkRuntime(version(target), root.metadata),
        store.checkRuntime(version(target), root.metadata),
      ]))
      return opener + installing + reading
    }
    rows.push(['Update prepare beyond the fill: opener check, install and the report readers, each checking alone (before)', await prepare('3.0.0', false)])
    await store.retain()
    rows.push(['Update prepare beyond the fill, sharing one check per runtime (after)', await store.shareChecks(() => prepare('4.0.0', true))])
    process.stdout.write([
      `Runtime: ${String(entries.length)} files, ${(total / 1024 / 1024).toFixed(0)} MiB; medians of ${String(run.repeat)} for the start checks, one sample otherwise`,
      `Before: ${before}`,
      `After: ${conditions(home)}`,
      '',
      '| Operation | Time |',
      '| --- | --- |',
      ...rows.map(([name, ms]) => `| ${name} | ${ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${ms.toFixed(0)} ms`} |`),
      '',
    ].join('\n'))
  } finally {
    makeWritable(home)
    rmSync(home, { recursive: true, force: true })
  }
}
