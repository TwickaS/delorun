/**
 * The runtime closures the suites install: one Linux x64 closure built from the measured commit by the release
 * recipe (`build-closure.ts`), kept in the benchmark cache, and release closures derived from it under other versions
 * with the release tooling's own steps: the closure is unpacked, `stampDeloVersion` stamps the version, and
 * `archiveClosure` writes the deterministic archive and its unsigned file list. A derived closure can carry a
 * `data-formats.json` that differs from the base's in one record of Delo's, so an update between two derived
 * versions reports a data change and offers the session-data copy, as a release that changes a record would.
 *
 * Building the base closure is a release build, not a measurement: `benchmark:delo -- --prepare` runs it outside the
 * isolated network, and the measured run refuses to start without it.
 *
 * @module @delo/benchmarks/fixtures/closure
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DATA_FORMATS_FILE } from '@delo/contract-update-report'
import { archiveClosure } from '@delo/release/closure/archive-closure'
import { stampDeloVersion } from '@delo/release/closure/delo'
import { closureFileNames } from '@delo/release/closure/tree'
import { dataFormatsText, parseDataFormats } from '@delo/update/data-formats'
import { expectSuccess, run } from '../harness/processes.ts'
import { removeTree } from '../harness/roots.ts'

/** The platform every benchmark closure is built for. */
export const BENCH_PLATFORM = 'linux-x64'

/** The version the base closure is built under; derived closures carry their own. */
export const BASE_VERSION = '0.0.0-bench.0'

/** The modification time of every entry of a derived archive. */
const DERIVED_EPOCH = 1_793_981_656

/** The record a changed data format adds to `deloRecords`; no product reads it. */
export const CHANGED_FORMAT_RECORD = 'benchmark-changed-format'

/** A closure's release files in a directory, as `build-closure.ts` leaves them. */
export interface ClosureDirectory {
  /** The directory. */
  readonly directory: string
  /** The version the files are named for. */
  readonly version: string
}

/** Which `data-formats.json` a derived closure carries. */
export type DataFormatVariant = 'base' | 'changed'

/**
 * The cache directory of one commit's closures.
 * @param cache - the benchmark cache.
 * @param commit - the measured commit.
 * @returns `<cache>/closures/<commit>`.
 */
export function closureCache(cache: string, commit: string): string {
  return join(cache, 'closures', commit)
}

/**
 * The base closure of a commit, if it was built.
 * @param cache - the benchmark cache.
 * @param commit - the measured commit.
 * @returns the closure's directory, or `undefined`.
 */
export function cachedBase(cache: string, commit: string): ClosureDirectory | undefined {
  const directory = join(closureCache(cache, commit), 'base')
  const names = closureFileNames(BASE_VERSION, BENCH_PLATFORM)
  return existsSync(join(directory, names.archive)) && existsSync(join(directory, names.files)) ? { directory, version: BASE_VERSION } : undefined
}

/**
 * Build the base closure of the worktree's commit with the release recipe, from the artifacts already built in the
 * worktree (`--artifacts existing`), into the cache.
 * @param repository - the repository root.
 * @param cache - the benchmark cache.
 * @param commit - the commit, which the worktree must be at with no tracked change.
 * @param log - receives progress text.
 * @returns the closure's directory.
 * @throws {Error} when the recipe refuses or fails.
 */
export async function buildBase(repository: string, cache: string, commit: string, log: (text: string) => void): Promise<ClosureDirectory> {
  const target = join(closureCache(cache, commit), 'base')
  const building = `${target}.building`
  removeTree(building)
  mkdirSync(building, { recursive: true })
  await waitForOtherClosureBuilds(log)
  log(`building the base closure of ${commit.slice(0, 12)} with the release recipe; this takes minutes`)
  const shims = cycleTolerantPnpm(join(cache, 'build-shims'))
  const finished = await run({
    command: join(repository, 'node_modules/.bin/tsx'),
    args: [join(repository, 'delo/apps/release/src/build-closure.ts'), '--version', BASE_VERSION, '--out', building, '--platform', BENCH_PLATFORM, '--artifacts', 'existing', '--commit', commit],
    env: { ...process.env, PATH: `${shims}:${process.env.PATH ?? ''}` },
    cwd: repository,
    timeoutMs: 3_600_000,
    onLine: line => { log(`  ${line.text}`) },
  })
  expectSuccess(finished, 'build-closure.ts')
  removeTree(target)
  renameSync(building, target)
  return { directory: target, version: BASE_VERSION }
}

/**
 * Wait while another `build-closure.ts` runs on this machine: the recipe's build root is one fixed directory, and two
 * builds at once remove each other's.
 * @param log - receives progress text.
 * @param running - lists the other builds' process ids; `pgrep` by default.
 * @param pause - waits between checks.
 */
