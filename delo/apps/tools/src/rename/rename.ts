/**
 * The scripted rename from Delo to Delorun. It rewrites the content of tracked text files with the rules in
 * `rules.ts`, then renames files and directories whose names carry the old name with `git mv`, the `delo/`
 * directory last. Usage: `node delo/apps/tools/src/rename/rename.ts [--dry-run] [--allow-dirty] [--skip-regenerate]` from the
 * repository root.
 *
 * `--dry-run` writes nothing and prints per-rule counts and a unified diff sample. Without it the tree must be
 * clean; `--allow-dirty` lifts that for a second run, which changes nothing. The lockfile and `snapshots/` are not
 * edited directly: the rename then runs {@link POST_STEPS}, which regenerate the lockfile and the generated files (`--skip-regenerate` omits them; `--dry-run` lists them). Only `snapshot.yml` files under `snapshots/` are edited; the report counts the other snapshot files that carry the name. Symlinks keep their targets.
 *
 * @module @delo/tools/rename/rename
 */
import { spawnSync } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { git } from '../git.ts'
import { applyRules, CONTENT_SKIP, GUARDS, planPathRenames, RULES, type PathRename } from './rules.ts'

/** In a step's command, replaced by one English page whose bilingual-pair record the rename touched; the step runs once per page, so one page that cannot be recorded does not stop the others. */
export const PAIRS_PLACEHOLDER = '{changed-pairs}'

/** A command the rename runs after the rewrite, to regenerate what is generated. */
export interface PostStep {
  /** What the step regenerates. */
  readonly description: string
  /** The program and its arguments, run from the repository root. */
  readonly command: readonly string[]
  /** Whether a failure stops the run; a failed optional step is reported and the run goes on. */
  readonly required: boolean
  /** Exit statuses besides 0 that mean success; the ledger writer exits 3 after it re-records a security digest. */
  readonly acceptedStatuses?: readonly number[]
}

/**
 * Regeneration steps, in order: names in package manifests change the lockfile first, then the generated
 * catalogues and records that quote names, paths or content hashes.
 */
export const POST_STEPS: readonly PostStep[] = [
  { description: 'lockfile (workspace package names, importer paths)', command: ['pnpm', 'install', '--lockfile-only', '--offline'], required: true },
  { description: 'tsconfig paths', command: ['pnpm', 'run', 'gen-tsconfig-paths'], required: true },
  { description: 'plugin packages catalogue', command: ['pnpm', 'run', 'gen-plugin-packages'], required: false },
  { description: 'config catalogue', command: ['pnpm', 'run', 'gen-config-catalog'], required: false },
  { description: 'cordis catalogue', command: ['pnpm', 'run', 'gen-cordis-catalog'], required: false },
  { description: 'dependency catalogue', command: ['pnpm', 'run', 'gen-dependency-catalog'], required: false },
  { description: 'persistence catalogue', command: ['pnpm', 'run', 'gen-persistence-catalog'], required: false },
  { description: 'third-party notices', command: ['pnpm', 'run', 'gen-third-party-notices'], required: false },
  { description: 'divergence ledger paths and security digests', command: ['node_modules/.bin/tsx', 'delorun/apps/tools/src/ledger-record.ts'], required: true, acceptedStatuses: [3] },
  { description: 'bilingual-pair consistency records', command: ['node_modules/.bin/tsx', 'scripts/verify-translation-pairing.ts', '--write', PAIRS_PLACEHOLDER], required: false },
]

/** How many changed lines the dry run prints as a diff sample. */
export const DIFF_SAMPLE_LINES = 12

/** The outcome of a rename run. */
export interface RenameReport {
  /** Text files whose content changed (or would change in a dry run). */
  readonly changedFiles: number
  /** Replacements per rule id. */
  readonly replaced: ReadonlyMap<string, number>
  /** Guarded matches per guard id. */
  readonly guarded: ReadonlyMap<string, number>
  /** Tracked files under `snapshots/` that carry the name and were not edited. */
  readonly snapshotFilesWithName: number
  /** Tracked files skipped as binary or not valid UTF-8. */
  readonly skippedBinary: readonly string[]
  /** Path renames performed (or planned in a dry run). */
  readonly renames: readonly PathRename[]
  /** Changed lines, as unified diff hunks, up to {@link DIFF_SAMPLE_LINES}. */
  readonly diffSample: readonly string[]
}

