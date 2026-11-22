/** Approval composer and optional correlated-detail contracts. */
import type { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {
  PropsLocale, PropsRenderFactories, PropsRuntime,
} from '@deepseek-ai/dsh-client-ui-slots'
import type { ApprovalKey } from '../locales.ts'

/* jscpd:ignore-start -- Approval and Question intentionally own independent pending-settlement lifecycles. */
function settlePendingComposer(settle: () => void, failureMessage: string): Promise<void> {
  try {
    settle()
    return Promise.resolve()
  } catch (error) {
    return Promise.reject(error instanceof Error
      ? error
      : new Error(failureMessage, { cause: error }))
  }
}
/* jscpd:ignore-end */

declare module '@deepseek-ai/dsh-client-ui-session/client' {
  interface SessionPendingInteractionMap {
    /** Pending approval request. */
    approval: PendingApproval
  }
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Approval prompt copy. */
    approval: ApprovalKey
  }

  interface SlotFactoryMap {
    /** Shared decision card; the caller owns authorization and persistence. */
    'conversation.approval.card': {
      scope: 'session'
      props: ApprovalCardInput
      locale: 'approval'
      children: {
        'conversation.approval.detail': { kind: 'single'; scope: 'session' }
        'conversation.approval.action': { kind: 'list'; scope: 'session' }
        'conversation.approval.choice': { kind: 'list'; scope: 'session' }
      }
    }
  }

  interface SlotMap {
    /** Optional detail for the Tool call correlated with an approval request. */
    'conversation.approval.detail': {
      kind: 'single'
      scope: 'session'
      owner: ApprovalDetailOwnerProps
    }
    /** Inline actions on a card whose request carries `grants`; rendered between the request body and its decision buttons. */
    'conversation.approval.action': {
      kind: 'list'
      scope: 'session'
      owner: ApprovalActionOwnerProps
    }
    /**
     * Persistent choices on a card whose request carries `escalatesTo`; rendered in the decision row after Allow once,
     * which draws as a secondary button while an entry reports a shown button through `offer`. An entry that offers
     * nothing for the request renders nothing.
     */
    'conversation.approval.choice': {
      kind: 'list'
      scope: 'session'
      owner: ApprovalChoiceOwnerProps
    }
  }
}

/**
 * What an `allowed-once` answer grants beyond an ordinary tool call; the values of `ApprovalGrant` in
 * `@deepseek-ai/dsh-user-approval`, which the `approval/request` consumer passes through unchanged.
 */
export type ApprovalGrant = 'full-access' | 'workspace-management' | 'external-agent' | 'real-browser'

/** The sandbox mode a sandbox escalation asks for; the values of `ApprovalEscalation` in `@deepseek-ai/dsh-user-approval`. */
export type ApprovalEscalation = 'workspace-write' | 'danger-full-access'

/** Stable identity handed to an optional approval-detail renderer. */
export interface ApprovalDetailOwnerProps {
  /** Tool call correlated with the request. */
  callId: ToolCallId
}

/**
 * A step an allow answer takes before it is sent, such as a confirmation the host requires for this request.
 * @returns true to send the answer; false when the person cancelled, which sends nothing and leaves the card answerable.
 *   A rejection fails the answer like a failed send.
 */
export type ApprovalAllowGate = () => Promise<boolean>

/** Request facts and the card's answer handed to an inline grant action. */
export interface ApprovalActionOwnerProps {
  /** Grant the request asks for. */
  grants: ApprovalGrant
  /** Tool requesting the decision, when the caller supplied it. */
  toolName: string | undefined
  /** Tool call correlated with the request, when supplied. */
  callId: ToolCallId | undefined
  /**
   * Answer the card as its Allow button does, through the same one-shot guard.
   * Resolves after the answer is sent, or at once without answering when the card already answered or no longer
   * accepts an answer; rejects with the send failure, after which the card accepts an answer again.
   */
  allow: () => Promise<void>
  /** Whether the card is sending or has sent an answer, as of this render; an action renders disabled while true. */
  answered: boolean
  /**
   * Whether the card accepts an answer now: false while it sends or after it sent one, and once its caller no longer
   * accepts one. An action with effects of its own reads it before each effect, because it can change across an await.
   */
  canAnswer: () => boolean
  /**
   * Set the gate every allow answer of this card passes before it is sent: the card's Allow button, Enter, and the
   * `allow` of each action and choice. `null` removes it. At most one gate stands; the last one set wins, and the card
   * drops it when it unmounts.
   */
  gateAllow: (gate: ApprovalAllowGate | null) => void
}

