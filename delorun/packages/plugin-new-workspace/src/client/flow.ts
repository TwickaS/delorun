/**
 * The flow's state machine: which screen shows, what the person chose so far and the reason a screen shows in place.
 * Pure, so it is tested without React. The screens are one ordered list, {@link SCREENS}, so a later screen is inserted
 * there; nothing else counts screens.
 * @module @delorun/plugin-new-workspace/client/flow
 */
import type { BrowserChoice, CloneFailure, CloneProblem, CreateProblem, PlaceProblem } from '../wire.ts'
import { parseHosts, type HostsProblem } from './hosts.ts'

/** The screens built so far, in order. A screen is reached through one or more {@link Step}s. */
export const SCREENS = ['how', 'where', 'browser', 'model', 'safety'] as const

/** How many screens the flow has, which "Step n of N" shows. */
export const STEP_TOTAL: number = SCREENS.length

/** One of {@link SCREENS}. */
export type Screen = typeof SCREENS[number]

/** A step the dialog can show; `folder` doubles as the place picker while {@link FlowState.picking} is set. */
export type Step = 'how' | 'folder' | 'new-folder' | 'clone' | 'browser' | 'model' | 'safety'

/** The screen each step belongs to. */
const SCREEN_OF: Readonly<Record<Step, Screen>> = {
  'how': 'how', 'folder': 'where', 'new-folder': 'where', 'clone': 'where', 'browser': 'browser', 'model': 'model', 'safety': 'safety',
}

/** The three ways to start. */
export type Method = 'new-folder' | 'folder' | 'clone'

/** What the person chose. A clone's `job` is set once it started on the Host. */
export type Choice =
  | { readonly kind: 'existing', readonly path: string }
  | { readonly kind: 'new', readonly parent: string, readonly name: string, readonly git: boolean }
  | { readonly kind: 'clone', readonly url: string, readonly branch: string, readonly parent: string, readonly name: string, readonly job?: string }

/** The model and thinking level the person picked for the workspace's new chats; `effort` undefined is the model's own default. */
export interface ModelPick {
  /** The provider route. */
  readonly provider: string
  /** The model's id. */
  readonly model: string
  /** The thinking level's id, or undefined for the model's own default. */
  readonly effort: string | undefined
}

/** What chats in the workspace may do to its folder: change files in it, or Full access, which asks once. */
export type Permission = 'files' | 'full'

/** The network a workspace's commands get, as `@delorun/plugin-permission-defaults` names the accesses. */
export type NetworkAccess = 'open' | 'allowlist' | 'off'

/** The safety screen's choices; every field opens on the safe or default value. */
export interface SafetyChoice {
  /** Change files in the folder, or Full access. */
  readonly permission: Permission
  /** The network access for commands. */
  readonly access: NetworkAccess
  /** The hosts of an allowlist, one per line as typed; kept while another access is chosen. */
  readonly hosts: string
}

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
  /** The browser choice made on the browser screen; undefined while the choice follows whether Browser is on in the home. */
  readonly browser: BrowserChoice | undefined
  /** The model picked on the model screen; undefined while the workspace follows the home's default. */
  readonly model: ModelPick | undefined
  /** The safety screen's choices. */
  readonly safety: SafetyChoice
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
  | { readonly type: 'browser', readonly choice: BrowserChoice }
  | { readonly type: 'model', readonly pick: ModelPick }
  | { readonly type: 'safety', readonly change: Partial<SafetyChoice> }
  | { readonly type: 'back' }
  | { readonly type: 'problem', readonly problem: Problem | undefined }
  | { readonly type: 'finish-failed', readonly problem: Problem }
  | { readonly type: 'clone-started', readonly job: string }
  | { readonly type: 'clone-failed', readonly failure: CloneFailure }

/** The state a flow opens in: the first screen with nothing chosen and the safe choices made. */
export const INITIAL: FlowState = {
  step: 'how', method: undefined, choice: undefined, picking: undefined, browser: undefined, model: undefined,
  safety: { permission: 'files', access: 'open', hosts: '' }, problem: undefined,
}

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
 * The step Continue goes to.
 * @param state - the current state.
 * @returns the next step, or undefined when Continue does not apply: nothing is chosen yet, a place is being picked, a
 *   clone has not started, or the last screen is showing.
 */
