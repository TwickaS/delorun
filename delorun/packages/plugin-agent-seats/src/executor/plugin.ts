/**
 * The seat preset's executor row: mounts {@link SeatToolExecutor} in the preset's scope so a seat child's tool calls
 * are records and no native executor can run one.
 * @module @delorun/plugin-agent-seats/executor/plugin
 */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { SeatToolExecutor } from './executor.ts'
import { SEAT_OUTPUT_CAP } from './output-cap.ts'
import './types.ts'

/** The most harness tools a program message runs at once; the native executor's own default. */
export const SEAT_MAX_PARALLEL_HARNESS_TOOLS = 10

/** The executor row's configuration. */
export interface Config {
  /** The prefix of this seat's recorded tool names, such as `claude_code.`. */
  recordPrefix: string
}

/** Validates the executor row's configuration. */
export const Config: z<Config> = z.object({
  recordPrefix: z.string().pattern(/^[a-z][a-z0-9_]*\.$/).required(),
})

/** The Loader row name. */
export const name = 'delorun-agent-seat-executor'

/** The services the executor needs before it mounts. */
export const inject = ['tools', 'seatPrograms']

export { Config as schema }

/**
 * Mount the seat executor in the calling preset scope.
 * @param ctx - the preset scope's context.
 * @param config - the validated row configuration.
 */
export function apply(ctx: Context, config: Config): void {
  ctx.tools.setExecutor(new SeatToolExecutor({
    ctx,
    programs: ctx.seatPrograms,
    recordPrefix: config.recordPrefix,
    outputCap: SEAT_OUTPUT_CAP,
    maxParallel: SEAT_MAX_PARALLEL_HARNESS_TOOLS,
  }))
}
