/**
 * The approval card for a live agent's question: Reject, Allow for this run and Allow once, answered through the
 * pending approval's own `answer`. "Allow for this run" is the answer value `'allowed-for-run'`, which the Host side
 * turns into an allowed-once answer plus the run's allowance. A phone that cannot grant shows Reject and an unlock
 * button instead.
 */
import { useState, useSyncExternalStore } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ApprovalDecision, PendingApproval } from '@deepseek-ai/dsh-client-ui-approval/client'
import type { ComposerChainProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { SeatReach, SeatReachSource } from './actions.ts'
import type { SeatTranslate } from './Banner.tsx'
import { isRecordName } from './tool-model.ts'
import { AGENT_NAMES, type SeatAgent } from './view.ts'
import css from './Seat.module.css'

/** The answer value of "Allow for this run". */
export const ALLOWED_FOR_RUN = 'allowed-for-run'

/**
 * The one place the client sends an answer outside its closed `ApprovalDecision` type: the gateway accepts any JSON
 * answer, and the Host's seat listener maps this value to allowed-once and records the run allowance. Every other
 * Host listener maps an unknown value to `unavailable`.
 * @returns the answer value typed as a decision.
 */
export function allowedForRunDecision(): ApprovalDecision {
  const value: string = ALLOWED_FOR_RUN
  return value as ApprovalDecision
}

/**
 * Elect a pending approval that is a live agent's question.
 * @param owner - the composer chain's facts.
 * @returns the pending approval, or `null` for any other interaction.
 */
export function selectSeatApproval(owner: ComposerChainProps): PendingApproval | null {
  const pending = owner.pendingInteraction
  if (pending === undefined || pending.kind !== 'approval') return null
  const approval = pending as PendingApproval
  return approval.grants === 'external-agent' && owner.session?.subagent !== undefined ? approval : null
}

/** The program a record tool name belongs to. */
export function agentOfTool(toolName: string): SeatAgent {
  return toolName.startsWith('codex.') ? 'codex' : 'claude-code'
}

/** What the studio injects. */
export interface ApprovalInjected {
  /** This page's reach for approvals; absent means the computer. */
  readonly reach: SeatReachSource | undefined
  /** Format an epoch-millisecond time of day. */
  readonly clock: (epochMs: number) => string
}

/** Props of the composer entry. */
export interface SeatApprovalProps extends ApprovalInjected {
  /** The elected pending approval. */
  readonly matched: PendingApproval
  /** The dictionary. */
  readonly t: SeatTranslate
}

const COMPUTER: SeatReach = { kind: 'computer' }

function useReach(source: SeatReachSource | undefined): SeatReach {
  return useSyncExternalStore(
    source?.subscribe ?? (() => () => undefined),
    source?.get ?? (() => COMPUTER),
  )
}

/**
 * The card.
 * @param props - the pending approval, the studio's reach source and the dictionary.
 * @returns the card.
 */
export function SeatApproval({ matched, t, reach, clock }: SeatApprovalProps) {
  const standing = useReach(reach)
  const [sent, setSent] = useState(false)
  const agent = AGENT_NAMES[agentOfTool(matched.toolName)]
  const send = (decision: ApprovalDecision): void => {
    if (sent || !matched.answerable) return
    setSent(true)
    void matched.answer(decision).catch(() => { setSent(false) })
  }
  const canGrant = standing.kind !== 'locked-phone'
  // Every seat question carries a run scope; a tool that is not a program's record can only be allowed once.
  const canRun = isRecordName(matched.toolName)
  return (
    <div className={css.approval} role="group" aria-label={t('approval.waiting')} aria-busy={sent} data-seat-approval="">
      <span className={css.waiting}>● {t('approval.waiting')}</span>
      <span className={css.approvalTitle}>{t('approval.title', { agent })}</span>
      {matched.reason !== undefined && <div className={css.command}>{matched.reason}</div>}
      <p className={css.text}>{t('approval.note', { agent })}</p>
      {standing.kind === 'unlocked-phone' && <p className={css.text}>{t('approval.unlockedUntil', { time: clock(standing.until) })}</p>}
      {standing.kind === 'locked-phone' && <p className={css.text}>{t('approval.locked')}</p>}
      <div className={css.actions}>
        <Button variant="outline" disabled={sent} onClick={() => { send('rejected') }}>{t('approval.reject')}</Button>
        {canGrant && canRun && (
          <Button variant="outline" disabled={sent} onClick={() => { send(allowedForRunDecision()) }}>{t('approval.forRun')}</Button>
        )}
        {canGrant && <Button variant="primary" disabled={sent} onClick={() => { send('allowed-once') }}>{t('approval.once')}</Button>}
        {!canGrant && reach !== undefined && (
          <Button variant="primary" onClick={() => { reach.openUnlock() }}>{t('approval.unlock')}</Button>
        )}
      </div>
    </div>
  )
}
