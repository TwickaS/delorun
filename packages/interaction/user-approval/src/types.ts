/**
 * Wire-safe approval identifiers and outcome vocabulary, free of
 * cordis/service imports so browser type chains can
 * consume them without loading this package's Context augmentation.
 * @module @deepseek-ai/dsh-user-approval/types
 */

import type { Branded } from '@deepseek-ai/dsh-brand'
import type { Scoped } from '@deepseek-ai/dsh-scope'
import type { Agent } from '@deepseek-ai/dsh-agent/types'
import type { ToolCallId } from '@deepseek-ai/dsh-llm/brand'

/**
 * Pairs one `approval/asked` audit event with its `approval/decided`.
 * Service-issued (one fresh id per {@link ApprovalService.request} call).
 */
export type ApprovalRequestId = Branded<'ApprovalRequestId'>

/**
 * Brand a string as an {@link ApprovalRequestId}.
 * @param id - the raw id string to brand.
 * @returns the same string carrying the brand.
 */
export function ApprovalRequestId(id: string): ApprovalRequestId {
  return id as ApprovalRequestId
}

/**
 * Closed approval outcomes: a one-shot grant, explicit rejection, withdrawn
 * request, or unavailable answerer. Callers fail closed on `unavailable`.
 */
export type ApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * An approval question was put to the answerer chain — log-only audit
     * (like `hook/*`; NOT a surface event, carries no `surfaceOp`). `id` pairs
     * it with the `approval/decided` that always follows; `toolName` is the
     * tool the question is about, `callId` the exact tool call when the asker
     * had one, `reason` the asker's human-readable explanation (e.g. a hook's
     * permission-decision reason).
     */
    'approval/asked': {
      id: ApprovalRequestId
      toolName: string
      callId?: ToolCallId
      reason?: string
    }
    /**
     * The outcome of a prior `approval/asked` (same `id`) — log-only audit.
     * Exactly one per ask, appended when the outcome is known: a decision, a
     * cancellation, or the fail-closed `'unavailable'`.
     */
    'approval/decided': {
      id: ApprovalRequestId
      outcome: ApprovalOutcome
    }
  }
}

/**
 * What an `allowed-once` answer to an approval request grants, which a Host may reserve for some Peers:
 * - `full-access`: an escalation to `danger-full-access`, or a workspace's full-access consent;
 * - `workspace-management`: a change to which workspaces exist (create, clone, trash, restore), to an instruction-layer
 *   file (an `AGENTS.md`, a skill or a preset), or a command or write that runs where every workspace is reachable;
 * - `external-agent`: the start of an external agent program (a subagent provider without a local child session),
 *   which runs outside the sandbox and the approval prompts;
 * - `real-browser`: the person's own browser, with their sign-ins, for the rest of one chat.
 */
export type ApprovalGrant = 'full-access' | 'workspace-management' | 'external-agent' | 'real-browser'

/** The sandbox modes a call can ask to escalate to; `read-only` is the floor and nothing escalates to it. */
export type ApprovalEscalation = 'workspace-write' | 'danger-full-access'

/** Client-safe payload declared for the approval answerer waterfall. */
export interface ApprovalRequestEvent {
  /** Agent identity projected to the corresponding Client Context in transit. */
  readonly agent: Agent
  /** Tool whose operation requires a decision. */
  readonly toolName: string
  /** Exact tool call being decided, when available. */
  readonly callId?: ToolCallId
  /** Human-readable reason supplied by the asker. */
  readonly reason?: string
  /** Localized presentation only; never persisted in approval audit events. */
  readonly displayReason?: { readonly en: string; readonly [locale: string]: string }
  /**
   * What an `allowed-once` answer grants beyond an ordinary tool call, when it does ({@link ApprovalGrant}). A Host may
   * refuse a granting answer from a Peer that may not give that grant; a refusal still applies. Never persisted.
   */
  readonly grants?: ApprovalGrant
  /**
   * The sandbox mode a shell-command or file-operation sandbox escalation asks for, so a presenter can offer to switch
   * the session to it; other requests leave it unset. Presentation only: never persisted, and no Host refuses an answer
   * by it.
   */
  readonly escalatesTo?: ApprovalEscalation
  /** Cancellation lifetime of the pending request. */
  readonly signal?: AbortSignal
}

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * Ask composed answerers for one decision. Return an outcome to claim the
     * request or call `next()` to delegate. Scope-filtered dispatch
     * (`@deepseek-ai/dsh-scope`): agent-scoped listeners receive only that agent.
     * @param req - pending approval request.
     * @mode waterfall
     */
    'approval/request'(
      this: Scoped<Agent>,
      req: ApprovalRequestEvent,
      next: () => Promise<ApprovalOutcome>,
    ): Promise<ApprovalOutcome>
  }
}
