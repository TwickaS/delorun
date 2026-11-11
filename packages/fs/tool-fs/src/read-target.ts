/**
 * Shared path resolution and regular-file validation for model-facing read tools.
 * @module @deepseek-ai/dsh-tool-fs/src/read-target
 */

import type { Context } from '@deepseek-ai/cordis'
import { FsError } from '@deepseek-ai/dsh-fs'
import { protectedReadGuard } from '@deepseek-ai/dsh-sandbox'
import { spillReadGrants } from '@deepseek-ai/dsh-spill'
import type { SandboxMode } from '@deepseek-ai/dsh-sandbox'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import type { FsInfo, FsTarget } from '@deepseek-ai/dsh-fs'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import { sessionResolveOptions } from './session-cwd.ts'

/**
 * The sandbox provider's protected-read check for one tool call, read once: true for a target under the protected home
 * or another path that reaches it, outside its readable entries and outside the spill directories of the calling
 * session and its header's parent session within its tool-readable entries, unless the call runs under
 * `danger-full-access`. A provider that protects nothing makes it always false.
 * @param ctx - the plugin context.
 * @param exec - the tool execution, whose session decides the sandbox mode when `mode` is omitted.
 * @param mode - the call's resolved mode, when the tool already resolved its policy.
 * @returns a predicate that is true for a target the tool must not read or list.
 */
export function protectedReadCheck(ctx: Context, exec: ToolExecution, mode?: SandboxMode): (target: FsTarget) => boolean {
  const reads = ctx.get('sandbox')?.protectedReads
  if (reads === undefined) return () => false
  const callMode = mode ?? ctx.get('sandboxPolicy')?.resolve(exec.agent === undefined ? {} : { session: exec.agent.session }).mode ?? 'read-only'
  const refused = protectedReadGuard(reads, callMode, spillReadGrants(ctx, exec.agent?.session.header))
  return target => refused(target.targetKey)
}

/**
 * Refuse a model-facing tool's access to a target under the sandbox provider's protected home, outside its readable
 * entries, unless the call runs under `danger-full-access` ({@link protectedReadCheck}).
 * @param ctx - the plugin context.
 * @param exec - the tool execution, whose session decides the sandbox mode when `mode` is omitted.
 * @param target - the resolved target.
 * @param mode - the call's resolved mode, when the tool already resolved its policy.
 * @throws {FsError} `FS_SANDBOX_DENIED` for a protected target.
 */
export function refuseProtectedRead(ctx: Context, exec: ToolExecution, target: FsTarget, mode?: SandboxMode): void {
  if (protectedReadCheck(ctx, exec, mode)(target)) {
    throw new FsError(`cannot read "${target.displayPath}": file access denied under the protected home`, 'FS_SANDBOX_DENIED')
  }
}

/**
 * Resolve a model-supplied path, refuse one under the sandbox provider's protected home, observe absence, and
 * require a regular file.
 * @param ctx - the plugin context providing filesystem resolution and observation events.
 * @param exec - the current tool execution, including the owning Agent and cancellation.
 * @param requestedPath - the raw path supplied to the tool.
 * @returns the resolved target and its single stat result.
 * @throws {FsError} `FS_SANDBOX_DENIED` for a protected path, `FS_NOT_FOUND` or `FS_NOT_REGULAR_FILE`.
 */
export async function resolveRegularReadTarget(
  ctx: Context,
  exec: ToolExecution,
  requestedPath: string,
): Promise<{ target: FsTarget; info: FsInfo }> {
  const target = await ctx.fs.resolve(requestedPath, await sessionResolveOptions(ctx, exec))
  refuseProtectedRead(ctx, exec, target)
  const info = await ctx.fs.stat(target, exec.signal)
  if (info === undefined) {
    ctx.emit('fs/observed', target, { kind: 'absent' }, exec)
    throw new FsError(`cannot read "${target.displayPath}": not found`, 'FS_NOT_FOUND')
  }
  if (info.type !== 'file') {
    throw new FsError(`cannot read "${target.displayPath}": not a regular file`, 'FS_NOT_REGULAR_FILE')
  }
  return { target, info }
}
