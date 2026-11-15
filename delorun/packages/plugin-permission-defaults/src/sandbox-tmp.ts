/**
 * The `delorun:sandbox-tmp` runtime context: tells the model that a sandboxed shell command's `/tmp` does not outlast it.
 *
 * Under `read-only` and `workspace-write`, the sandbox may give each shell command its own `/tmp` (bwrap mounts a
 * tmpfs there), so a file written to `/tmp` is gone when the command ends and a later command never sees it. The
 * context is recorded in the session log like every other `systemPrompt` context.
 *
 * @module @delorun/plugin-permission-defaults/sandbox-tmp
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import type {} from '@deepseek-ai/dsh-system-prompt'

/** Name of the context in the prompt assembly and the session log. */
export const SANDBOX_TMP_CONTEXT = 'delorun:sandbox-tmp'

/** The sentence shown while the session's mode confines shell commands. */
export const SANDBOX_TMP_TEXT = 'Shell commands may run with a private /tmp that is discarded when each command ends; keep files you need under the workspace.'

/**
 * Register the context just after `sandbox:policy`. It reads the session's current mode on every request, so a mode
 * switch changes the text at the next request, and it is empty under `danger-full-access`, where `/tmp` is the host's.
 * @param ctx - the plugin context; the registration is disposed with it.
 */
export function registerSandboxTmpContext(ctx: Context): void {
  ctx.inject(['systemPrompt', 'sandboxPolicy'], (scope) => {
    scope.systemPrompt.context({
      name: SANDBOX_TMP_CONTEXT,
      order: scope.systemPrompt.getContextOrder('SANDBOX_POLICY') + 1,
      text: (context) => {
        const session = context.agent?.session
        if (session === undefined) return ''
        return scope.sandboxPolicy.resolve({ session }).mode === 'danger-full-access' ? '' : SANDBOX_TMP_TEXT
      },
    })
  })
}
