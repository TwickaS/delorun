/**
 * Service Definition for the same-world process-confinement capability seam: wrap exact subprocess argv under a
 * host-path file policy. Containers, microVMs, and remote execution replace the
 * surrounding capability seam instead; this service shares the host kernel and filesystem.
 * @module @deepseek-ai/dsh-sandbox
 */

import { Context, Service } from '@deepseek-ai/cordis'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'

export {
  ESCALATION_TARGETS,
  SANDBOX_ESCALATION_ERROR_CODES,
  SandboxEscalationError,
  WIDER_MODES,
  approveEscalation,
  denialMarkers,
  environmentDenialMarker,
  escalationHintMarker,
  sandboxDenialMarker,
  sandboxPermissionsDescription,
  validateEscalationArgs,
} from './escalation.ts'
export type {
  EscalationApproval,
  EscalationApprover,
  EscalationOutcome,
  EscalationRequest,
  SandboxEscalationErrorCode,
} from './escalation.ts'
export {
  assertRootsOutsideHome,
  canonicalPath,
  pathWithin,
  protectedReadGuard,
  toolReadableOnly,
  workspaceWritableRoots,
  writableRoots,
  SandboxInvalidRootError,
  SandboxProtectedRootError,
} from './roots.ts'

/**
 * File-effect policy for confined processes. `read-only` permits only required
 * sinks such as `/dev/null`; `workspace-write` also permits the workspace,
 * explicit extra roots where supported, and backend-defined temp areas; `danger-full-access` bypasses confinement. Network
 * and process visibility are outside this vocabulary.
 */
export type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access'

/** A confining (non-`danger-full-access`) mode — the modes a {@link SandboxPolicy} can carry. */
export type ConfinedSandboxMode = Exclude<SandboxMode, 'danger-full-access'>

/**
 * The network a confined execution may reach, when a policy restricts it. A policy without one leaves the network as
 * the runner shares it with the host.
 * - `off`: no network. The command sees a loopback interface of its own and nothing beyond it.
 * - `proxy`: no network except one HTTP proxy, which listens on the Unix socket {@link SandboxProxyNetwork.socket}
 *   outside the sandbox. The runner serves that socket to the command on a loopback port and names the port in the
 *   command's proxy environment variables; a program that ignores them reaches nothing.
 *
 * A runner that cannot express the requested network refuses the wrap with `SANDBOX_UNSUPPORTED_POLICY` rather than
 * running the command with the host's network.
 */
export type SandboxNetwork = { readonly mode: 'off' } | SandboxProxyNetwork

/** The `proxy` form of {@link SandboxNetwork}. */
export interface SandboxProxyNetwork {
  /** Reach only the HTTP proxy on {@link socket}. */
  readonly mode: 'proxy'
  /**
   * Absolute path of the proxy's Unix socket, which must exist when the command is wrapped. The runner makes this one
   * socket reachable at the same path inside the sandbox, so it should lie where the runner hides every other path,
   * such as under a protected home; a socket a confined command can otherwise see stays reachable to commands whose
   * network is `off`.
   */
  readonly socket: string
}

/**
 * The complete file-effect policy resolved for one capability call. The root
 * is carried even under modes that do not consume it so callers can resolve
 * policy once before choosing the enforcement path.
 */
export interface SandboxExecutionPolicy {
  /** The file-effect mode this execution runs under. */
  mode: SandboxMode
  /** Absolute root directory `workspace-write` may write under. */
  workspaceRoot: string
  /**
   * Extra physical absolute directories `workspace-write` may also write under.
   * Absence means none. The enforcing host rejects missing, non-directory, and
   * symlinked entries on each call. Remote paths are checked on the remote host.
   * Windows process confinement ignores these; harness filesystem operations honor them.
   * These grant nothing under `read-only` or `danger-full-access`.
   */
  additionalWritableRoots?: readonly string[]
  /**
   * The network this execution may reach. Absent means the host's network, as the runner shares it. Ignored under
   * `danger-full-access`, which bypasses confinement.
   */
  network?: SandboxNetwork
  /**
   * Opaque identity of the calling session (the branded `dsh-session`
   * SessionId). Backends key per-session state off it (e.g. windows-acl gives
   * each live session/workspace pair a random private temp directory and SID,
   * while the workspace SID and standing grant remain per-workspace); absent
   * for agentless calls, which fall back to per-call backend state.
   */
  sessionId?: SessionId
}

