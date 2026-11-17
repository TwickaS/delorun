/**
 * Maps the level the person set for Claude Code (EA34) to the SDK parameters of one seat: the permission mode, the
 * command sandbox and the web tools the sandbox does not cover. The sandbox confines Bash commands only; the program's
 * own edit and web tools are not inside it.
 * @module @delorun/agent-claude-code/levels
 */
import type { Options } from '@anthropic-ai/claude-agent-sdk'
import { CLAUDE_SANDBOX_INSTALL_COMMAND, missingClaudeSandboxTools } from '@deepseek-ai/dsh-subagent'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import type { AgentLevel } from '@delorun/external-agents/contract'

/** The levels a seat can run Claude Code at, as the consent names them. */
export const CLAUDE_LEVELS = ['careful', 'standard', 'own', 'unrestricted'] as const satisfies readonly AgentLevel[]

/** The SDK parameters a level selects for one seat. */
export interface ClaudeSeatLevel {
  /** The SDK permission mode; absent leaves the person's own settings to decide. */
  readonly permissionMode?: NonNullable<Options['permissionMode']>
  /** The command sandbox: confining, or explicitly off. Absent leaves the person's own settings to decide. */
  readonly sandbox?: NonNullable<Options['sandbox']>
  /** Tools the level removes because the command sandbox does not cover them. */
  readonly disallowedTools: readonly string[]
  /** Whether the level wants a command sandbox that this computer cannot run, so the seat runs without one. */
  readonly sandboxUnavailable: boolean
}

/** The failure of Careful when the command sandbox cannot run; the message is the sentence the person reads. */
export class SandboxUnavailableError extends Error {
  /** The tools the sandbox lacks. */
  readonly missing: readonly string[]

  /** @param missing - the tools the sandbox lacks. */
  constructor(missing: readonly string[]) {
    super(`Careful needs Claude Code's command sandbox, which needs ${missing.join(' and ')}. Install it with: ${CLAUDE_SANDBOX_INSTALL_COMMAND}`)
    this.name = 'SandboxUnavailableError'
    this.missing = missing
  }
}

/** Where the lookup of the sandbox's tools happens; replaced in specs. */
export interface LevelMachine {
  /** `process.platform`. */
  readonly platform: NodeJS.Platform
  /** The `PATH` the program runs with. */
  readonly path: string | undefined
  /** Whether a file exists. */
  readonly exists?: (file: string) => boolean
}

/**
 * Resolve a level for one seat.
 * @param level - the person's level for Claude Code.
 * @param cwd - the run folder.
 * @param machine - where the sandbox's tools are looked for.
 * @returns the SDK parameters.
 * @throws SandboxUnavailableError for Careful when the command sandbox cannot run.
 */
export function claudeSeatLevel(level: AgentLevel, cwd: string, machine: LevelMachine): ClaudeSeatLevel {
  switch (level) {
    case 'own':
      return { disallowedTools: [], sandboxUnavailable: false }
    case 'unrestricted':
      return { permissionMode: 'bypassPermissions', sandbox: { enabled: false }, disallowedTools: [], sandboxUnavailable: false }
    case 'careful': {
      const missing = missingClaudeSandboxTools(machine.platform, machine.path, machine.exists)
      if (missing.length > 0) throw new SandboxUnavailableError(missing)
      return {
        permissionMode: 'default',
        sandbox: {
          enabled: true, failIfUnavailable: true, allowUnsandboxedCommands: false, autoAllowBashIfSandboxed: true,
          filesystem: { allowWrite: [cwd] }, network: { allowedDomains: [] },
        },
        // The sandbox confines commands only; Claude Code's own web tools run in-process.
        disallowedTools: ['WebFetch', 'WebSearch'],
        sandboxUnavailable: false,
      }
    }
    case 'standard': {
      if (missingClaudeSandboxTools(machine.platform, machine.path, machine.exists).length > 0) {
        return { permissionMode: 'default', sandbox: { enabled: false }, disallowedTools: [], sandboxUnavailable: true }
      }
      return {
        permissionMode: 'auto',
        sandbox: {
          enabled: true, failIfUnavailable: true, allowUnsandboxedCommands: false, autoAllowBashIfSandboxed: true,
          filesystem: { allowWrite: [cwd, '/tmp'] }, network: { allowedDomains: ['*'] },
        },
        disallowedTools: [],
        sandboxUnavailable: false,
      }
    }
    default:
      return assertNever(level, 'Claude Code level')
  }
}
