/**
 * The settings rows of the agents the step offers. Each agent's package inserts its provider as one row; the step writes
 * that row's `model`.
 */

/** The row id each agent's package inserts. */
export const AGENT_ROWS = { 'claude-code': 'subagent-claude-code', 'codex': 'subagent-codex' } as const

/** A connection id of an agent the step offers. */
export type AgentId = keyof typeof AGENT_ROWS
