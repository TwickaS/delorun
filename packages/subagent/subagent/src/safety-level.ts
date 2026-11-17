/**
 * The safety level a deployment may set for one external agent, and the host tools the Claude Code level
 * that confines commands needs. A deployment supplies the level through
 * {@link DelegationConsentService.permissionLevel}; each external provider maps it to its program's own sandbox and
 * approval parameters at every start.
 *
 * @module @deepseek-ai/dsh-subagent/safety-level
 */

import { existsSync } from 'node:fs'
import { delimiter, join } from 'node:path'

/**
 * What an external agent may do on its own, from the most to the least confined:
 * - `careful`: writes only in the task folder; commands get no internet.
 * - `standard`: writes in the task folder and temporary folders, internet on; the agent's own reviewer decides the rest.
 * - `own`: the harness sets nothing; the person's own settings for the program decide.
 * - `unrestricted`: no sandbox, never asks.
 */
export type SubagentSafetyLevel = 'careful' | 'standard' | 'own' | 'unrestricted'

/** The levels from the most to the least confined; a later entry is looser than an earlier one. */
export const SUBAGENT_SAFETY_LEVELS = ['careful', 'standard', 'own', 'unrestricted'] as const satisfies readonly SubagentSafetyLevel[]

/** The command that installs the Linux tools Claude Code's command sandbox needs. */
export const CLAUDE_SANDBOX_INSTALL_COMMAND = 'sudo apt install bubblewrap socat'

/**
 * Which tools Claude Code's command sandbox lacks on this machine.
 * macOS confines commands with built-in tools; Linux and WSL need `bwrap` and `socat` on `PATH`; other platforms
 * have no command sandbox here, so every tool counts as missing.
 * @param platform - `process.platform`.
 * @param path - the `PATH` value the program would run with.
 * @param exists - whether a file exists; replaced in tests.
 * @returns the missing tools; empty when the sandbox can run.
 */
export function missingClaudeSandboxTools(
  platform: NodeJS.Platform,
  path: string | undefined,
  exists: (file: string) => boolean = existsSync,
): readonly string[] {
  if (platform === 'darwin') return []
  if (platform !== 'linux') return ['sandbox']
  const dirs = (path ?? '').split(delimiter).filter(dir => dir.length > 0)
  return ['bwrap', 'socat'].filter(tool => !dirs.some(dir => exists(join(dir, tool))))
}
