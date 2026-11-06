/**
 * One-command setup for a Delo checkout or worktree: the local hooks file, the install, the
 * hooks, the divergence ledger's merge driver and the Node major check. Run from the worktree's
 * root after `git worktree add`: `node delo/apps/tools/src/setup-worktree.ts`, or with tsx once
 * dependencies exist. It changes only git-ignored files and this clone's git configuration.
 *
 * @module @delo/tools/setup-worktree
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

/** The git-ignored file that merges Delo's hooks over upstream's. */
export const LEFTHOOK_LOCAL = 'lefthook-local.yml'

/** The content of {@link LEFTHOOK_LOCAL}. */
export const LEFTHOOK_LOCAL_CONTENT = 'extends:\n  - delo/lefthook.yml\n'

/** The merge driver git uses for `delo/upstream-patches.json` (`.gitattributes` names it `delo-ledger`). */
export const LEDGER_DRIVER = 'node_modules/.bin/tsx delo/apps/tools/src/ledger-merge.ts %O %A %B'

/**
 * The Node major the repository pins in `.nvmrc`.
 * @param root - the repository root.
 * @returns the pinned major, or undefined when `.nvmrc` is absent or not a number.
 */
export function pinnedNodeMajor(root: string): number | undefined {
  const path = join(root, '.nvmrc')
  if (!existsSync(path)) return undefined
  const major = Number.parseInt(readFileSync(path, 'utf8').trim().replace(/^v/, ''), 10)
  return Number.isNaN(major) ? undefined : major
}

/**
 * A warning when the running Node major differs from the pinned one.
 * @param version - the running version, such as `process.version`.
 * @param pinned - the pinned major.
 * @returns the warning, or undefined when they match or nothing is pinned.
 */
export function nodeWarning(version: string, pinned: number | undefined): string | undefined {
  if (pinned === undefined) return undefined
  const running = Number.parseInt(version.replace(/^v/, ''), 10)
  if (running === pinned) return undefined
  return `setup-worktree: Node ${version} is running and the repository pins Node ${String(pinned)} (.nvmrc); run \`nvm use\` before checks, or results differ from the reference host`
}

/**
 * Run one setup step and stop the setup when it fails.
 * @param root - the directory to run in.
 * @param command - the program.
 * @param args - its arguments.
 */
function step(root: string, command: string, args: readonly string[]): void {
  console.log(`setup-worktree: ${command} ${args.join(' ')}`)
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit' })
  if (result.status !== 0) throw new Error(`setup-worktree: \`${command} ${args.join(' ')}\` exited with ${String(result.status)}`)
}

/**
 * Set up the worktree at `root`.
 * @param root - the worktree's root.
 */
export function setupWorktree(root: string): void {
  const warning = nodeWarning(process.version, pinnedNodeMajor(root))
  if (warning !== undefined) console.warn(warning)
  const hooksFile = join(root, LEFTHOOK_LOCAL)
  if (!existsSync(hooksFile)) writeFileSync(hooksFile, LEFTHOOK_LOCAL_CONTENT)
  step(root, 'pnpm', ['install', '--frozen-lockfile'])
  step(root, 'node', ['scripts/install-lefthook.mjs'])
  step(root, 'git', ['config', 'merge.delo-ledger.driver', LEDGER_DRIVER])
  console.log('setup-worktree: done; `pnpm check` runs the checks a change reaches')
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    setupWorktree(process.cwd())
  } catch (error) {
    // The step names the failed command; print it and fail the setup.
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
