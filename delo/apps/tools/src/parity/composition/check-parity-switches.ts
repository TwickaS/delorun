/**
 * The `parity-switches` check: `node_modules/.bin/tsx delo/apps/tools/src/parity/composition/check-parity-switches.ts`.
 * It holds the C16 registry against the switch fields in the tree, the parity
 * overlay and the model-visible contributions of Delo-owned sources and
 * ledgered upstream edits, and prints the switch sweep. It prints one line per
 * violation and exits 1; a scenario pending recording is reported as such and
 * fails nothing.
 *
 * @module @delo/tools/parity/composition/check-parity-switches
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { PARITY_OVERLAY_PATH, PARITY_REGISTRY_VERSION, PARITY_SWITCHES, type ParitySwitchEntry } from '@delo/contract-parity-composition'
import { readManifest } from '../../check-fork-boundary.ts'
import { repositoryRoot, runGit } from '../../git.ts'
import { changedLines, contributionErrors, findContributions, type Contribution } from './contributions.ts'
import { LOCAL_BUNDLE_PATCH_PATH, localBundleErrors, overlayErrors, readOverlay } from './overlay.ts'
import { registryErrors, switchMarkers, type SwitchMarker } from './switches.ts'
import { sweep, sweepLine, type SweepRow } from './sweep.ts'

/** What one scan found. */
export interface ParityScan {
  readonly markers: readonly SwitchMarker[]
  readonly contributions: readonly Contribution[]
  readonly sweep: readonly SweepRow[]
  /** Delo-owned source files scanned. */
  readonly deloFiles: number
  /** Ledgered upstream source files scanned. */
  readonly upstreamFiles: number
  readonly errors: readonly string[]
}

/** The inputs of one scan; the defaults read the repository. */
export interface ScanOptions {
  readonly registry?: readonly ParitySwitchEntry[]
  /**
   * The lines a ledgered upstream file changed against the pinned commit, or `all` for a file the commit lacks.
   * The default asks git.
   */
  readonly upstreamChanges?: (path: string) => 'all' | ReadonlySet<number>
}

const SOURCE = /\.tsx?$/u
const TEST = /(?:^|\/)tests?\/|\.(?:spec|test)\.tsx?$|\.d\.ts$/u

function walk(root: string, dir: string, out: string[]): void {
  if (!existsSync(join(root, dir))) return
  for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'lib' || entry.name === 'dist') continue
    const path = `${dir}/${entry.name}`
    if (entry.isDirectory()) walk(root, path, out)
    else if (entry.isFile()) out.push(path)
  }
}

/**
 * The Delo-owned sources the scan reads: TypeScript under a `src` directory of `delo/`, without specs.
 * @param root - the repository root.
 * @returns repository paths, sorted.
 */
export function deloSources(root: string): string[] {
  const files: string[] = []
  walk(root, 'delo', files)
  return files.filter(path => SOURCE.test(path) && path.split('/').includes('src') && !TEST.test(path)).sort()
}

function gitChanges(root: string, commit: string): (path: string) => 'all' | ReadonlySet<number> {
  return (path) => {
    if (runGit(root, ['cat-file', '-e', `${commit}:${path}`]).status !== 0) return 'all'
    const diff = runGit(root, ['diff', '--unified=0', '--no-color', '--no-ext-diff', commit, '--', path])
    if (diff.status !== 0) throw new Error(`git diff ${commit} -- ${path} exited ${String(diff.status)}: ${diff.stderr.trim()}`)
    return changedLines(diff.stdout)
  }
}

function listDir(root: string): (dir: string) => readonly string[] | undefined {
  return (dir) => {
    const path = join(root, dir)
    return existsSync(path) && statSync(path).isDirectory() ? readdirSync(path).sort() : undefined
  }
}

/**
 * Scan a repository.
 * @param root - the repository root; it holds `delo/upstream-patches.json` and the parity overlay.
 * @param options - the registry and the upstream change source, for fixtures.
 * @returns the switch fields, the contributions, the sweep and every violation.
 */
export function scanParity(root: string, options: ScanOptions = {}): ParityScan {
  const registry = options.registry ?? PARITY_SWITCHES
  const manifest = readManifest(root)
  const upstreamChanges = options.upstreamChanges ?? gitChanges(root, manifest.upstream.commit)
  const read = (path: string): string => readFileSync(join(root, path), 'utf8')
  const delo = deloSources(root)
  const upstream = manifest.patches.map(patch => patch.path)
    .filter(path => /^(?:packages|apps)\//u.test(path) && SOURCE.test(path) && !TEST.test(path) && existsSync(join(root, path)))
    .sort()
  const fieldSources = registry.flatMap(entry => entry.state === 'built' && existsSync(join(root, entry.field.source)) ? [entry.field.source] : [])
  const markers = [...new Set([...delo, ...upstream, ...fieldSources])].flatMap(path => switchMarkers(path, read(path)))
  const contributions = [
    ...delo.flatMap(path => findContributions(path, read(path), 'all')),
    ...upstream.flatMap(path => findContributions(path, read(path), upstreamChanges(path))),
  ]
  const errors = [
    ...registryErrors(registry, markers, path => existsSync(join(root, path))),
    ...contributionErrors(contributions, registry),
  ]
  try {
    const overlay = readOverlay(read(PARITY_OVERLAY_PATH))
    errors.push(...overlayErrors(overlay.switches, registry), ...localBundleErrors(overlay.localBundle, read(LOCAL_BUNDLE_PATCH_PATH)))
  } catch (error) {
    errors.push(`${PARITY_OVERLAY_PATH}: ${error instanceof Error ? error.message : String(error)}`)
  }
  const swept = sweep(registry, { list: listDir(root) })
  errors.push(...swept.errors)
  return { markers, contributions, sweep: swept.rows, deloFiles: delo.length, upstreamFiles: upstream.length, errors }
}

/**
 * The report a scan prints.
 * @param scan - the scan.
 * @param registry - the registry it ran against.
 * @returns the lines, the violations last.
 */
export function report(scan: ParityScan, registry: readonly ParitySwitchEntry[] = PARITY_SWITCHES): string[] {
  const built = registry.filter(entry => entry.state === 'built').length
  const files = new Set(scan.contributions.map(contribution => contribution.path))
  const pending = scan.sweep.filter(row => row.state.kind === 'pending recording').length
  return [
    `parity-switches: registry version ${String(PARITY_REGISTRY_VERSION)}, ${String(registry.length)} entries (${String(built)} built, ${String(registry.length - built)} planned), ${String(scan.markers.length)} switch fields in the tree`,
    `parity-switches: ${String(scan.contributions.length)} model-visible contributions in ${String(files.size)} files, from ${String(scan.deloFiles)} Delo-owned and ${String(scan.upstreamFiles)} ledgered upstream source files`,
    ...scan.sweep.map(row => `  sweep ${sweepLine(row)}`),
    `parity-switches: ${String(pending)} switch-on scenario(s) pending recording, which this check does not count as passing`,
    ...scan.errors,
    scan.errors.length === 0 ? 'parity-switches: ok' : `parity-switches: ${String(scan.errors.length)} violation(s)`,
  ]
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const scan = scanParity(repositoryRoot(process.cwd()))
  for (const line of report(scan)) console.log(line)
  process.exitCode = scan.errors.length === 0 ? 0 : 1
}