/** Options of {@link runRename}. */
export interface RenameOptions {
  /** Report only; write nothing. */
  readonly dryRun: boolean
  /** Run on a tree that has uncommitted changes. */
  readonly allowDirty: boolean
}

function add(into: Map<string, number>, from: ReadonlyMap<string, number>): void {
  for (const [id, count] of from) into.set(id, (into.get(id) ?? 0) + count)
}

/** Decode a file as UTF-8 text, or undefined when it holds a NUL byte or invalid UTF-8. */
function decode(bytes: Buffer): string | undefined {
  if (bytes.includes(0)) return undefined
  const text = bytes.toString('utf8')
  return Buffer.from(text, 'utf8').equals(bytes) ? text : undefined
}

function diffHunks(path: string, before: string, after: string, budget: number): string[] {
  const left = before.split('\n')
  const right = after.split('\n')
  const hunks: string[] = []
  for (let index = 0; index < left.length && hunks.length < budget; index += 1) {
    if (left[index] === right[index]) continue
    hunks.push(`--- a/${path}\n+++ b/${path}\n@@ -${String(index + 1)} +${String(index + 1)} @@\n-${left[index] ?? ''}\n+${right[index] ?? ''}`)
  }
  return hunks
}

/**
 * Rewrite tracked files and rename paths.
 * @param root - the repository root.
 * @param options - dry-run and dirty-tree switches.
 * @returns what changed, or would change in a dry run.
 */
export function runRename(root: string, options: RenameOptions): RenameReport {
  if (!options.dryRun && !options.allowDirty && git(root, ['status', '--porcelain']).trim() !== '') {
    throw new Error('rename: the working tree has uncommitted changes; commit or stash them (or pass --allow-dirty to repeat a finished run)')
  }
  const files = git(root, ['ls-files', '-z']).split('\0').filter(path => path !== '')
  const renames = planPathRenames(files)
  const occupied = renames.filter(rename => existsSync(join(root, rename.to))).map(rename => rename.to)
  if (occupied.length > 0) {
    throw new Error(`rename: the target path already exists (an ignored leftover directory?): ${occupied.slice(0, 5).join(', ')}; remove it and run again`)
  }
  const replaced = new Map<string, number>()
  const guarded = new Map<string, number>()
  const skippedBinary: string[] = []
  const diffSample: string[] = []
  let changedFiles = 0
  let snapshotFilesWithName = 0
  for (const path of files) {
    const absolute = join(root, path)
    if (lstatSync(absolute).isSymbolicLink()) continue
    const bytes = readFileSync(absolute)
    const text = decode(bytes)
    if (text === undefined) {
      skippedBinary.push(path)
      continue
    }
    if (CONTENT_SKIP.test(path)) {
      if (path.startsWith('snapshots/') && applyRules(text, path).text !== text) snapshotFilesWithName += 1
      continue
    }
    const applied = applyRules(text, path)
    add(guarded, applied.guarded)
    if (applied.text === text) continue
    changedFiles += 1
    add(replaced, applied.replaced)
    diffSample.push(...diffHunks(path, text, applied.text, DIFF_SAMPLE_LINES - diffSample.length))
    if (!options.dryRun) writeFileSync(absolute, applied.text)
  }
  if (!options.dryRun) {
    for (const rename of renames) {
      mkdirSync(dirname(join(root, rename.to)), { recursive: true })
      git(root, ['mv', '--', rename.from, rename.to])
    }
  }
  return { changedFiles, replaced, guarded, snapshotFilesWithName, skippedBinary, renames, diffSample }
}

