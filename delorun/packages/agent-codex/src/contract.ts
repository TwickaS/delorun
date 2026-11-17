/**
 * The external-agent driver contract, copied from the Stage 1 common brief until `@delorun/external-agents` lands its
 * `src/contract.ts`; every import of this module then moves to that package and this file is deleted.
 * @module @delorun/agent-codex/contract
 */
import type { TokenUsage } from '@deepseek-ai/dsh-llm'
import type { SubprocessHandle, SubprocessStdio } from '@deepseek-ai/dsh-subprocess'

/** A JSON value. */
export type JsonValue = string | number | boolean | null | readonly JsonValue[] | { readonly [key: string]: JsonValue }

/** Upstream's provider names. */
export type ExternalAgentName = 'claude-code' | 'codex'

/** One model the program offers. */
export interface OfferedModel { readonly id: string; readonly displayName: string; readonly isDefault: boolean }

/** Why a turn or an open failed. */
export type ProgramFailure =
  | { readonly category: 'signed-out' }
  | { readonly category: 'limit'; readonly resetsAt?: number }
  | { readonly category: 'model-not-offered'; readonly configured: string; readonly offered: readonly OfferedModel[] }
  | { readonly category: 'resume-failed' }
  | { readonly category: 'program'; readonly detail: string }

/** One thing the program did, in program order. */
export type ProgramEvent =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'reasoning'; readonly text: string }
  | { readonly kind: 'tool-call'; readonly id: string; readonly name: string; readonly input: string }
  | { readonly kind: 'message-end'; readonly usage?: TokenUsage }
  | { readonly kind: 'tool-result'; readonly id: string; readonly output: string; readonly isError: boolean }
  | { readonly kind: 'turn-end'; readonly outcome: 'completed' | 'interrupted' | 'failed'; readonly usage?: TokenUsage; readonly failure?: ProgramFailure }

/** A rule a person allowed "for this run". */
export interface ProgramRunRule { readonly provider: ExternalAgentName; readonly summary: string; readonly data: JsonValue }

/** A question the program raises about one of its tool calls. */
export interface ProgramApprovalRequest {
  readonly callId: string
  readonly toolName: string
  readonly reason: string
  readonly runRule?: ProgramRunRule
  readonly signal: AbortSignal
}

/** The person's answer. */
export type ProgramApprovalAnswer = 'allow-once' | 'allow-run' | 'reject' | 'cancel'

/** A harness tool offered to the program over MCP. */
export interface ProgramHarnessTool {
  readonly name: string
  readonly description: string
  readonly inputSchema: JsonValue
  call(input: JsonValue, signal: AbortSignal): Promise<{ readonly output: string; readonly isError: boolean }>
}

/** What a driver passes to the gate's spawn. */
export interface ProgramSpawnRequest {
  readonly argv: readonly string[]
  readonly env?: NodeJS.ProcessEnv
  readonly stdio: SubprocessStdio
}

/** The gate's spawn. */
export type ProgramSpawn = (request: ProgramSpawnRequest) => SubprocessHandle

/** A limit window. */
export interface LimitWindow { readonly kind: string; readonly usedPercent?: number; readonly resetsAt?: number; readonly status: 'allowed' | 'near' | 'reached' | 'unknown' }

/** What a limits check or a run reports. */
export interface AccountObservation {
  readonly provider: ExternalAgentName
  readonly signedIn: 'yes' | 'no' | 'unknown'
  readonly plan?: string
  readonly windows: readonly LimitWindow[]
  readonly offeredModels?: readonly OfferedModel[]
  readonly source: 'run' | 'probe'
}

/** What a seat asks a driver to open. */
export interface ProgramOpenRequest {
  readonly sessionId: string
  readonly cwd: string
  readonly resume?: string
  readonly model?: string
  readonly runRules: readonly ProgramRunRule[]
  readonly harnessTools: readonly ProgramHarnessTool[]
  readonly spawn: ProgramSpawn
  onApproval(request: ProgramApprovalRequest): Promise<ProgramApprovalAnswer>
  onLimits(observation: AccountObservation): void
  readonly signal: AbortSignal
}

/** One live program session. */
export interface ProgramSession {
  readonly programSessionId: string
  readonly turnRunning: boolean
  send(text: string, mode: 'start' | 'steer'): Promise<void>
  interrupt(): Promise<void>
  next(signal: AbortSignal): Promise<ProgramEvent>
  close(): Promise<void>
}

/** A limits check request. */
export interface ProgramProbeRequest { readonly spawn: ProgramSpawn; readonly cwd: string; readonly signal: AbortSignal }

/** One program's driver. */
export interface ExternalAgentDriver {
  readonly provider: ExternalAgentName
  open(request: ProgramOpenRequest): Promise<ProgramSession>
  probe(request: ProgramProbeRequest): Promise<AccountObservation>
}

/** An open or probe that failed for a reason in the closed {@link ProgramFailure} set. */
export class ProgramFailureError extends Error {
  /** The failure. */
  readonly failure: ProgramFailure

  /**
   * @param failure - the failure.
   * @param options - the cause, kept for the person's diagnostics.
   */
  constructor(failure: ProgramFailure, options?: ErrorOptions) {
    super(`external agent failed: ${failure.category}`, options)
    this.name = 'ProgramFailureError'
    this.failure = failure
  }
}
