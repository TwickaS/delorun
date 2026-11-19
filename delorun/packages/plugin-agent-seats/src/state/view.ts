/**
 * The `agentSeat` session projection as the client reads it: the live agent a seat child's chat shows. The Host side
 * folds it from the seat's log; a chat that is not a seat child has the value `null`.
 * @module @delorun/plugin-agent-seats/state/view
 */

/** The programs that can sit as a live agent. */
export type SeatAgent = 'claude-code' | 'codex'

/** A model the person's plan offers. */
export interface SeatModelOffer {
  /** The program's model id. */
  readonly id: string
  /** The name shown in the picker. */
  readonly label: string
}

/** The plan's offered models, shown once per workspace when the person's default is not on the plan (EA22). */
export interface SeatModelPicker {
  /** Models the plan offers. */
  readonly offered: readonly SeatModelOffer[]
  /** The id of the plan's own default, marked in the picker. */
  readonly planDefault: string
}

/** The agent's state, in the words the chat shows. */
export type SeatViewState = 'starting' | 'working' | 'idle' | 'limit' | 'not-signed-in' | 'model-needed' | 'ended'

/** What the chat knows about its live agent. Same fields as the client's `AgentSeatView` (ea2/chat). */
export interface AgentSeatView {
  /** Which program runs this chat. */
  readonly agent: SeatAgent
  /** The program's version, when it has reported one. */
  readonly version?: string
  /** A short name for the program's own settings, such as `accept edits`. */
  readonly ownSettings: string
  /** Whether the program's own sandbox confines it at its level; absent until the program has started. */
  readonly sandbox?: 'on' | 'off'
  /** The agent's state. */
  readonly state: SeatViewState
  /** The plan's name, such as `Max`, when known. */
  readonly plan?: string
  /** Percent of the 5-hour allowance used, when known. */
  readonly fiveHourPercent?: number
  /** Percent of the weekly allowance used, when known. */
  readonly weeklyPercent?: number
  /** When the 5-hour window resets, epoch milliseconds. */
  readonly fiveHourResetAt?: number
  /** While `state` is `limit`: when the limit lifts, epoch milliseconds. */
  readonly resetAt?: number
  /** While `state` is `ended`: the plain-words reason. */
  readonly endedReason?: string
  /** Set while a question of the agent waits for an answer; `since` is epoch milliseconds. */
  readonly pending?: { readonly since: number }
  /** The agent's final answer of its latest finished turn, for the hand-off line in the lead chat. */
  readonly lastAnswer?: string
  /** How many turns of this chat have finished; absent before the first one. */
  readonly turns?: number
  /** While `state` is `model-needed`: the models to pick from. */
  readonly modelPicker?: SeatModelPicker
}