/**
 * Format a report for the terminal.
 * @param report - the outcome of {@link runRename}.
 * @param dryRun - whether nothing was written.
 * @returns the report text.
 */
export function formatReport(report: RenameReport, dryRun: boolean): string {
  const lines = [dryRun ? 'rename (dry run; nothing written)' : 'rename (applied)']
  for (const rule of RULES) lines.push(`  rule ${rule.id}: ${String(report.replaced.get(rule.id) ?? 0)} replacements`)
  for (const guard of GUARDS) lines.push(`  guard ${guard.id}: ${String(report.guarded.get(guard.id) ?? 0)} kept`)
  lines.push(`  files with content changes: ${String(report.changedFiles)}`)
  lines.push(`  path renames: ${String(report.renames.length)}`)
  lines.push(`  snapshot files carrying the name, not edited: ${String(report.snapshotFilesWithName)}`)
  lines.push(`  binary or non-UTF-8 files skipped: ${String(report.skippedBinary.length)}`)
  if (report.diffSample.length > 0) lines.push('', ...report.diffSample)
  return lines.join('\n')
}

/** English Markdown pages with a consistency record that the working tree changed (content or rename). */
export function changedPairs(root: string): string[] {
  const status = git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=no']).split('\0')
  const pages: string[] = []
  for (let index = 0; index < status.length; index += 1) {
    const entry = status[index] ?? ''
    if (entry.length < 4) continue
    const path = entry.slice(3)
    if (entry[0] === 'R') index += 1
    const base = path.replace(/(?:\.zh)?\.md$|\.i18n\.yaml$/u, '')
    if (base !== path && existsSync(join(root, `${base}.i18n.yaml`)) && existsSync(join(root, `${base}.md`))) pages.push(`${base}.md`)
  }
  return [...new Set(pages)]
}

/**
 * Run (or, in a dry run, list) the regeneration steps with `nice -n 19`.
 * @param root - the repository root.
 * @param dryRun - print the commands only.
 * @param steps - the steps to run.
 * @returns 0, or 1 when a required step failed.
 */
export function runPostSteps(root: string, dryRun: boolean, steps: readonly PostStep[] = POST_STEPS): number {
  for (const step of steps) {
    const line = step.command.join(' ')
    if (dryRun) {
      console.log(`  would run: ${line}  (${step.description})`)
      continue
    }
    const perPage = step.command.includes(PAIRS_PLACEHOLDER)
    const commands = perPage ? changedPairs(root).map(page => step.command.map(word => (word === PAIRS_PLACEHOLDER ? page : word))) : [step.command]
    let failed = 0
    console.log(`  running: ${line}${perPage ? ` (${String(commands.length)} pages)` : ''}`)
    for (const command of commands) {
      const status = spawnSync('nice', ['-n', '19', ...command], { cwd: root, stdio: 'inherit' }).status
      if (status !== 0 && !(status !== null && (step.acceptedStatuses ?? []).includes(status))) failed += 1
    }
    if (failed === 0) continue
    console.error(`rename: ${step.description} failed for ${String(failed)} of ${String(commands.length)} runs`)
    if (step.required) return 1
  }
  return 0
}

/**
 * The command line.
 * @param argv - the arguments after the script path.
 * @param root - the repository root.
 * @returns the exit status.
 */
export function main(argv: readonly string[], root: string): number {
  const dryRun = argv.includes('--dry-run')
  const allowDirty = argv.includes('--allow-dirty')
  const skipRegenerate = argv.includes('--skip-regenerate')
  const unknown = argv.filter(arg => !['--dry-run', '--allow-dirty', '--skip-regenerate'].includes(arg))
  if (unknown.length > 0) {
    console.error(`rename: unknown argument ${unknown.join(' ')}`)
    return 2
  }
  try {
    console.log(formatReport(runRename(root, { dryRun, allowDirty }), dryRun))
    if (skipRegenerate) return 0
    return runPostSteps(root, dryRun)
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    return 1
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exitCode = main(process.argv.slice(2), git(process.cwd(), ['rev-parse', '--show-toplevel']).trim())
}
