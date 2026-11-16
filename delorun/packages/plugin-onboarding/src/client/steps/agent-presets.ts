/**
 * The presets the agents step offers for each agent: a plain outcome per preset, with the one provider setting it
 * writes. Every preset is the default or stricter than it; a looser mode of either provider is never offered.
 */

/** The row id each agent's package inserts, whose settings the presets write. */
export const AGENT_ROWS = { 'claude-code': 'subagent-claude-code', 'codex': 'subagent-codex' } as const

/** A connection id of an agent the step offers. */
export type AgentId = keyof typeof AGENT_ROWS

/** One preset of an agent. */
export interface AgentPreset {
  /** The key of its copy. */
  readonly id: 'recommended' | 'readOnly'
  /** The provider's `permissionMode` value it writes. */
  readonly mode: string
}

/** The presets of each agent; the first is the default the provider ships and the one Add leaves in place. */
export const AGENT_PRESETS: Readonly<Record<AgentId, readonly [AgentPreset, AgentPreset]>> = {
  // `dontAsk` refuses what the agent's own settings do not already allow; `plan` returns a plan and edits nothing.
  'claude-code': [{ id: 'recommended', mode: 'dontAsk' }, { id: 'readOnly', mode: 'plan' }],
  // `never` never asks and leaves the sandbox to Codex's own settings; `read-only` also pins its sandbox to read-only.
  'codex': [{ id: 'recommended', mode: 'never' }, { id: 'readOnly', mode: 'read-only' }],
}
