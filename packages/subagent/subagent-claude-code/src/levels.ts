/**
 * Maps a safety level to the Claude Agent SDK parameters of one one-shot run: the permission mode, the command
 * sandbox and the web tools the sandbox does not cover.
 *
 * @module @deepseek-ai/dsh-subagent-claude-code/levels
 */

import type { Options } from '@anthropic-ai/claude-agent-sdk'
import type { SubagentSafetyLevel } from '@deepseek-ai/dsh-subagent'
import { CLAUDE_SANDBOX_INSTALL_COMMAND, missingClaudeSandboxTools } from '@deepseek-ai/dsh-subagent/safety-level'
import type { ClaudeCodePermissionMode } from './run.ts'

/** The SDK parameters a safety level selects for one run. */
export interface ClaudeLevelRun {
  /** The SDK permission mode; `default` leaves the person's own settings to decide, so none is sent. */
  readonly permissionMode: ClaudeCodePermissionMode | 'default'
  /** The command sandbox, when the level sets one. */
  readonly sandbox?: NonNullable<Options['sandbox']>
  /** Tools added to the disallowed list because the command sandbox does not cover them. */
  readonly disallowedTools: readonly string[]
  /** Whether the level asked for a command sandbox that this machine cannot run, so the run has none. */
  readonly sandboxUnavailable?: true
}

/** The error a Careful run raises when the command sandbox cannot run; its message is the install line. */
export class ClaudeSandboxUnavailable extends Error {
  constructor(readonly missing: readonly string[]) {
    super(`Careful needs Claude Code's command sandbox, which needs ${missing.join(' and ')}. Install it with: ${CLAUDE_SANDBOX_INSTALL_COMMAND}`)
    this.name = 'ClaudeSandboxUnavailable'
  }
}

/**
 * Resolve a safety level for one run.
 * @param level - the level the deployment set for Claude Code.
 * @param cwd - the task folder.
 * @param platform - `process.platform`.
 * @param path - the `PATH` the program runs with.
 * @param exists - whether a file exists; replaced in tests.
 * @returns the SDK parameters.
 * @throws ClaudeSandboxUnavailable for Careful when the command sandbox cannot run.
 */
export function claudeLevelRun(
  level: SubagentSafetyLevel,
  cwd: string,
  platform: NodeJS.Platform,
  path: string | undefined,
  exists?: (file: string) => boolean,
): ClaudeLevelRun {
  if (level === 'own') return { permissionMode: 'default', disallowedTools: [] }
  if (level === 'unrestricted') return { permissionMode: 'bypassPermissions', sandbox: { enabled: false }, disallowedTools: [] }
  const missing = missingClaudeSandboxTools(platform, path, exists)
  if (level === 'careful') {
    if (missing.length > 0) throw new ClaudeSandboxUnavailable(missing)
    return {
      permissionMode: 'acceptEdits',
      sandbox: {
        enabled: true, failIfUnavailable: true, allowUnsandboxedCommands: false, autoAllowBashIfSandboxed: true,
        filesystem: { allowWrite: [cwd] }, network: { allowedDomains: [] },
      },
      // The sandbox confines commands only; Claude Code's own web tools run in-process.
      disallowedTools: ['WebFetch', 'WebSearch'],
    }
  }
  if (missing.length > 0) return { permissionMode: 'acceptEdits', disallowedTools: [], sandboxUnavailable: true }
  return {
    permissionMode: 'auto',
    sandbox: {
      enabled: true, failIfUnavailable: true, allowUnsandboxedCommands: false, autoAllowBashIfSandboxed: true,
      filesystem: { allowWrite: [cwd, '/tmp'] }, network: { allowedDomains: ['*'] },
    },
    disallowedTools: [],
  }
}
