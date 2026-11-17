/**
 * A limits check through the start gate: the gate's `probe` runs the agent's driver in a folder the gate picks, counted
 * against the programs the home may run at once, and this module turns its answer or its refusal into the account
 * service's {@link CheckResult}.
 *
 * @module @delorun/external-agents/accounts/check
 */
import { GateRefusedError, type ExternalAgentsGate } from '../contract.ts'
import { AGENT_PACKS } from '../locate.ts'
import type { CheckResult } from './service.ts'
import { problemOf } from './store.ts'

/**
 * The account service's check, run through a gate.
 * @param gate - the start gate.
 * @returns the check: the program's figures, `not-installed` when no driver is registered, `refused` with a sentence
 *   for the person when the gate refused for another reason, or `failed` with the failure's words.
 */
export function checkThrough(gate: Pick<ExternalAgentsGate, 'probe'>): (provider: Parameters<ExternalAgentsGate['probe']>[0], signal: AbortSignal) => Promise<CheckResult> {
  return async (provider, signal) => {
    try {
      return { kind: 'observed', observation: await gate.probe(provider, signal) }
    } catch (error) {
      if (!(error instanceof GateRefusedError)) return { kind: 'failed', problem: problemOf(error) }
      const refusal = error.refusal
      switch (refusal.category) {
        case 'not-installed':
          return { kind: 'not-installed' }
        case 'capacity':
          return { kind: 'refused', problem: `The most agent programs this home runs at once are running (${refusal.busy.map(busy => AGENT_PACKS[busy].title).join(', ')}). Check again once one finishes.` }
        case 'consent':
          return { kind: 'refused', problem: refusal.reason }
        case 'limit':
          return { kind: 'refused', problem: `${AGENT_PACKS[provider].title} is at a plan limit, so it was not checked.` }
      }
    }
  }
}
