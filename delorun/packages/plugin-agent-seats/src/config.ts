/**
 * The seats row's configuration: one entry per live agent the harness offers a chat.
 * @module @delorun/plugin-agent-seats/config
 */
import z from '@deepseek-ai/schemastery'

/** The Loader row id, which names the settings namespace. */
export const SEATS_ROW_ID = 'delorun-agent-seats'

/** One live agent: the subagent provider it hands to, the hidden model route its turns use, its preset and the tool the lead's model sees. */
export interface SeatConfig {
  /** The subagent provider id (`claude-code`, `codex`). */
  provider: string
  /** The hidden route id the seat child's turns use; it never appears in a model picker. */
  route: string
  /** The agent preset id that composes the seat child. */
  preset: string
  /** The hand-off tool's name in the lead's tool list. */
  toolName: string
  /** The deepest chain of seat children that may hand work on; 1 means a seat child cannot hand over again. */
  maxDepth: number
}

/** The row's configuration. */
export interface Config {
  seats: SeatConfig[]
}

const Seat: z<SeatConfig> = z.object({
  provider: z.string().required(),
  route: z.string().required(),
  preset: z.string().required(),
  toolName: z.string().pattern(/^[a-z][a-z0-9_]{0,63}$/).required(),
  maxDepth: z.natural().min(1).default(1),
})

/** Validates the row's configuration. Two seats may not share a provider, route or tool name. */
export const Config: z<Config> = z.object({
  seats: z.array(Seat).default([
    { provider: 'claude-code', route: 'claude-code-seat', preset: 'claude-code-seat', toolName: 'claude_code', maxDepth: 1 },
    { provider: 'codex', route: 'codex-seat', preset: 'codex-seat', toolName: 'codex', maxDepth: 1 },
  ]),
}).description('Live agents') as z<Config>
