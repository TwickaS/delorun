/**
 * Runs a Session's repository git commands inside the sandbox its own commands run in, so a program that repository
 * state names (a file-system monitor, a filter, a hook) has no more authority than the Session's confined commands.
 * @module @deepseek-ai/dsh-workspace-changes/confinement
 */
import type { Context } from '@deepseek-ai/cordis'
import {
  SandboxUnavailableError, protectedReadGuard, writableRoots, type ConfinedSandboxMode, type SandboxExecutionPolicy, type SandboxPolicy,
} from '@deepseek-ai/dsh-sandbox'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import type { Session } from '@deepseek-ai/dsh-session'
import type { GitConfinement } from './git.ts'

/**
 * The policy one git command runs confined under. A command that writes nothing beside the repository gets the
 * Session's own policy. One that writes the private directory gets it as an extra writable root: under
 * `workspace-write` beside the Session's writable roots, and under `read-only` as the only writable root, so it can
 * still write nothing in the repository. Every policy keeps the Session's `network`.
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
    ...policy.network === undefined ? {} : { network: policy.network },
    ...policy.sessionId === undefined ? {} : { sessionId: policy.sessionId },
  }
}

/**
 * The {@link GitConfinement} of one Session: its policy resolved per command through `ctx.sandboxPolicy` and wrapped
 * through `ctx.sandbox`. Commands run unconfined only where the Session's commands do: under `danger-full-access`, or
 * in a composition that mounts neither a sandbox nor its policy. A policy in a confined mode with no sandbox service
 * mounted, such as while the sandbox reloads or after it failed to start, and a sandbox mounted without its policy,
 * reject the command with `SandboxUnavailableError`, as the shell does; a sandbox that cannot confine a command
 * rejects it too.
 * @param ctx - context whose `sandbox` and `sandboxPolicy` services are read when each command starts.
 * @param session - the Session whose policy applies.
 * @returns the confinement.
 */
export function sessionConfinement(ctx: Context, session: Session): GitConfinement {
  return async (argv, writes, signal) => {
    const policies = ctx.get('sandboxPolicy')
    if (policies === undefined) {
      // A mounted sandbox without its policy cannot say which mode the Session's commands run in.
      if (ctx.get('sandbox') !== undefined) throw new SandboxUnavailableError('read-only', 'the sandbox is mounted without its sandbox policy')
      return undefined
    }
    const policy = policies.resolve({ session })
    if (policy.mode === 'danger-full-access') return undefined
    const sandbox = ctx.get('sandbox')
    if (sandbox === undefined) throw new SandboxUnavailableError(policy.mode, 'no sandbox service is mounted')
    const confined = gitPolicy({ ...policy, mode: policy.mode }, writes)
    const wrapped = await sandbox.confine(argv, confined, signal)
    return { argv: wrapped.argv, mode: confined.mode, runnerFailureRules: wrapped.runnerFailureRules }
  }
}

/**
 * The canonical roots one Session's confined commands can write at this moment, resolved through
 * `ctx.sandboxPolicy` as {@link sessionConfinement} resolves them: the `workspace-write` allow-list of
 * `writableRoots`, which covers every dialect's grants, or none under `read-only`. Under `danger-full-access`, or in a
 * composition that mounts no sandbox policy, the Session's commands run with the Host's authority and no root is
 * reported, because no directory is out of their reach.
 * @param ctx - context whose `sandboxPolicy` service is read on each call.
 * @param session - the Session whose policy applies.
 * @returns canonical directory paths.
 * @throws `SandboxInvalidRootError` when the policy names an extra writable directory that cannot be granted.
 */
export function confinedWritableRoots(ctx: Context, session: Session): readonly string[] {
  const policy = ctx.get('sandboxPolicy')?.resolve({ session })
  return policy === undefined ? [] : writableRoots(policy)
}

/**
 * The canonical roots that any live Session's confined commands can write at this moment: the union of
 * {@link confinedWritableRoots} over every Session the store holds and every Session given. A directory the
 * unconfined Host writes must lie outside all of them, because a Session's confined commands can reach a path that
 * another Session's commands cannot.
 * @param ctx - context whose `sessions` and `sandboxPolicy` services are read on each call.
 * @param sessions - Sessions to include beside the store's, such as the ones being recorded.
 * @returns canonical directory paths without repeats.
 */
export function everyConfinedWritableRoot(ctx: Context, sessions: Iterable<Session>): string[] {
  const all = new Set<Session>([...ctx.get('sessions')?.list() ?? [], ...sessions])
  return [...new Set([...all].flatMap(session => confinedWritableRoots(ctx, session)))]
}

/**
 * Whether a path is one the Session's confined commands cannot read because the sandbox protects it, such as Delo's
 * home: the guard model-facing read tools apply, read when each path is checked. Under `danger-full-access`, or without
 * a mounted sandbox, nothing is protected.
 * @param ctx - context whose `sandbox` and `sandboxPolicy` services are read on each call.
 * @param session - the Session whose mode applies.
 * @returns the check.
 */
export function protectedReadOf(ctx: Context, session: Session): (path: string) => boolean {
  return (path) => {
    const mode = ctx.get('sandboxPolicy')?.resolve({ session }).mode ?? 'danger-full-access'
    return protectedReadGuard(ctx.get('sandbox')?.protectedReads, mode)(path)
  }
}
