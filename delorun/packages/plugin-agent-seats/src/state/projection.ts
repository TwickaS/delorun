/**
 * The `agentSeat` session projection: a seat child's logged state and the view its chat shows. The state stays
 * on the Host; the view reaches the client as `agentSeat`, and is null in a chat that is not a seat child.
 * @module @delorun/plugin-agent-seats/state/projection
 */
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import { z } from 'zod'
import { foldSeat, NO_LOGGED, NO_SHOWN, SEAT_FOLD_VERSION, viewOf, type SeatProjectionState, type SeatShown } from './fold.ts'
import type { AgentSeatView } from './view.ts'

/** The projection key. */
export const AGENT_SEAT_KEY = 'agentSeat'

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    /** The live agent of a seat child's chat, from `@delorun/plugin-agent-seats`; null in any other chat. */
    agentSeat: AgentSeatView | null
  }
}

const agent = z.enum(['claude-code', 'codex'])

const pickerSchema = z.object({
  offered: z.array(z.object({ id: z.string(), label: z.string() }).strict()),
  planDefault: z.string(),
}).strict()

const shownSchema = z.object({
  agent: agent.nullable(),
  state: z.enum(['starting', 'working', 'idle', 'limit', 'not-signed-in', 'model-needed', 'ended']),
  version: z.string().nullable(),
  ownSettings: z.string().nullable(),
  plan: z.string().nullable(),
  fiveHourPercent: z.number().nullable(),
  weeklyPercent: z.number().nullable(),
  fiveHourResetAt: z.number().nullable(),
  sandboxUnavailable: z.boolean(),
  resetAt: z.number().nullable(),
  endedReason: z.string().nullable(),
  modelPicker: pickerSchema.nullable(),
  pending: z.number().nullable(),
  lastAnswer: z.string().nullable(),
  turns: z.number().int().nonnegative(),
}).strict()

/** The fold's state schema, which checks a stored checkpoint before it seeds a fold. */
export const seatStateSchema: z.ZodType<SeatProjectionState> = z.object({
  inherited: z.number().int().nonnegative(),
  tail: z.string().nullable(),
  provider: z.string().nullable(),
  pinned: z.boolean(),
  logged: z.object({ programSessionId: z.string().nullable(), cursor: z.string().nullable(), programMessageId: z.string().nullable() }).strict(),
  shown: shownSchema,
}).strict()

const viewSchema: z.ZodType<AgentSeatView | null> = z.object({
  agent,
  version: z.string().optional(),
  ownSettings: z.string(),
  sandbox: z.literal('off'),
  sandboxUnavailable: z.literal(true).optional(),
  state: shownSchema.shape.state,
  plan: z.string().optional(),
  fiveHourPercent: z.number().optional(),
  weeklyPercent: z.number().optional(),
  fiveHourResetAt: z.number().optional(),
  resetAt: z.number().optional(),
  endedReason: z.string().optional(),
  pending: z.object({ since: z.number() }).strict().optional(),
  lastAnswer: z.string().optional(),
  turns: z.number().int().positive().optional(),
  modelPicker: pickerSchema.optional(),
}).strict().nullable() as z.ZodType<AgentSeatView | null>

/**
 * The projection definition of the seat state and its view.
 * @returns the definition to register.
 */
export function agentSeatProjection() {
  const views = new WeakMap<SeatShown, AgentSeatView | null>()
  return {
    key: AGENT_SEAT_KEY,
    stateVersion: SEAT_FOLD_VERSION,
    stateSchema: seatStateSchema,
    init: (_header, inheritedEventCount) => ({ inherited: Number(inheritedEventCount), tail: null, provider: null, pinned: false, logged: NO_LOGGED, shown: NO_SHOWN }),
    apply: foldSeat,
    wire: {
      viewSchema,
      // The view depends only on what is shown, so a change of the program's session keeps the published reference.
      view: (state) => {
        const cached = views.get(state.shown)
        if (cached !== undefined) return cached
        const value = viewOf(state.shown)
        views.set(state.shown, value)
        return value
      },
    },
  } satisfies ProjectionDefinition<typeof AGENT_SEAT_KEY, SeatProjectionState>
}