/** Request facts and the card's answer handed to a choice in the decision row. */
export interface ApprovalChoiceOwnerProps {
  /** The sandbox mode the request asks for. */
  escalatesTo: ApprovalEscalation
  /** Tool requesting the decision, when the caller supplied it. */
  toolName: string | undefined
  /** Tool call correlated with the request, when supplied. */
  callId: ToolCallId | undefined
  /** As {@link ApprovalActionOwnerProps.allow}: answers the card as allowed through the same one-shot lock. */
  allow: () => Promise<void>
  /** As {@link ApprovalActionOwnerProps.answered}. */
  answered: boolean
  /** As {@link ApprovalActionOwnerProps.canAnswer}. */
  canAnswer: () => boolean
  /**
   * Report whether the entry currently shows a button in the decision row; while any entry reports true, Allow once
   * draws as a secondary button so the choice is the primary one. An entry reports false when it unmounts.
   */
  offer: (shown: boolean) => void
}

/* jscpd:ignore-start -- deliberately mirrors `ApprovalRequestEvent` of `@deepseek-ai/dsh-user-approval`:
   the Client bundle declares its own copy and never imports the Host package. */
/** Client-visible fields of an approval request projected through Remote Events. */
export interface ApprovalPresentationRequest {
  /** Tool requesting the decision. */
  readonly toolName: string
  /** Tool call correlated with the request. */
  readonly callId?: ToolCallId
  /** Human-readable reason supplied by the requester. */
  readonly reason?: string
  /** Localized presentation copy; the audit reason remains unchanged. */
  readonly displayReason?: { readonly en: string; readonly [locale: string]: string }
  /** Localized line shown beside the request, apart from the asker's reason. */
  readonly notice?: { readonly en: string; readonly [locale: string]: string }
  /** What an `allowed-once` answer grants beyond an ordinary tool call, when it does. */
  readonly grants?: ApprovalGrant
  /** The sandbox mode a sandbox escalation asks for, when the request is one. */
  readonly escalatesTo?: ApprovalEscalation
  /** Set by a requester whose Host listener can honour an "allow for this run" answer; absent on every other request. */
  readonly runScope?: string
  /** Cancellation projected from the Host waterfall. */
  readonly signal?: AbortSignal
}
/* jscpd:ignore-end */

/** Decisions this interactive Client presentation can return. */
export type ApprovalDecision = 'allowed-once' | 'rejected'

let nextApprovalKey = 0

/** Domain discriminator literal carried by {@link PendingApproval.kind}. */
export type ApprovalInteractionKind = 'approval'

/** One answerable Client presentation of a pending Host waterfall. */
export class PendingApproval {
  /** Domain discriminator used by Session pending-interaction consumers. */
  readonly kind: 'approval'
  /** Opaque render identity and one-shot remount axis. */
  readonly key: string
  /** Tool requesting the decision. */
  readonly toolName: string
  /** Correlated Tool call, when supplied by the asker. */
  readonly callId: ToolCallId | undefined
  /** Human-readable reason supplied by the asker. */
  readonly reason: string | undefined
  /** Localized presentation copy, when supplied by the asker. */
  readonly displayReason: ApprovalPresentationRequest['displayReason']
  /** Localized notice apart from the reason, when supplied by the asker. */
  readonly notice: ApprovalPresentationRequest['notice']
  /** Grant an `allowed-once` answer gives, when the asker declared one. */
  readonly grants: ApprovalGrant | undefined
  /** The sandbox mode an escalation asked for, when the asker declared one. */
  readonly escalatesTo: ApprovalEscalation | undefined
  /** The run scope the asker declared, when it can honour an "allow for this run" answer. */
  readonly runScope: string | undefined
  /** Result returned by the Remote Event listener to the Host waterfall. */
  readonly result: Promise<ApprovalDecision>

  readonly #resolve: (outcome: ApprovalDecision) => void
  readonly #reject: (reason: unknown) => void
  readonly #signal: AbortSignal | undefined
  readonly #onAbort: (() => void) | undefined
  readonly #delegated = Symbol('pending approval delegated')
  #settled = false

