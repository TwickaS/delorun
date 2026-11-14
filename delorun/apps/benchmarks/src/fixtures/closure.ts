/**
 * The runtime closures the suites install: one Linux x64 closure built from the measured commit by the release
 * recipe (`build-closure.ts`), kept in the benchmark cache, and release closures derived from it under other versions
 * with the release tooling's own steps: the closure is unpacked, `stampDelorunVersion` stamps the version, and
 * `archiveClosure` writes the deterministic archive and its unsigned file list. A derived closure can carry a
 * `data-formats.json` that differs from the base's in one record of Delorun's, so an update between two derived
 * versions reports a data change and offers the session-data copy, as a release that changes a record would.
 *
 * Building the base closure is a release build, not a measurement: `benchmark:delorun -- --prepare` runs it outside the
 * isolated network, and the measured run refuses to start without it.
 *
 * @module @delorun/benchmarks/fixtures/closure
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DATA_FORMATS_FILE } from '@delorun/contract-update-report'
import { archiveClosure } from '@delorun/release/closure/archive-closure'
import { stampDelorunVersion } from '@delorun/release/closure/delorun'
import { closureFileNames } from '@delorun/release/closure/tree'
import { dataFormatsText, parseDataFormats } from '@delorun/update/data-formats'
import { expectSuccess, run } from '../harness/processes.ts'
import { removeTree } from '../harness/roots.ts'

/** The platform every benchmark closure is built for. */
export const BENCH_PLATFORM = 'linux-x64'

/** The version the base closure is built under; derived closures carry their own. */
export const BASE_VERSION = '0.0.0-bench.0'

/** The modification time of every entry of a derived archive. */
const DERIVED_EPOCH = 1_793_981_656

/** The record a changed data format adds to `delorunRecords`; no product reads it. */
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
  log(`building the base closure of ${commit.slice(0, 12)} with the release recipe; this takes minutes`)
  const finished = await run({
    command: join(repository, 'node_modules/.bin/tsx'),
    args: [join(repository, 'delorun/apps/release/src/build-closure.ts'), '--version', BASE_VERSION, '--out', building, '--platform', BENCH_PLATFORM, '--artifacts', 'existing', '--commit', commit],
    env: process.env,
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
  await stampDelorunVersion(join(stage, 'app', 'node_modules'), version)
  if (variant === 'changed') {
    const path = join(stage, DATA_FORMATS_FILE)
    const formats = parseDataFormats(readFileSync(path, 'utf8'))
    writeFileSync(path, dataFormatsText({ ...formats, delorunRecords: { ...formats.delorunRecords, [CHANGED_FORMAT_RECORD]: 1 } }))
  }
  await archiveClosure({ stage, outDir: out, version, platform: BENCH_PLATFORM, epoch: DERIVED_EPOCH, pins: undefined, requireLaunchFiles: true })
  removeTree(target)
  renameSync(out, target)
  removeTree(work)
  return { directory: target, version }
}
