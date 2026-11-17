/**
 * The ports the seat adapter takes from the rest of the seat plugin: the seat's logged state, the per-workspace chosen
 * model, and the facts the adapter reports about a turn that cannot run. Each is an interface so the adapter does not
 * know where the state is kept.
 * @module @delorun/plugin-agent-seats/adapter/state-port
 */
import type { ExternalAgentName, OfferedModel, ProgramFailure, SessionId } from '@delorun/external-agents/contract'

/** A seat's logged state: which program session backs it (absent after an unreadable resume, so the next message starts a fresh one) and how far input has reached the program. */
export interface SeatState {
  /** The program's own session or thread id, which `resume` takes. */
  readonly programSessionId?: string
  /** Id of the last harness message handed to the program; absent before the first input. */
  readonly cursor?: string
}

/** Where a seat's state is kept. The seat state record implements it. */
export interface SeatStateStore {
  /**
   * Read the seat's latest state.
   * @param child - the seat child's Session id.
   * @returns the state, or undefined before the program session exists.
   */
  read(child: SessionId): SeatState | undefined | Promise<SeatState | undefined>
  /**
   * Keep the seat's state; the latest write wins.
   * @param child - the seat child's Session id.
   * @param state - the state to keep.
   */
  write(child: SessionId, state: SeatState): void | Promise<void>
}

/** The model a person picked for each workspace's agent (EA22), kept apart from the program's own settings. */
export interface SeatModelChoices {
  /**
   * The model picked for a workspace.
   * @param workspace - the workspace key of the seat's root chat.
   * @returns the program's model id, or undefined when none is picked.
   */
  get(workspace: string): string | undefined
  /**
   * Keep the pick.
   * @param workspace - the workspace key.
   * @param id - the program's model id, one the program offered.
   */
  set(workspace: string, id: string): void
}

/**
 * The refusal of EA22: the model the program would use is not on the person's plan. The turn ends before the program
 * runs; the chat shows `offered` as a picker and stores the pick through {@link SeatModelChoices.set}.
 */
export interface ModelNotOffered {
  /** The seat child whose turn ended. */
  readonly child: SessionId
  /** The agent whose model is not offered. */
  readonly provider: ExternalAgentName
  /** The model the program would have used. */
  readonly configured: string
  /** The models the plan offers. */
  readonly offered: readonly OfferedModel[]
}

/** What the adapter reports to the rest of the plugin; every handler is optional. */
export interface SeatAdapterEvents {
  /**
   * The program is being started or resumed, so the chat can show "Starting Claude Code…" (EA23). {@link onStarted}
   * or {@link onStartFailed} follows.
   * @param child - the seat child.
   * @param provider - the agent starting.
   */
  onStarting?(child: SessionId, provider: ExternalAgentName): void
  /**
   * The program answered the start, so the chat is working.
   * @param child - the seat child.
   */
  onStarted?(child: SessionId, started: { readonly sandboxUnavailable: boolean }): void
  /**
   * The start ended without a program, whether the gate refused it or it failed, so the "Starting …" state ends. The
   * turn's own failure follows through {@link onTurnFailure} when it is one the chat shows.
   * @param child - the seat child.
   */
  onStartFailed?(child: SessionId): void
  /**
   * The turn ended because the model is not offered (EA22).
   * @param payload - the offered list for the picker.
   */
  onModelNotOffered?(payload: ModelNotOffered): void
  /**
   * The turn ended on a failure the person should see in words of their own: a reached limit with its reset time
   * (EA12), a signed-out program, an unreadable resume, or the program's own `detail`. The adapter's finish chunk
   * carries only a fixed sentence.
   * @param child - the seat child.
   * @param failure - why the turn ended.
   */
  onTurnFailure?(child: SessionId, failure: ProgramFailure): void
}