  /**
   * @param sessionId - Agent/Session identity owning the scoped request.
   * @param request - Host approval request projected through the Remote Event.
   */
  constructor(readonly sessionId: SessionId, request: ApprovalPresentationRequest) {
    this.kind = 'approval'
    nextApprovalKey += 1
    this.key = `approval:${String(nextApprovalKey)}`
    this.toolName = request.toolName
    this.callId = request.callId
    this.reason = request.reason
    this.displayReason = request.displayReason
    this.notice = request.notice
    this.grants = request.grants
    this.escalatesTo = request.escalatesTo
    this.runScope = request.runScope
    const completion = Promise.withResolvers<ApprovalDecision>()
    this.result = completion.promise
    this.#resolve = completion.resolve
    this.#reject = completion.reject
    this.#signal = request.signal
    if (request.signal === undefined) {
      this.#onAbort = undefined
      return
    }
    const onAbort = (): void => {
      this.abort(request.signal?.reason ?? new Error('approval request was aborted'))
    }
    this.#onAbort = onAbort
    request.signal.addEventListener('abort', onAbort, { once: true })
    if (request.signal.aborted) onAbort()
  }

  /**
   * Availability of this pending request after answer or withdrawal.
   * @returns whether this request can still accept a decision.
   */
  get answerable(): boolean {
    return !this.#settled
  }

  /**
   * Resolve the Host waterfall with the user's decision.
   * @param outcome - supported interactive decision.
   */
  answer(outcome: ApprovalDecision): Promise<void> {
    return settlePendingComposer(() => {
      this.finish(() => { this.#resolve(outcome) })
    }, 'pending approval settlement failed')
  }

  /** Delegate an unanswered request to the next waterfall listener. */
  delegate(): void {
    if (this.#settled) return
    this.finish(() => { this.#reject(this.#delegated) })
  }

  /**
   * Test whether a rejection requests waterfall delegation.
   * @param reason - rejection received from {@link PendingApproval.result}.
   * @returns whether {@link PendingApproval.delegate} produced it.
   */
  isDelegation(reason: unknown): boolean {
    return reason === this.#delegated
  }

  /**
   * End an unanswered presentation when its transport, scope, or plugin lifetime ends.
   * @param reason - rejection exposed to the waiting Remote Event listener.
   */
  abort(reason: unknown): void {
    if (this.#settled) return
    this.finish(() => { this.#reject(reason) })
  }

  private finish(settle: () => void): void {
    if (this.#settled) throw new Error(`pending approval ${this.key} is already settled`)
    this.#settled = true
    if (this.#signal !== undefined && this.#onAbort !== undefined) {
      this.#signal.removeEventListener('abort', this.#onAbort)
    }
    settle()
  }
}

/** Locale lookup supplied by the approval registration. */
export interface ApprovalInjected {
  /**
   * Resolve requester-owned copy in the current UI language.
   * @param reason - localized presentation text with an English fallback.
   * @returns text for the active UI language.
   */
  resolveReason(reason: NonNullable<ApprovalPresentationRequest['displayReason']>): string
}

/** Full props of the approval composer takeover. */
export type ApprovalComposerProps =
  PropsRuntime<'conversation.composer'>
  & PropsRenderFactories
  & { matched: PendingApproval }
  & PropsLocale<'approval'>
  & ApprovalInjected

/** Data and decisions accepted by the shared approval card. */
export interface ApprovalCardInput {
  /** Identity whose change resets the pending submission. */
  requestKey: string
  /** Localized question describing the requested operation. */
  title: string
  /** Localized scope or consequence of the decision. */
  description?: string
  /** Caller-localized warning label and explanation, with paragraphs separated by blank lines (`\n\n`). */
  warning?: { label: string; title: string; detail: string }
  /** Subject metadata for human recognition; the caller admits icon URLs. Never an authorization identity. */
  subject?: { name: string; icon?: string }
  /** Optional tool-owned detail rendered through the existing child slot. */
  callId?: ToolCallId
  /** Tool requesting the decision, handed to inline grant actions. */
  toolName?: string
  /** Grant the request asks for; when present the card renders the `conversation.approval.action` list. */
  grants?: ApprovalGrant
  /** The sandbox mode the request escalates to; when present the card renders the `conversation.approval.choice` list. */
  escalatesTo?: ApprovalEscalation
  /** Caller-specific scope label; ordinary approvals use Allow once. */
  allowLabel?: string
  /** Whether the caller still accepts an answer. */
  canAnswer: () => boolean
  /** Grant this request with the caller's stated scope. */
  onAllow: () => Promise<void>
  /** Refuse this request. */
  onReject: () => Promise<void>
  /** Explicit persistent choice; absent when the caller cannot save permission. */
  onAlways?: () => Promise<void>
}
