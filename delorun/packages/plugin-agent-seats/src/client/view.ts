/**
 * The `agentSeat` session projection as the client reads it: the live agent a seat child's chat shows. The Host side
 * folds it from the seat's log; a chat that is not a seat child has no value.
 * @module
 */

export type { AgentSeatView, SeatAgent, SeatModelOffer, SeatModelPicker } from '../state/view.ts'
export type { SeatViewState as SeatState } from '../state/view.ts'

import type { AgentSeatView, SeatAgent } from '../state/view.ts'

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    /** The live agent of a seat child's chat, from `@delorun/plugin-agent-seats`; null in any other chat. */
    agentSeat: AgentSeatView | null
  }
}

/** The program's display name. */
export const AGENT_NAMES: Readonly<Record<SeatAgent, string>> = { 'claude-code': 'Claude Code', codex: 'Codex' }

/**
 * The sign-in command for a program.
 * @param agent - the program to sign in.
 * @returns the command, as `delorun agents login <agent>`.
 */
export function loginCommand(agent: SeatAgent): string {
  return `delorun agents login ${agent}`
}