function nextStep(state: FlowState): Step | undefined {
  const { step, choice } = state
  switch (step) {
    case 'how': return state.method
    case 'folder': return state.picking === undefined && choice?.kind === 'existing' ? 'browser' : undefined
    case 'new-folder': return choice?.kind === 'new' ? 'browser' : undefined
    case 'clone': return choice?.kind === 'clone' && choice.job !== undefined ? 'browser' : undefined
    case 'browser': return 'model'
    case 'model': return 'safety'
    case 'safety': return undefined
    default: return assertNever(step)
  }
}

/**
 * The step Back goes to when no place is being picked.
 * @param state - the current state.
 * @returns the previous step, or undefined on the first screen.
 */
function previousStep(state: FlowState): Step | undefined {
  switch (state.step) {
    case 'how': return undefined
    case 'folder':
    case 'new-folder':
    case 'clone': return 'how'
    case 'browser': return state.method ?? 'how'
    case 'model': return 'browser'
    case 'safety': return 'model'
    default: return assertNever(state.step)
  }
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
    case 'continue': {
      const next = nextStep(state)
      return next === undefined ? state : { ...state, step: next, problem: undefined }
    }
    case 'existing':
      return { ...state, choice: { kind: 'existing', path: action.path }, problem: undefined }
    case 'edit-new':
      return state.choice?.kind === 'new' ? { ...state, choice: { ...state.choice, ...action.change }, problem: undefined } : state
    case 'edit-clone': {
      if (state.choice?.kind !== 'clone') return state
      // A changed field is a different clone, so the one already started is no longer this choice's.
      const { job: _started, ...fields } = state.choice
      return { ...state, choice: { ...fields, ...action.change }, problem: undefined }
    }
    case 'pick-place':
      return state.step === 'new-folder' || state.step === 'clone' ? { ...state, picking: state.step, step: 'folder', problem: undefined } : state
    case 'place-picked': {
      if (state.picking === undefined || state.choice === undefined || state.choice.kind === 'existing') return state
      const choice: Choice = state.choice.kind === 'clone'
        ? { kind: 'clone', url: state.choice.url, branch: state.choice.branch, name: state.choice.name, parent: action.path }
        : { ...state.choice, parent: action.path }
      return { ...state, choice, step: state.picking, picking: undefined, problem: undefined }
    }
    case 'browser':
      return { ...state, browser: action.choice }
    case 'model':
      return { ...state, model: action.pick }
    case 'safety':
      return { ...state, safety: { ...state.safety, ...action.change } }
    case 'back': {
      if (state.picking !== undefined) return { ...state, step: state.picking, picking: undefined, problem: undefined }
      const previous = previousStep(state)
      return previous === undefined ? state : { ...state, step: previous, problem: undefined }
    }
    case 'problem':
      return { ...state, problem: action.problem }
    case 'finish-failed': {
      // A refusal of what the place screen chose belongs on that screen; a lock or an outage shows where the person pressed.
      const refusal = action.problem.kind === 'place' || action.problem.kind === 'create' || action.problem.kind === 'clone'
      const afterPlace = stepNumber(state.step) > SCREENS.indexOf('where') + 1
      const step = refusal && afterPlace && state.method !== undefined ? state.method : state.step
      return { ...state, step, picking: undefined, problem: action.problem }
    }
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
 * The step's place in the whole flow, which "Step n of N" shows.
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

/**
 * Whether Create now shows: once the place is chosen, from the first screen after it onward.
 * @param state - the flow's state.
 * @returns true when a place is chosen, none is being picked, the step is after the place screen and the safety choices are valid.
 */
export function canCreateNow(state: FlowState): boolean {
  return state.choice !== undefined && state.picking === undefined
    && stepNumber(state.step) > SCREENS.indexOf('where') + 1 && safetyProblem(state.safety) === undefined
}

/**
 * Why the safety choices cannot be used.
 * @param safety - the choices.
 * @returns the allowlist's problem, or undefined while the choices are usable (only `allowlist` reads the hosts).
 */
export function safetyProblem(safety: SafetyChoice): HostsProblem | undefined {
  if (safety.access !== 'allowlist') return undefined
  const parsed = parseHosts(safety.hosts)
  return 'problem' in parsed ? parsed.problem : undefined
}
