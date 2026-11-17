/**
 * How the lists read a child chat's live-agent state out of its projection values.
 * @module
 */
import type { SessionProjectionMap } from '@deepseek-ai/dsh-api-session-controller/client'
import type { AgentSeatView } from '../view.ts'

/**
 * The live agent of a row, when the row is one.
 * @param values - the child's projection values as the catalog read them.
 * @returns the agent, undefined for an ordinary subagent or before the first read.
 */
export function seatOf(values: Readonly<Partial<SessionProjectionMap>>): AgentSeatView | undefined {
  return values.agentSeat
}

/**
 * Whether a question of the agent waits for an answer: the child's approval card, which the relay asks through the
 * stock approval service, is open.
 * @param row - the row's slot owner.
 * @returns true while the card waits.
 */
export function waitingOf(row: { readonly awaitingApproval: boolean }): boolean {
  return row.awaitingApproval
}
