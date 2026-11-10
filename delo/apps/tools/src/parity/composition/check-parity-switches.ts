/**
 * The `parity-switches` check: `node_modules/.bin/tsx delo/apps/tools/src/parity/composition/check-parity-switches.ts`.
 * It holds the C16 registry against the switch fields in the tree, the parity
 * overlay and the model-visible contributions of Delo-owned sources and
 * ledgered upstream edits, less the diff hunks a security entry records as not
 * model-visible, and prints the switch sweep. It prints one line per
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
import { contributionErrors, diffHunks, findContributions, hunkLines, passNonModelVisibleHunks, type Contribution, type DiffHunk } from './contributions.ts'
import { LOCAL_BUNDLE_PATCH_PATH, localBundleErrors, overlayErrors, parsePatchFile, readOverlay, type ParsedOverlay } from './overlay.ts'
import { presenceErrors, registryErrors, switchMarkers, type RowSetting, type SwitchMarker } from './switches.ts'
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
   * The hunks of a ledgered upstream file's diff against the pinned commit, or `all` for a file the commit lacks.
   * The default asks git.
   */
  readonly upstreamChanges?: (path: string) => 'all' | readonly DiffHunk[]
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

/**
 * Read the zero-context diff hunks of each ledgered upstream file's working-tree content against a commit.
 * @param root - the repository root.
 * @param commit - the pinned upstream commit.
 * @returns a reader that gives `all` for a path the commit lacks, otherwise the file's hunks.
 */
export function gitChanges(root: string, commit: string): (path: string) => 'all' | DiffHunk[] {
  return (path) => {
    if (runGit(root, ['cat-file', '-e', `${commit}:${path}`]).status !== 0) return 'all'
    const diff = runGit(root, ['diff', '--unified=0', '--no-color', '--no-ext-diff', commit, '--', path])
    if (diff.status !== 0) throw new Error(`git diff ${commit} -- ${path} exited ${String(diff.status)}: ${diff.stderr.trim()}`)
    return diffHunks(diff.stdout)
  }
}

function listDir(root: string): (dir: string) => readonly string[] | undefined {
  return (dir) => {
    const path = join(root, dir)
    return existsSync(path) && statSync(path).isDirectory() ? readdirSync(path).sort() : undefined
  }
}

/** The bundle whose rows name the module of every upstream entry the compositions share. */
export const BASE_PATCH_PATH = 'packages/bundle/base/cordis.patch.yml'

/** `@delo/bundle-studio`'s patch, which every Delo CLI profile lists after `@delo/bundle-local`'s. */
export const STUDIO_BUNDLE_PATCH_PATH = 'delo/packages/bundle-studio/cordis.patch.yml'

/** The keys the Delo rows of each composition set. */
export interface CompositionSettings {
  /** Delo's default composition: the rows of `@delo/bundle-local`'s and `@delo/bundle-studio`'s patches. */
  readonly shipped: readonly RowSetting[]
  /** The parity composition: the overlay's restatement of that bundle in its parity form, and the overlay's own rows. */
  readonly parity: readonly RowSetting[]
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * The keys the Delo rows of Delo's default composition and of the parity composition set. A row's module is the
 * `name` it carries, otherwise the module the base bundle or `@delo/bundle-local` mounts under its id.
 * @param read - reads a repository path.
 * @param overlay - the parsed parity overlay.
 * @returns the settings of each composition.
 * @throws Error when the base bundle's, the local bundle's or the studio bundle's patch cannot be read or parsed.
 */
export function compositionSettings(read: (path: string) => string, overlay: ParsedOverlay): CompositionSettings {
  const rowsOf = (patches: readonly Record<string, unknown>[]): Record<string, unknown>[] =>
    patches.flatMap(row => Array.isArray(row['insert']) ? row['insert'].filter(isRecord) : [row])
  const local = rowsOf(parsePatchFile(read(LOCAL_BUNDLE_PATCH_PATH), LOCAL_BUNDLE_PATCH_PATH))
  const studio = rowsOf(parsePatchFile(read(STUDIO_BUNDLE_PATCH_PATH), STUDIO_BUNDLE_PATCH_PATH))
  const moduleOf = new Map([...rowsOf(parsePatchFile(read(BASE_PATCH_PATH), BASE_PATCH_PATH)), ...local]
    .flatMap(row => typeof row['id'] === 'string' && typeof row['name'] === 'string' ? [[row['id'], row['name']] as const] : []))
  const settings = (rows: readonly Record<string, unknown>[]): RowSetting[] => rows.flatMap((row) => {
    const module = typeof row['name'] === 'string' ? row['name'] : moduleOf.get(String(row['id']))
    const config = row['config']
    if (module === undefined || !isRecord(config)) return []
    return Object.entries(config).map(([key, value]) => ({ module, key, value }))
  })
  return { shipped: settings([...local, ...studio]), parity: settings([...rowsOf(overlay.localBundle), ...overlay.switches.map(row => ({ ...row }))]) }
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
  const scanned = manifest.patches
    .filter(({ path }) => /^(?:packages|apps)\//u.test(path) && SOURCE.test(path) && !TEST.test(path) && existsSync(join(root, path)))
    .sort((a, b) => a.path < b.path ? -1 : 1)
  const upstream = scanned.map(patch => patch.path)
  const fieldSources = registry.flatMap(entry => entry.state === 'built' && existsSync(join(root, entry.field.source)) ? [entry.field.source] : [])
  const markers = [...new Set([...delo, ...upstream, ...fieldSources])].flatMap(path => switchMarkers(path, read(path)))
  const recordErrors = manifest.patches.flatMap(patch => patch.nonModelVisibleHunks !== undefined && !upstream.includes(patch.path)
    ? [`${patch.path}: records \`nonModelVisibleHunks\`, but parity-switches reads no contributions in this file; remove them`]
    : [])
  const contributions = [
    ...delo.flatMap(path => findContributions(path, read(path), 'all')),
    ...scanned.flatMap((patch) => {
      const edited = upstreamChanges(patch.path)
      const found = findContributions(patch.path, read(patch.path), edited === 'all' ? 'all' : hunkLines(edited))
      const passed = passNonModelVisibleHunks(patch.path, found, edited, patch.class === 'security' ? patch.nonModelVisibleHunks ?? [] : [])
      recordErrors.push(...passed.errors)
      return passed.contributions
    }),
  ]
  const errors = [
    ...registryErrors(registry, markers, path => existsSync(join(root, path))),
    ...contributionErrors(contributions, registry),
    ...recordErrors,
  ]
  let overlay: ParsedOverlay | undefined
  try {
    overlay = readOverlay(read(PARITY_OVERLAY_PATH))
    errors.push(...overlayErrors(overlay.switches, registry), ...localBundleErrors(overlay.localBundle, read(LOCAL_BUNDLE_PATCH_PATH)))
  } catch (error) {
    errors.push(`${PARITY_OVERLAY_PATH}: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (overlay !== undefined) {
    try {
      const { shipped, parity } = compositionSettings(read, overlay)
      errors.push(...presenceErrors(registry, shipped, parity))
    } catch (error) {
      errors.push(`parity compositions: ${String(error)}`)
    }
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
