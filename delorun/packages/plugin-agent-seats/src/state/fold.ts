/**
 * The fold of a seat child's log into the seat's state and its `agentSeat` view. It reads only the log, so a reload, a
 * restore from a checkpoint and a resume compute the same value; a fork's inherited events are ignored, so a fork
 * (an ordinary chat) has no seat.
 * @module @delorun/plugin-agent-seats/state/fold
 */
import { pluginRecordOf, type SessionEvent } from '@deepseek-ai/dsh-session'
// Type-only: the `subagent/descriptor` event merge.
import type {} from '@deepseek-ai/dsh-subagent'
import { SEAT_STATE_RECORD, SEAT_STATUS_RECORD, type SeatStateRecordData, type SeatStatusRecordData } from './record.ts'
import type { AgentSeatView, SeatAgent, SeatModelPicker, SeatViewState } from './view.ts'

/** The fold's own version; bump it when the state fields or the fold change. */
export const SEAT_FOLD_VERSION = 5

/** The `ownSettings` the view carries before the program's settings are known; the chat then names no setting. */
export const DEFAULT_OWN_SETTINGS = ''

/** The longest final answer the view keeps, in characters. */
export const LAST_ANSWER_LIMIT = 4000

/** What the `agentSeat` view shows; replaced as a whole so an unrelated change keeps the view's reference. */
export interface SeatShown {
  /** The agent of the seat, or null in a chat that is not a seat child. */
  readonly agent: SeatAgent | null
  /** The agent's state. */
  readonly state: SeatViewState
  /** The program's version. */
  readonly version: string | null
  /** A short name for the program's own settings. */
  readonly ownSettings: string | null
  /** The plan's name. */
  readonly plan: string | null
  /** Percent of the 5-hour allowance used. */
  readonly fiveHourPercent: number | null
  /** Percent of the weekly allowance used. */
  readonly weeklyPercent: number | null
  /** When the 5-hour window resets. */
  readonly fiveHourResetAt: number | null
  /** Whether the program runs without the command sandbox its level wanted. */
  readonly sandboxUnavailable: boolean
  /** While `limit`: when the limit lifts. */
  readonly resetAt: number | null
  /** While `ended`: the reason. */
  readonly endedReason: string | null
  /** While `model-needed`: the models to pick from. */
  readonly modelPicker: SeatModelPicker | null
  /** When a question began to wait. */
  readonly pending: number | null
  /** The agent's latest final answer. */
  readonly lastAnswer: string | null
  /** How many turns of this chat have finished. */
  readonly turns: number
}

/** What the logged state record holds, with absent fields as null. */
export interface SeatLogged {
  /** The program's own session id. */
  readonly programSessionId: string | null
  /** The input cursor. */
  readonly cursor: string | null
  /** The program's last message id at its last turn end. */
  readonly programMessageId: string | null
}

/** The fold's state. */
export interface SeatProjectionState {
  /** Events below this sequence number came from a fork's parent and are ignored. */
  readonly inherited: number
  /** The logged state record. */
  readonly logged: SeatLogged
  /** Id of the newest message in the log, which a fresh program session skips after a failed resume. */
  readonly tail: string | null
  /** The provider of the child's own `subagent/descriptor`, or null before one. */
  readonly provider: string | null
  /** Whether the latest `approval/policy` event is the pin seeded at delegation. */
  readonly pinned: boolean
  /** What the view shows. */
  readonly shown: SeatShown
}

/** The state before any event. */
export const NO_LOGGED: SeatLogged = { programSessionId: null, cursor: null, programMessageId: null }

/** The view's fields before any event. */
export const NO_SHOWN: SeatShown = {
  agent: null, state: 'idle', version: null, ownSettings: null, plan: null, fiveHourPercent: null, weeklyPercent: null, fiveHourResetAt: null, sandboxUnavailable: false, resetAt: null, endedReason: null, modelPicker: null, pending: null, lastAnswer: null, turns: 0,
}

/**
 * The agent a subagent provider name stands for.
 * @param provider - the descriptor's provider, such as `claude-code-seat`.
 * @returns the agent, or null for any other provider.
 */
export function agentOfProvider(provider: string): SeatAgent | null {
  if (provider === 'claude-code-seat') return 'claude-code'
  if (provider === 'codex-seat') return 'codex'
  return null
}

const STICKY: ReadonlySet<SeatViewState> = new Set(['limit', 'not-signed-in', 'model-needed', 'ended'])

const text = (value: unknown): string | null => typeof value === 'string' ? value : null
const count = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) ? value : null

/**
 * Read a picker from a stored status record.
 * @param value - the stored `modelPicker`.
 * @returns the picker, or null when it is absent or malformed.
 */
function pickerOf(value: unknown): SeatModelPicker | null {
  if (typeof value !== 'object' || value === null) return null
  const { offered, planDefault } = value as { offered?: unknown, planDefault?: unknown }
  if (!Array.isArray(offered) || typeof planDefault !== 'string') return null
  const models: Array<{ readonly id: string, readonly label: string }> = []
  for (const item of offered as unknown[]) {
    const { id, label } = (item ?? {}) as { id?: unknown, label?: unknown }
    if (typeof id === 'string' && typeof label === 'string') models.push({ id, label })
  }
  return { offered: models, planDefault }
}

/**
 * Fold a status record into what the view shows. Stored records are read defensively: they come from the log.
 * @param shown - the view's fields before the record.
 * @param data - the stored payload.
 * @returns the next fields.
 */
