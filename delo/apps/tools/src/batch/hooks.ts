/**
 * The check that the pre-push hook is installed and nothing in the environment bypasses it. A landing batch runs the merge
 * tier itself and then pushes, so the hook is a second run of the same tier; a batch started with it disabled is refused
 * before anything changes.
 *
 * @module @delo/tools/batch/hooks
 */
import { join, resolve } from 'node:path'
import { gitText } from './candidate.ts'
import { BatchError } from './errors.ts'
import { bypassVariable, type Ports } from './process.ts'
import type { Files } from './state.ts'

/**
 * Refuse a batch whose pre-push hook is missing, replaced, reconfigured or disabled by a variable.
 * @param git - the git port, which runs in the repository root.
 * @param root - the repository root.
 * @param env - the integrator's environment.
 * @param files - the file port that reads the hook files.
 * @throws BatchError with code `hooks-bypassed` naming the variable or file and the fix; code `git` when git cannot name the hooks directory.
 */
export function assertHooksInstalled(git: Ports['git'], root: string, env: NodeJS.ProcessEnv, files: Files): void {
  const refuse = (what: string, fix: string): never => {
    throw new BatchError('hooks-bypassed', `${what}; ${fix}`)
  }
  const variable = bypassVariable(env)
  if (variable !== undefined) refuse(`${variable} is set, which skips or reconfigures the pre-push hook`, `unset ${variable} (for LEFTHOOK, only 1 or true is accepted) and run the batch again`)
  const hooks = resolve(gitText(git, ['rev-parse', '--path-format=absolute', '--git-path', 'dsh-hooks']).trim())
  const configured = git(['config', '--get', 'core.hooksPath'])
  const hooksPath = configured.status === 0 ? configured.stdout.trim() : undefined
  if (hooksPath === undefined || resolve(root, hooksPath) !== hooks) {
    refuse(`core.hooksPath is ${hooksPath ?? 'unset'}, not ${hooks}`, 'run pnpm install to reinstall the git hooks, then run the batch again')
  }
  const prePush = join(hooks, 'pre-push')
  if (!(files.read(prePush) ?? '').includes('lefthook')) refuse(`${prePush} is missing or does not run lefthook`, 'run pnpm install to reinstall the git hooks')
  const local = join(root, 'lefthook-local.yml')
  if (!(files.read(local) ?? '').includes('delo/lefthook.yml')) refuse(`${local} is missing or does not include delo/lefthook.yml`, 'write it with `extends: [delo/lefthook.yml]`, run pnpm install, then run the batch again')
  const binary = join(root, 'node_modules', '.bin', 'lefthook')
  if (!files.exists(binary)) refuse(`${binary} does not exist, so the installed hook would skip silently`, 'run pnpm install')
}