/**
 * Enforcement completeness for this host. `partial` means an active backend or
 * older kernel ABI cannot govern every promised file effect; callers requiring
 * an absolute boundary must not treat it as `full`.
 */
export type SandboxEnforcement = 'full' | 'partial'

/**
 * What one confined execution is allowed to touch — carried PER CALL, not
 * fixed on the provider: two consumers may confine under different policies
 * at the same instant (bash under `read-only` while a confined child agent
 * needs its state directory writable), and an approved escalated retry is a
 * new call with a wider policy. Defaulting/resolution is an explicit step at
 * the consumer boundary; the provider treats the policy as fully specified.
 */
export interface SandboxPolicy extends SandboxExecutionPolicy {
  /** The file-effect mode this execution runs under. */
  mode: ConfinedSandboxMode
}

/**
 * Evidence that identifies a sandbox runner failing before it executes the
 * wrapped command. A consumer first applies {@link allowedExitCodes} when
 * present, removes {@link informationalLines} by case-insensitive exact line
 * equality, then matches {@link fatalSignatures} case-insensitively within
 * each remaining stderr line. Exit status alone never proves runner failure.
 */
export interface RunnerFailureRule {
  /** Nonzero process exit codes on which this rule may match; omitted permits any nonzero exit. */
  allowedExitCodes?: readonly number[]
  /** Non-empty substrings identifying a fatal runner diagnostic on one stderr line. */
  fatalSignatures: readonly string[]
  /** Benign stderr lines excluded by exact full-line equality before fatal matching. */
  informationalLines?: readonly string[]
}

/**
 * A {@link SandboxProvider.confine} result: the argv to spawn in place of
 * the caller's own, plus the enforcement completeness the selected backend
 * achieves for it.
 */
export interface ConfinedArgv {
  /** The wrapped argv (runner, profile, separator, then the caller's argv). */
  argv: string[]
  /** How completely the selected backend enforces the policy's file effects. */
  enforcement: SandboxEnforcement
  /**
   * The selected backend's denial DIALECT: the case-insensitive stderr
   * substrings a file effect denied by THIS backend produces (EROFS text
   * under bwrap's read-only binds, EACCES under Landlock, EPERM under
   * Seatbelt). A consumer that infers denials from a failed run's stderr
   * matches against exactly these rather than a cross-backend union — the
   * union claims denials a given backend never produces.
   */
  denialSignatures: readonly string[]
  /**
   * The case-insensitive stderr substrings of a file effect the environment
   * around the backend refuses, such as `Read-only file system` under a
   * container's read-only root. No wider sandbox mode lifts such a denial, so
   * consumers report it apart from {@link denialSignatures}' policy denials.
   * Absent when the environment adds none.
   */
  environmentDenialSignatures?: readonly string[]
  /**
   * Structured runner-failure evidence rules. Consumers require a matching
   * fatal stderr line (after informational exclusions) and any rule-specific
   * exit-code gate before checking denial signatures: runner failure means the
   * command never ran, while denial means confinement worked and blocked it.
   */
  runnerFailureRules: readonly RunnerFailureRule[]
}

/**
 * Error code for a requested confined mode when no backend is usable. The
 * provider fails closed, and `HarnessError` carries the code through
 * `tool/result` so callers can distinguish missing confinement from command
 * failure.
 */
export const SANDBOX_UNAVAILABLE = 'SANDBOX_UNAVAILABLE'

/**
 * Thrown when {@link SandboxProvider.confine} cannot enforce the requested
 * mode. Carries {@link SANDBOX_UNAVAILABLE} through the structured error
 * channel.
 */
export class SandboxUnavailableError extends HarnessError {
  constructor(mode: ConfinedSandboxMode, detail?: string) {
    super(
      `sandbox mode "${mode}" is requested but no sandbox backend is usable on this host; `
      + 'refusing to run the command unconfined. Install bubblewrap or run a Landlock-enforcing '
      + 'kernel (Linux), ensure sandbox-exec is usable (macOS), or ensure the ACL '
      + 'restricted-token runner can start (Windows) — otherwise switch the consumer to '
      + 'danger-full-access.'
      + (detail === undefined ? '' : ` Runner failure: ${detail}`),
      SANDBOX_UNAVAILABLE,
    )
    this.name = 'SandboxUnavailableError'
  }
}

/** The selected backend is available but cannot enforce the requested policy. */
export class SandboxUnsupportedPolicyError extends HarnessError {
  constructor(detail: string) {
    super(detail, 'SANDBOX_UNSUPPORTED_POLICY')
    this.name = 'SandboxUnsupportedPolicyError'
  }
}

