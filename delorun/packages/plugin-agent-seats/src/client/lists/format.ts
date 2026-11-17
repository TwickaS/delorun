/**
 * Pure helpers of the agents list (look C), the hand-off line (look B) and the team view (look A): monogram, ring,
 * state words and the hand-off tool's JSON.
 * @module
 */
import { AGENT_NAMES, type AgentSeatView, type SeatAgent } from '../view.ts'

/** Colours of a monogram; the named badge colours live in `delorun/packages/brand/src/badge-colors.css`. */
export type MonogramColour = 'violet' | 'teal' | 'blue'

/** What a row's monogram shows. */
export interface MonogramSpec {
  /** One or two letters. */
  readonly letters: string
  /** The brand badge colour. */
  readonly colour: MonogramColour
  /** Whether the arrow-out mark is drawn: the agent runs outside Delorun. */
  readonly outside: boolean
}

/**
 * The monogram of a row.
 * @param seat - the row's live agent, when it is one.
 * @param label - the row's primary label.
 * @returns the monogram.
 */
export function monogramOf(seat: AgentSeatView | undefined, label: string): MonogramSpec {
  if (seat !== undefined) {
    return { letters: seat.agent === 'claude-code' ? 'CC' : 'CX', colour: seat.agent === 'claude-code' ? 'violet' : 'teal', outside: true }
  }
  const letter = [...label.trim()][0]
  return { letters: letter === undefined ? '·' : letter.toLocaleUpperCase(), colour: 'blue', outside: false }
}

/** The ring around a seat's 5-hour allowance. */
export interface RingSpec {
  /** Percent used, clamped to 0–100. */
  readonly percent: number
  /** Reached: the program can go on only after the reset. */
  readonly reached: boolean
  /** Near: at least 80 percent used. */
  readonly near: boolean
}

/**
 * The ring of a seat row.
 * @param seat - the live agent.
 * @returns the ring, or undefined when the program reported no 5-hour figure and has not hit its limit.
 */
export function ringOf(seat: AgentSeatView): RingSpec | undefined {
  const reached = seat.state === 'limit'
  if (seat.fiveHourPercent === undefined && !reached) return undefined
  const percent = reached ? 100 : Math.min(100, Math.max(0, Math.round(seat.fiveHourPercent ?? 0)))
  return { percent, reached, near: percent >= 80 }
}

/** The state words of a seat row, as dictionary keys with their values. */
export type SeatWords =
  | { readonly key: 'row.waiting' }
  | { readonly key: 'row.limit'; readonly time: string | undefined }
  | { readonly key: 'row.starting' | 'row.working' | 'row.idle' | 'row.notSignedIn' | 'row.modelNeeded' | 'row.ended' }

/**
 * The word for a seat's state; "waiting for you" outranks every other state.
 * @param seat - the live agent.
 * @param waiting - whether a question of the agent waits for an answer.
 * @param clock - formats an epoch time as a clock time.
 * @returns the key to translate.
 */
export function wordsOf(seat: AgentSeatView, waiting: boolean, clock: (epochMs: number) => string): SeatWords {
  if (waiting) return { key: 'row.waiting' }
  switch (seat.state) {
    case 'limit': return { key: 'row.limit', time: seat.resetAt === undefined ? undefined : clock(seat.resetAt) }
    case 'starting': return { key: 'row.starting' }
    case 'working': return { key: 'row.working' }
    case 'idle': return { key: 'row.idle' }
    case 'not-signed-in': return { key: 'row.notSignedIn' }
    case 'model-needed': return { key: 'row.modelNeeded' }
    case 'ended': return { key: 'row.ended' }
    default: return assertNever(seat.state)
  }
}

function assertNever(value: never): never {
  throw new Error(`unhandled seat state: ${String(value)}`)
}

/**
 * How many direct rows run outside Delorun.
 * @param seats - each row's live agent, undefined for an ordinary subagent.
 * @returns the count.
 */
export function outsideCount(seats: readonly (AgentSeatView | undefined)[]): number {
  return seats.filter(seat => seat !== undefined).length
}

/** The program name of a seat. */
export function programOf(agent: SeatAgent): string {
  return AGENT_NAMES[agent]
}

/** What the hand-off line shows of the tool's input. */
export interface HandOffInput {
  /** The short title (the tool's `description`). */
  readonly task: string
}

/** What the hand-off line shows of the tool's result. */
export interface HandOffResult {
  /** The agent's catalog name (the activation result's `name`). */
  readonly name: string | undefined
  /** The chat started without asking: the activation result carries a reason (EA33, Full access). */
  readonly withoutAsking: boolean
}

function asRecord(text: string): Readonly<Record<string, unknown>> | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    // Partial arguments while the model is still writing them, or a result that is plain text: neither is an object.
    void error
    return undefined
  }
  return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined
}

/**
 * Read the hand-off tool's arguments.
 * @param argsRaw - the call's raw JSON arguments, possibly partial.
 * @returns the title, empty while it cannot be read.
 */
export function parseHandOffInput(argsRaw: string): HandOffInput {
  const task = asRecord(argsRaw)?.['description']
  return { task: typeof task === 'string' ? task.trim() : '' }
}

/**
 * Read the hand-off tool's activation result (tool JSON: every field is checked).
 * @param meta - the result block's structured metadata.
 * @returns the fields; absent ones stay undefined or false.
 */
export function parseHandOffResult(meta: unknown): HandOffResult {
  const record = typeof meta === 'object' && meta !== null && !Array.isArray(meta) ? meta as Record<string, unknown> : undefined
  const name = record?.['name']
  const reason = record?.['reason']
  return {
    name: typeof name === 'string' && name !== '' ? name : undefined,
    withoutAsking: typeof reason === 'string' && reason !== '',
  }
}

/**
 * A short clock-free duration for the line: "2m 14s".
 * @param ms - milliseconds.
 * @returns the text.
 */
export function shortDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = total % 60
  if (hours > 0) return `${String(hours)}h ${String(minutes)}m`
  if (minutes > 0) return `${String(minutes)}m ${String(seconds)}s`
  return `${String(seconds)}s`
}
