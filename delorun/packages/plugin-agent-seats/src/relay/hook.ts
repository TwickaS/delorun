/**
 * Builds the seat relay from the mounted seat state: how a program's permission questions reach the approval service of
 * its seat child, and how a waiting question shows in the chat's `agentSeat` view.
 * @module @delorun/plugin-agent-seats/relay/hook
 */
import type { SeatApprover, SeatRelayHook } from '../mount.ts'
import { recordPrefixOf } from '../executor/index.ts'
import { isExternalAgentName, seatProviderName } from '../provider/index.ts'
import type { SeatConfig } from '../config.ts'
import { agentTitle } from '@delorun/external-agents/copy'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { ProgramApprovalRequest } from '@delorun/external-agents/contract'
import { questionRefusedNotice, type QuestionRefusal } from './copy.ts'
import { SeatRelay } from './relay.ts'

/**
 * The relay of a mounted home: seats are the Sessions the gate holds whose descriptor names a configured seat provider;
 * a call is asked about once the executor recorded it, under the name the executor gave the record.
 * @param wiring - the plugin context, the mounted state and the configured seats.
 * @returns the approver for `SeatStartRequest.onApproval`; it lifts the child's delegation pin before its first question.
 */
export const seatRelay: SeatRelayHook = (wiring) => {
  const { ctx, state, seatProviders, seats } = wiring
  const seatOf = (child: Agent): SeatConfig => {
    const provider = state.store.providerOf(child.id)
    const seat = seats.find(candidate => seatProviderName(candidate.provider) === provider)
    if (seat === undefined) throw new Error(`delorun-agent-seats: ${child.id} is no configured seat, so its calls have no record name`)
    return seat
  }
  const logger = ctx.logger('agent-seats')
  const refuse = (child: SessionId, request: ProgramApprovalRequest, why: QuestionRefusal): void => {
    try {
      state.store.notice(child, 'question-refused', questionRefusedNotice(request.toolName, why))
    } catch (error: unknown) {
      logger.warn('a refused question of %s could not be shown: %s', child, error instanceof Error ? error.message : String(error))
    }
  }
  const relay = new SeatRelay(ctx, {
    seatProviders,
    descriptorOf: child => state.store.providerOf(child.id),
    pinned: child => state.store.delegationPinned(child.id),
    // An aborted wait is the relay's to read from the signal; it is not a failure of the ledger.
    recorded: (child, callId, signal) => state.records.recorded(child.id, callId, signal).catch((error: unknown) => {
      if (!signal.aborted) throw error
    }),
    recordName: (child, toolName) => `${recordPrefixOf(seatOf(child))}${toolName}`,
    refused: (child, request, why) => { refuse(child.id, request, why) },
    agentName: (child) => {
      const { provider } = seatOf(child)
      return isExternalAgentName(provider) ? agentTitle(provider) : provider
    },
  })
  ctx.effect(() => relay.onPendingChange((child, waiting) => {
    try {
      // A seat whose turn already ended shows no question, so clearing it again would only add a record.
      if (!waiting && state.store.viewOf(child)?.pending === undefined) return
      state.setPending(child, waiting ? Date.now() : undefined)
    } catch (error: unknown) {
      logger.warn('the waiting question of %s could not be shown: %s', child, error instanceof Error ? error.message : String(error))
    }
  }), 'delorun-agent-seats: waiting questions')
  const approver: SeatApprover = (child, startSignal) => {
    const ask = relay.onApproval(child, startSignal)
    return (request) => {
      relay.liftOnce(child)
      return ask(request)
    }
  }
  return approver
}