/**
 * Every {@link SandboxPreparationError} code:
 * - `SANDBOX_PREPARATION_FAILED` — the provider could not set up host state the confined process needs, such as a
 *   Windows ACL grant or a private temp directory; `cause` holds the platform failure.
 * - `SANDBOX_INVALID_TEMP_ROOT` — the host temp root lies inside the workspace, so a private temp directory would
 *   inherit the workspace grant; move the temp root or the workspace.
 */
export const SANDBOX_PREPARATION_ERROR_CODES = ['SANDBOX_PREPARATION_FAILED', 'SANDBOX_INVALID_TEMP_ROOT'] as const

/** One code from {@link SANDBOX_PREPARATION_ERROR_CODES}. */
export type SandboxPreparationErrorCode = typeof SANDBOX_PREPARATION_ERROR_CODES[number]

/**
 * Thrown by {@link SandboxProvider.confine} when host preparation for an
 * enforceable mode fails. The provider rolls back what it prepared before
 * throwing, and the command never runs.
 */
export class SandboxPreparationError extends HarnessError {
  override readonly code: SandboxPreparationErrorCode

  /**
   * @param message - names the preparation step and the safe next step.
   * @param code - the failure class consumers route on.
   * @param options - the platform failure, or an `AggregateError` with the cleanup failures, as `cause`.
   */
  constructor(message: string, code: SandboxPreparationErrorCode, options?: ErrorOptions) {
    super(message, code, options)
    this.name = 'SandboxPreparationError'
    this.code = code
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    sandbox: SandboxProvider
  }
}

/**
 * Abstract process-sandbox service. {@link confine} must return enforcing argv
 * or fail closed at wrap or runner-execution time; silent unconfined passthrough
 * is forbidden. Functional probes arbitrate multi-runner chains and may be
 * skipped for a sole candidate, whose own refusal remains the fail-closed end.
 */
export abstract class SandboxProvider extends Service {
  /* v8 ignore next -- abstract service construction is covered through concrete provider packages. */
  constructor(ctx: Context) {
    super(ctx, 'sandbox')
  }

  /**
   * Wrap `argv` so it executes confined under `policy` on this host; the
   * caller spawns the returned argv in place of its own.
   * @param argv - the exact argv the caller is about to spawn (program plus
   *   arguments), NOT a shell string — a shell-shaped consumer passes
   *   `['bash', '-c', command]`.
   * @param policy - the file-effect policy this execution runs under,
   *   carried per call (see {@link SandboxPolicy}).
   * @param signal - cancellation while the provider resolves the policy and runner.
   * @returns the argv to spawn instead, plus the enforcement completeness
   *   the selected backend achieves for it.
   */
  abstract confine(argv: readonly string[], policy: SandboxPolicy, signal?: AbortSignal): Promise<ConfinedArgv>

  /**
   * The canonical directory that confined executions may neither write nor read, as far as the backend expresses
   * each rule, or `undefined` when the provider protects none. In-process enforcers, such as the filesystem fence,
   * refuse mutations under it, so a tool cannot write where a confined command cannot.
   * @returns the protected directory, or `undefined`.
   */
  get protectedHome(): string | undefined {
    return undefined
  }

  /**
   * The paths in-process read tools must not read, as far as the provider keeps confined executions from reading
   * them: the protected home and every other path that reaches it, with the readable entries under each. Read on
   * every access, so a tool reads it once per call.
   * @returns the protected reads, or `undefined` when the provider protects none.
   */
  get protectedReads(): ProtectedReads | undefined {
    return undefined
  }
}

/** Canonical paths in-process read tools must not read ({@link SandboxProvider.protectedReads}). */
export interface ProtectedReads {
  /** The protected home and the other paths that reach it. */
  readonly roots: readonly string[]
  /** The readable entries under each root, which confined executions and in-process read tools may read. */
  readonly readable: readonly string[]
  /**
   * The entries under each root inside which an in-process read tool may be granted reads that confined executions
   * never get, such as the directory holding spilled tool output. A tool reads only within its own grants there, such
   * as the calling session's own spill directory (`protectedReadGuard`'s `grants`). A provider never grants them to a
   * confined execution. Absent means none.
   */
  readonly toolReadable?: readonly string[]
}

export default SandboxProvider

export { classifyRunnerFailure, denialOf, isRunnerSpawnFailure, matchesSignature } from './diagnostics.ts'
