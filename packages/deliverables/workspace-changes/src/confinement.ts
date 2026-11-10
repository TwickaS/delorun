/**
 * Runs a Session's repository git commands inside the sandbox its own commands run in, so a program that repository
 * state names (a file-system monitor, a filter, a hook) has no more authority than the Session's confined commands.
 * @module @deepseek-ai/dsh-workspace-changes/confinement
 */
import type { Context } from '@deepseek-ai/cordis'
import { SandboxUnavailableError, type ConfinedSandboxMode, type SandboxExecutionPolicy, type SandboxPolicy } from '@deepseek-ai/dsh-sandbox'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import type { Session } from '@deepseek-ai/dsh-session'
import type { GitConfinement } from './git.ts'

/**
 * The policy one git command runs confined under. A command that writes nothing beside the repository gets the
 * Session's own policy. One that writes the private directory gets it as an extra writable root: under
 * `workspace-write` beside the Session's writable roots, and under `read-only` as the only writable root, so it can
 * still write nothing in the repository.
 * @param policy - the Session's resolved policy in a confined mode.
 * @param writes - directories outside the repository the command writes.
 * @returns the policy to confine the command under.
 */
export function gitPolicy(policy: SandboxExecutionPolicy & { mode: ConfinedSandboxMode }, writes: readonly string[]): SandboxPolicy {
  const [first, ...rest] = writes
  if (first === undefined) return { ...policy, mode: policy.mode }
  if (policy.mode === 'workspace-write') {
    return { ...policy, mode: 'workspace-write', additionalWritableRoots: [...policy.additionalWritableRoots ?? [], ...writes] }
  }
  return {
    mode: 'workspace-write',
    workspaceRoot: first,
    ...rest.length === 0 ? {} : { additionalWritableRoots: rest },
    ...policy.sessionId === undefined ? {} : { sessionId: policy.sessionId },
  }
}

/**
 * The {@link GitConfinement} of one Session: its policy resolved per command through `ctx.sandboxPolicy` and wrapped
 * through `ctx.sandbox`. Commands run unconfined only where the Session's commands do: under `danger-full-access`, or
 * in a composition that mounts no sandbox policy. A policy in a confined mode with no sandbox service mounted, such
 * as while the sandbox reloads or after it failed to start, rejects the command with `SandboxUnavailableError`, as
 * the shell does; a sandbox that cannot confine a command rejects it too.
 * @param ctx - context whose `sandbox` and `sandboxPolicy` services are read when each command starts.
 * @param session - the Session whose policy applies.
 * @returns the confinement.
 */
export function sessionConfinement(ctx: Context, session: Session): GitConfinement {
  return async (argv, writes, signal) => {
    const policies = ctx.get('sandboxPolicy')
    if (policies === undefined) return undefined
    const policy = policies.resolve({ session })
    if (policy.mode === 'danger-full-access') return undefined
    const sandbox = ctx.get('sandbox')
    if (sandbox === undefined) throw new SandboxUnavailableError(policy.mode, 'no sandbox service is mounted')
    const confined = gitPolicy({ ...policy, mode: policy.mode }, writes)
    const wrapped = await sandbox.confine(argv, confined, signal)
    return { argv: wrapped.argv, mode: confined.mode, runnerFailureRules: wrapped.runnerFailureRules }
  }
}