function foldStatus(shown: SeatShown, data: Partial<SeatStatusRecordData>): SeatShown {
  const state = data.state
  if (state === undefined) return shown
  return {
    ...shown,
    state,
    version: text(data.version) ?? shown.version,
    ownSettings: text(data.ownSettings) ?? shown.ownSettings,
    plan: text(data.plan) ?? shown.plan,
    fiveHourPercent: count(data.fiveHourPercent) ?? shown.fiveHourPercent,
    weeklyPercent: count(data.weeklyPercent) ?? shown.weeklyPercent,
    fiveHourResetAt: count(data.fiveHourResetAt) ?? shown.fiveHourResetAt,
    sandboxUnavailable: data.sandboxUnavailable === true || (state !== 'starting' && shown.sandboxUnavailable),
    resetAt: count(data.resetAt),
    endedReason: text(data.endedReason),
    modelPicker: pickerOf(data.modelPicker),
    pending: count(data.pending),
  }
}

/**
 * The text of an assistant message that ends a turn: its text blocks, when it calls no tool.
 * @param event - an `assistant/message` event.
 * @returns the text, or null when the message calls a tool or has no text.
 */
function finalAnswerOf(event: SessionEvent<'assistant/message'>): string | null {
  const { content } = event.data.message
  if (content.some(block => block.type === 'tool-call')) return null
  const joined = content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n').trim()
  return joined === '' ? null : joined.slice(0, LAST_ANSWER_LIMIT)
}

/**
 * The id of the message an event carries.
 * @param event - a committed event.
 * @returns the id, or null for an event that carries no message.
 */
function messageIdOf(event: SessionEvent): string | null {
  switch (event.type) {
    case 'user/message':
      return event.data.id
    case 'assistant/message':
    case 'tool/result':
    case 'developer/message':
    case 'system/message':
      return event.data.message.id
    default:
      // The other events carry no message.
      return null
  }
}

/**
 * Fold one committed event.
 * @param previous - the state covering every earlier event.
 * @param event - the next committed event.
 * @returns the next state; the same reference for an event that changes nothing.
 */
export function foldSeat(previous: SeatProjectionState, event: SessionEvent): SeatProjectionState {
  if (event.seq < previous.inherited) return previous
  const messageId = messageIdOf(event)
  const state = messageId === null || messageId === previous.tail ? previous : { ...previous, tail: messageId }
  if (event.type === 'subagent/descriptor') {
    const { provider } = event.data
    const agent = agentOfProvider(provider)
    const named = provider === state.provider ? state : { ...state, provider }
    return agent === null || agent === named.shown.agent ? named : { ...named, shown: { ...named.shown, agent } }
  }
  if (event.type === 'approval/policy') {
    const pinned = event.data.source === 'delegation'
    return pinned === state.pinned ? state : { ...state, pinned }
  }
  const record = pluginRecordOf(event)
  if (record !== undefined) {
    if (record.type === SEAT_STATE_RECORD) {
      const data = record.data as Partial<SeatStateRecordData>
      return { ...state, logged: { programSessionId: text(data.programSessionId), cursor: text(data.cursor), programMessageId: text(data.programMessageId) } }
    }
    if (record.type === SEAT_STATUS_RECORD) return { ...state, shown: foldStatus(state.shown, record.data as Partial<SeatStatusRecordData>) }
    // The notice record is for the transcript and changes no state; any other record is another plugin's.
    return state
  }
  if (state.shown.agent === null) return state
  switch (event.type) {
    case 'turn/start':
      return { ...state, shown: { ...state.shown, state: 'working', resetAt: null, endedReason: null, modelPicker: null, pending: null } }
    case 'turn/end': {
      const turns = state.shown.turns + 1
      return { ...state, shown: STICKY.has(state.shown.state) ? { ...state.shown, turns } : { ...state.shown, state: 'idle', pending: null, turns } }
    }
    case 'assistant/message': {
      const answer = finalAnswerOf(event)
      return answer === null || answer === state.shown.lastAnswer ? state : { ...state, shown: { ...state.shown, lastAnswer: answer } }
    }
    default:
      // Every other event leaves the seat as it was.
      return state
  }
}

/**
 * The client view of a state.
 * @param shown - what the view shows.
 * @returns the view, or null in a chat that is not a seat child.
 */
export function viewOf(shown: SeatShown): AgentSeatView | null {
  if (shown.agent === null) return null
  return {
    agent: shown.agent,
    ...shown.version === null ? {} : { version: shown.version },
    ownSettings: shown.ownSettings ?? DEFAULT_OWN_SETTINGS,
    sandbox: 'off',
    ...shown.sandboxUnavailable ? { sandboxUnavailable: true } : {},
    state: shown.state,
    ...shown.plan === null ? {} : { plan: shown.plan },
    ...shown.fiveHourPercent === null ? {} : { fiveHourPercent: shown.fiveHourPercent },
    ...shown.weeklyPercent === null ? {} : { weeklyPercent: shown.weeklyPercent },
    ...shown.fiveHourResetAt === null ? {} : { fiveHourResetAt: shown.fiveHourResetAt },
    ...shown.resetAt === null ? {} : { resetAt: shown.resetAt },
    ...shown.endedReason === null ? {} : { endedReason: shown.endedReason },
    ...shown.pending === null ? {} : { pending: { since: shown.pending } },
    ...shown.lastAnswer === null ? {} : { lastAnswer: shown.lastAnswer },
    ...shown.turns === 0 ? {} : { turns: shown.turns },
    ...shown.modelPicker === null ? {} : { modelPicker: shown.modelPicker },
  }
}