export async function waitForOtherClosureBuilds(log: (text: string) => void, running: () => readonly number[] = otherClosureBuilds, pause: () => Promise<void> = () => new Promise(resolve => setTimeout(resolve, 10_000))): Promise<void> {
  for (let others = running(); others.length > 0; others = running()) {
    log(`waiting for the closure build in process ${others.join(', ')}, which uses the same build root`)
    await pause()
  }
}

/**
 * The process ids of `build-closure.ts` runs on this machine.
 * @returns the ids.
 */
function otherClosureBuilds(): readonly number[] {
  try {
    return execFileSync('pgrep', ['-f', 'release/src/build-closure\\.ts'], { encoding: 'utf8' }).split('\n').map(Number).filter(pid => pid > 0 && pid !== process.pid)
  } catch (_none) {
    // pgrep exits 1 when nothing matches.
    return []
  }
}

/**
 * A `pnpm` that runs the `pnpm` on `PATH` with workspace cycles allowed. The recipe's `pnpm --filter ./delo/packages/*
 * run build` stops on the cycle through `@delo/release`, `@delo/runtime-closure` and `@delo/cli` (`ERR_PNPM_TASK_CYCLE`),
 * though only packages outside the cycle have a build script; the recipe passes no variable through to its steps but
 * `PATH`, so the benchmark's base build puts this first on it. A published release does not use it.
 * @param directory - where to write it.
 * @returns the directory to put first on `PATH`.
 * @throws {Error} when no `pnpm` is on `PATH`.
 */
export function cycleTolerantPnpm(directory: string): string {
  const pnpm = execFileSync('sh', ['-c', 'command -v pnpm'], { encoding: 'utf8' }).trim()
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, 'pnpm'), `#!/bin/sh\npnpm_config_ignore_workspace_cycles=true exec '${pnpm}' "$@"\n`, { mode: 0o755 })
  return directory
}

/**
 * Take a closure built elsewhere: the one `delorun-<version>-linux-x64.tar.gz` and its `.files.json` in a directory.
 * @param directory - the directory `build-closure.ts --out` wrote.
 * @returns the closure.
 * @throws {Error} when the directory holds no Linux x64 closure or more than one.
 */
export function closureFrom(directory: string): ClosureDirectory {
  const versions = readdirSync(directory).map(name => /^delorun-(.+)-linux-x64\.tar\.gz$/u.exec(name)?.[1]).filter((version): version is string => version !== undefined)
  if (versions.length !== 1) throw new Error(`${directory} holds ${String(versions.length)} Linux x64 closure archives; pass a directory with exactly one`)
  const version = versions[0]!
  if (!existsSync(join(directory, closureFileNames(version, BENCH_PLATFORM).files))) throw new Error(`${directory} has the archive of ${version} but not its file list`)
  return { directory, version }
}

/**
 * A closure derived from the base under another version, kept in the cache.
 * @param base - the base closure.
 * @param cache - the commit's closure cache.
 * @param version - the derived version.
 * @param variant - which `data-formats.json` it carries.
 * @returns the derived closure's directory.
 * @throws {Error} when unpacking, stamping or archiving fails.
 */
export async function derivedClosure(base: ClosureDirectory, cache: string, version: string, variant: DataFormatVariant): Promise<ClosureDirectory> {
  const target = join(cache, `${version}-${variant}`)
  const names = closureFileNames(version, BENCH_PLATFORM)
  if (existsSync(join(target, names.archive)) && existsSync(join(target, names.files))) return { directory: target, version }
  const work = `${target}.building`
  removeTree(work)
  const stage = join(work, 'stage')
  const out = join(work, 'out')
  mkdirSync(stage, { recursive: true })
  mkdirSync(out)
  execFileSync('tar', ['-x', '-z', '-f', join(base.directory, closureFileNames(base.version, BENCH_PLATFORM).archive), '-C', stage])
  await stampDeloVersion(join(stage, 'app', 'node_modules'), version)
  if (variant === 'changed') {
    const path = join(stage, DATA_FORMATS_FILE)
    const formats = parseDataFormats(readFileSync(path, 'utf8'))
    writeFileSync(path, dataFormatsText({ ...formats, deloRecords: { ...formats.deloRecords, [CHANGED_FORMAT_RECORD]: 1 } }))
  }
  await archiveClosure({ stage, outDir: out, version, platform: BENCH_PLATFORM, epoch: DERIVED_EPOCH, pins: undefined, requireLaunchFiles: true })
  removeTree(target)
  renameSync(out, target)
  removeTree(work)
  return { directory: target, version }
}
