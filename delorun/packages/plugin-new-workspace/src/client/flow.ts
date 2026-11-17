/**
 * The flow's state machine: which screen shows, what the person chose so far and the reason a screen shows in place.
 * Pure, so it is tested without React. The screens are one ordered list, {@link SCREENS}, so a later screen is inserted
 * there; nothing else counts screens.
 * @module @delorun/plugin-new-workspace/client/flow
 */
import type { CloneFailure, CloneProblem, CreateProblem, PlaceProblem } from '../wire.ts'

/** How many screens the finished flow has, which "Step n of 5" shows. Screens 3 to 5 arrive after the ones built here. */
export const STEP_TOTAL = 5

/** The screens built so far, in order. A screen is reached through one or more {@link Step}s. */
export const SCREENS = ['how', 'where'] as const

/** One of {@link SCREENS}. */
export type Screen = typeof SCREENS[number]

/** A step the dialog can show; `folder` doubles as the place picker while {@link FlowState.picking} is set. */
export type Step = 'how' | 'folder' | 'new-folder' | 'clone'

/** The screen each step belongs to. */
const SCREEN_OF: Readonly<Record<Step, Screen>> = { 'how': 'how', 'folder': 'where', 'new-folder': 'where', 'clone': 'where' }

/** The three ways to start. */
export type Method = 'new-folder' | 'folder' | 'clone'

/** What the person chose. A clone's `job` is set once it started on the Host. */
export type Choice =
  | { readonly kind: 'existing', readonly path: string }
  | { readonly kind: 'new', readonly parent: string, readonly name: string, readonly git: boolean }
  | { readonly kind: 'clone', readonly url: string, readonly branch: string, readonly parent: string, readonly name: string, readonly job?: string }

/** A reason the screen shows in place, with the screen it belongs to. */
export type Problem =
  | { readonly kind: 'place', readonly problem: PlaceProblem }
  | { readonly kind: 'create', readonly problem: CreateProblem }
  | { readonly kind: 'clone', readonly problem: CloneProblem }
  | { readonly kind: 'clone-failed', readonly failure: CloneFailure }
  | { readonly kind: 'clone-lost' }
  | { readonly kind: 'locked' }
  | { readonly kind: 'refused-arrival' }
  | { readonly kind: 'failed' }

/** The flow's state. */
export interface FlowState {
  /** The step on show. */
  readonly step: Step
  /** The card highlighted on the first screen. */
  readonly method: Method | undefined
  /** What the person chose; set when a way to start is chosen. */
  readonly choice: Choice | undefined
  /** The step the place picker returns to, set while the folder step picks a place instead of a workspace. */
  readonly picking: 'new-folder' | 'clone' | undefined
  /** The reason the step shows in place. */
  readonly problem: Problem | undefined
}

/** Everything that moves the flow. */
export type FlowAction =
  | { readonly type: 'method', readonly method: Method, readonly parent: string }
  | { readonly type: 'continue' }
  | { readonly type: 'existing', readonly path: string }
  | { readonly type: 'edit-new', readonly change: Partial<Omit<Extract<Choice, { kind: 'new' }>, 'kind'>> }
  | { readonly type: 'edit-clone', readonly change: Partial<Omit<Extract<Choice, { kind: 'clone' }>, 'kind'>> }
  | { readonly type: 'pick-place' }
  | { readonly type: 'place-picked', readonly path: string }
  | { readonly type: 'back' }
  | { readonly type: 'problem', readonly problem: Problem | undefined }
  | { readonly type: 'clone-started', readonly job: string }
  | { readonly type: 'clone-failed', readonly failure: CloneFailure }

/** The state a flow opens in: the first screen with nothing chosen. */
export const INITIAL: FlowState = { step: 'how', method: undefined, choice: undefined, picking: undefined, problem: undefined }

/**
 * The choice a way to start opens with, prefilled with the safe values.
 * @param method - the way to start.
 * @param parent - where a new folder or clone goes unless the person changes it.
 * @returns the choice; a folder on the computer has none until one is selected.
 */
function openingChoice(method: Method, parent: string): Choice | undefined {
  switch (method) {
    case 'new-folder': return { kind: 'new', parent, name: '', git: true }
    case 'clone': return { kind: 'clone', url: '', branch: '', parent, name: '' }
    case 'folder': return undefined
    default: return assertNever(method)
  }
}

/**
 * Fail on a value a closed union has no case for.
 * @param value - the value that should be unreachable.
 * @returns never.
 */
export function assertNever(value: never): never {
  throw new Error(`unreachable flow case: ${String(value)}`)
}

/**
 * Move the flow.
 * @param state - the current state.
 * @param action - what happened.
 * @returns the next state; the same state when the action does not apply.
 */
export function reduce(state: FlowState, action: FlowAction): FlowState {
  switch (action.type) {
    case 'method': {
      const kept = state.method === action.method ? state.choice : undefined
      return { ...state, method: action.method, choice: kept ?? openingChoice(action.method, action.parent), problem: undefined }
    }
    case 'continue':
      return state.step === 'how' && state.method !== undefined ? { ...state, step: state.method, problem: undefined } : state
    case 'existing':
      return { ...state, choice: { kind: 'existing', path: action.path }, problem: undefined }
    case 'edit-new':
      return state.choice?.kind === 'new' ? { ...state, choice: { ...state.choice, ...action.change }, problem: undefined } : state
    case 'edit-clone':
      return state.choice?.kind === 'clone' ? { ...state, choice: { ...state.choice, ...action.change }, problem: undefined } : state
    case 'pick-place':
      return state.step === 'new-folder' || state.step === 'clone' ? { ...state, picking: state.step, step: 'folder', problem: undefined } : state
    case 'place-picked': {
      if (state.picking === undefined || state.choice === undefined || state.choice.kind === 'existing') return state
      return { ...state, choice: { ...state.choice, parent: action.path }, step: state.picking, picking: undefined, problem: undefined }
    }
    case 'back':
      if (state.picking !== undefined) return { ...state, step: state.picking, picking: undefined, problem: undefined }
      return state.step === 'how' ? state : { ...state, step: 'how', problem: undefined }
    case 'problem':
      return { ...state, problem: action.problem }
    case 'clone-started':
      return state.choice?.kind === 'clone' ? { ...state, choice: { ...state.choice, job: action.job } } : state
    case 'clone-failed': {
      const { choice } = state
      if (choice?.kind !== 'clone') return state
      const { job: _finished, ...rest } = choice
      return { ...state, step: 'clone', picking: undefined, choice: rest, problem: { kind: 'clone-failed', failure: action.failure } }
    }
    default:
      return assertNever(action)
  }
}

/**
 * The step's place in the whole flow, which "Step n of 5" shows.
 * @param step - the step on show.
 * @returns the 1-based number of its screen.
 */
export function stepNumber(step: Step): number {
  return SCREENS.indexOf(SCREEN_OF[step]) + 1
}

/**
 * Whether no screen follows the step, so its primary button finishes the flow.
 * @param step - the step on show.
 * @returns true while the step's screen is the last one built.
 */
export function isLastScreen(step: Step): boolean {
  return stepNumber(step) === SCREENS.length
}
