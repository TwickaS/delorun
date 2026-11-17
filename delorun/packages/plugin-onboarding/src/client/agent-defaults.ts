/**
 * What Delorun sets on an agent's row when it adds the agent: Claude Code starts with `acceptEdits`, so a chat's task
 * can change files in its workspace; commands stay refused because no one answers an approval.
 * @module @delorun/plugin-onboarding/client/agent-defaults
 */
import type { ConfigForm } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { AgentRowSettings } from './types.ts'

/** The Claude Code package, whose row gets the default. */
export const CLAUDE_CODE_PACKAGE = '@deepseek-ai/dsh-subagent-claude-code'

/** The permission mode Delorun gives an added Claude Code. */
export const ADDED_CLAUDE_CODE_PERMISSION_MODE = 'acceptEdits'

/**
 * Write `acceptEdits` to a freshly added Claude Code's row once its settings are writable.
 * @param name - the package that was added; any other package is left alone.
 * @param form - the Claude Code row's settings form.
 * @param waitMs - the most time to wait for the row to become writable.
 * @returns when the write was made or given up; it never rejects. A row that does not become writable is logged.
 */
export async function setAddedAgentDefaults(name: string, form: ConfigForm<AgentRowSettings>, waitMs: number): Promise<void> {
  if (name !== CLAUDE_CODE_PACKAGE) return
  const ready = (): boolean => { const row = form.getSnapshot(); return row.status === 'ready' && row.value !== undefined && row.writable }
  const writable = await new Promise<boolean>((resolve) => {
    if (ready()) { resolve(true); return }
    const stop = form.subscribe(() => { if (ready()) { clearTimeout(timer); stop(); resolve(true) } })
    const timer = setTimeout(() => { stop(); resolve(false) }, waitMs)
  })
  if (!writable) {
    console.warn('delorun onboarding: the Claude Code row was not writable, so its permission mode was not set')
    return
  }
  try {
    await form.set('permissionMode', ADDED_CLAUDE_CODE_PERMISSION_MODE)
  } catch (error) {
    console.warn('delorun onboarding: the Claude Code permission mode was not saved', error)
  }
}
