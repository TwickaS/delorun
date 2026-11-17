/**
 * The fixed sentences and codes of a seat turn that cannot run or ends in failure. The model and the log see only
 * these; the program's own words (`ProgramFailure.detail`) go to the person's view through the adapter's events.
 * @module @delorun/plugin-agent-seats/adapter/failure
 */
import type { GateRefusal, ProgramFailure } from '@delorun/external-agents/contract'

/** The code of a request that is not a seat child's own turn. */
export const SEAT_ROUTE_REFUSED = 'EXTERNAL_AGENT_ROUTE_ONLY'

/** The fixed sentence of that refusal. */
export const SEAT_ROUTE_REFUSED_MESSAGE = 'This route serves only an external agent\'s own chat.'

/** A fixed message and its stable code. */
export interface FixedFailure {
  /** The sentence. */
  readonly message: string
  /** The stable machine-routing code. */
  readonly code: string
}

/**
 * The sentence for a reset time.
 * @param resetsAt - milliseconds since the epoch, when known.
 * @returns the sentence tail, with the time in UTC, or an empty string.
 */
function resetSentence(resetsAt: number | undefined): string {
  return resetsAt === undefined ? '' : ` It resets at ${new Date(resetsAt).toISOString()}.`
}

/**
 * Word a program failure.
 * @param failure - why the open or the turn failed.
 * @returns the fixed message and code.
 */
export function programFailure(failure: ProgramFailure): FixedFailure {
  switch (failure.category) {
    case 'signed-out':
      return { message: 'The agent is not signed in.', code: 'EXTERNAL_AGENT_SIGNED_OUT' }
    case 'limit':
      return { message: `The agent's plan limit is reached.${resetSentence(failure.resetsAt)}`, code: 'EXTERNAL_AGENT_LIMIT' }
    case 'model-not-offered':
      return { message: 'The agent\'s model is not offered on this plan. Pick another model.', code: 'EXTERNAL_AGENT_MODEL_NOT_OFFERED' }
    case 'resume-failed':
      return { message: 'The agent\'s own session could not be resumed.', code: 'EXTERNAL_AGENT_RESUME_FAILED' }
    case 'time-limit':
      return { message: `The agent\'s turn was stopped at its time limit of ${Math.round(failure.limitMs / 60_000)} minutes.`, code: 'EXTERNAL_AGENT_TIME_LIMIT' }
    case 'program':
      return { message: 'The agent\'s turn failed.', code: 'EXTERNAL_AGENT_FAILED' }
    default:
      return unhandled(failure)
  }
}

/**
 * Word a refusal of the start gate.
 * @param refusal - why the gate refused.
 * @returns the fixed message and code.
 */
export function gateRefusal(refusal: GateRefusal): FixedFailure {
  switch (refusal.category) {
    case 'not-installed':
      return { message: 'The agent is not added to this Delorun.', code: 'EXTERNAL_AGENT_NOT_INSTALLED' }
    case 'consent':
      return { message: refusal.reason, code: 'EXTERNAL_AGENT_CONSENT' }
    case 'limit':
      return { message: `The agent's plan limit is reached.${resetSentence(refusal.resetsAt)}`, code: 'EXTERNAL_AGENT_LIMIT' }
    case 'capacity':
      return { message: 'Too many agents are running. Wait for one to finish.', code: 'EXTERNAL_AGENT_CAPACITY' }
    case 'seat-running':
      return { message: 'The agent is already running for this chat.', code: 'EXTERNAL_AGENT_RUNNING' }
    default:
      return unhandled(refusal)
  }
}

/** The sentence and code of a history the harness changed after the program saw it. */
export const HISTORY_PARTED: FixedFailure = {
  message: 'The agent\'s chat history changed after it was handed to the program, so nothing was sent.',
  code: 'EXTERNAL_AGENT_HISTORY_PARTED',
}

/** The sentence and code of a first task whose result-delivery guidance could not be taken off. */
export const TASK_UNSEPARABLE: FixedFailure = {
  message: 'The first task could not be separated from the runtime\'s guidance, so nothing was sent.',
  code: 'EXTERNAL_AGENT_TASK_UNSEPARABLE',
}

/** The sentence and code of a program session that stopped accepting input. */
export const PROGRAM_CLOSED: FixedFailure = {
  message: 'The agent\'s program has ended. Send the message again to start it.',
  code: 'EXTERNAL_AGENT_PROGRAM_CLOSED',
}

/** The sentence and code of a seat whose folder is unknown. */
export const SEAT_FOLDER_UNKNOWN: FixedFailure = {
  message: 'The agent\'s folder is unknown, so it was not started.',
  code: 'EXTERNAL_AGENT_FOLDER_UNKNOWN',
}

/**
 * Close a switch over a closed union.
 * @param value - the value no case matched.
 * @returns never.
 * @throws always, naming the value.
 */
function unhandled(value: never): never {
  throw new Error(`unhandled external agent failure: ${JSON.stringify(value)}`)
}
