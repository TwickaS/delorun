/**
 * The agent preset that composes a seat child: the program is the model, so the preset carries a bare persona and the
 * seat tool executor, and no compaction, instructions, file, shell, web or subagent rows.
 * @module @delorun/plugin-agent-seats/executor/preset
 */
import type { PresetDefinition } from '@deepseek-ai/dsh-agent-preset-registry'
import type { SeatConfig } from '../config.ts'

/** The module a preset row names to mount the seat executor; the package's `./executor` export. */
export const SEAT_EXECUTOR_MODULE = '@delorun/plugin-agent-seats/executor'

/**
 * The prefix of a seat's recorded tool names. It is the hand-off tool's name with a dot, which no registered tool
 * name carries, so the native executor can never run a record.
 * @param seat - the seat.
 * @returns the prefix, such as `claude_code.`.
 */
export function recordPrefixOf(seat: Pick<SeatConfig, 'toolName'>): string {
  return `${seat.toolName}.`
}

/**
 * Declare the preset of one seat. The adapter discards the system message, so the persona is one line.
 * @param seat - the seat the preset composes.
 * @returns the definition to register with the preset registry.
 */
export function seatPreset(seat: SeatConfig): PresetDefinition {
  return {
    id: seat.preset,
    name: seat.toolName,
    plugins: [
      {
        id: 'persona',
        name: '@deepseek-ai/dsh-persona',
        config: { prefix: 'This chat is a live seat for an external coding agent, which does the work itself.', complete: true, includeRuntimeContext: false },
      },
      { id: 'seat-executor', name: SEAT_EXECUTOR_MODULE, config: { recordPrefix: recordPrefixOf(seat) } },
    ],
  }
}
