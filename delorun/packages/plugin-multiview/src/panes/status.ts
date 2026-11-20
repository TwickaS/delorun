/**
 * What a pane header says about its chat: the status badge's state and times, the agent's name and monogram, and the chips of
 * its plan limits. Pure functions, so every state is checked without mounting a chat.
 * @module @delorun/plugin-multiview/panes/status
 */

/** What a pane's chat is doing, as the badge names it. */
export type PaneStatus = 'working' | 'needs-approval' | 'done' | 'idle'

/** What the badge is computed from. */
export interface StatusInput {
  /** The chat runs a turn now. */
  readonly running: boolean
  /** The chat waits for the person: an approval or a question. */
  readonly waiting: boolean
  /** The pane is the main chat, whose resting state is not Done. */
  readonly isMain: boolean
}

/**
 * Name the state of a chat.
 * @param input - the chat's running and waiting state.
 * @returns `needs-approval` while it waits, `working` while it runs, otherwise `idle` for the main chat and `done` for an agent.
 */
export function paneStatus(input: StatusInput): PaneStatus {
  if (input.waiting) return 'needs-approval'
  if (input.running) return 'working'
  return input.isMain ? 'idle' : 'done'
}

/**
 * Format a duration for the badge: `48s`, `4m 02s`, `1h 05m`.
 * @param ms - the duration in milliseconds; a negative value reads as zero.
 * @returns the text.
 */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = total % 60
  const two = (value: number): string => String(value).padStart(2, '0')
  if (hours > 0) return `${String(hours)}h ${two(minutes)}m`
  if (minutes > 0) return `${String(minutes)}m ${two(seconds)}s`
  return `${String(seconds)}s`
}

/** The run clock of one pane: when the current run began, or how long the last one took. */
export interface RunClock {
  /** The status the clock last saw. */
  readonly status: PaneStatus
  /** Epoch milliseconds the current run began; undefined while not working. */
  readonly startedAt: number | undefined
  /** How long the last run took, once it ended. */
  readonly lastDuration: number | undefined
}

/**
 * Advance a pane's run clock for a newly observed status.
 * @param clock - the clock so far.
 * @param status - the status now.
 * @param now - the time now, epoch milliseconds.
 * @param runStart - when the chat says its run began, when it knows; a pane opened mid-run starts there instead of at `now`.
 * @returns the same clock when nothing changed, otherwise the next one.
 */
export function advanceClock(clock: RunClock, status: PaneStatus, now: number, runStart?: number): RunClock {
  const working = status === 'working' || status === 'needs-approval'
  const wasWorking = clock.startedAt !== undefined
  if (working && !wasWorking) return { status, startedAt: runStart ?? now, lastDuration: clock.lastDuration }
  if (!working && wasWorking) return { status, startedAt: undefined, lastDuration: now - clock.startedAt! }
  return status === clock.status ? clock : { ...clock, status }
}

/** The clock before anything was observed. */
export const FRESH_CLOCK: RunClock = { status: 'idle', startedAt: undefined, lastDuration: undefined }

/**
 * Two letters for a name with no program monogram: the first two letters of its first word, so two chats whose names share their
 * later words (such as "Run the tests" and "Review the diff") still read differently. Every surface that draws a monogram uses this.
 * @param name - the chat's or agent's name.
 * @returns up to two upper-case characters; `?` for an empty name.
 */
export function initialsOf(name: string): string {
  const first = name.trim().split(/\s+/)[0] ?? ''
  return first === '' ? '?' : [...first].slice(0, 2).join('').toUpperCase()
}

/** The fields of the `agentSeat` projection the limits line reads; every one is optional, so an older or absent value shows less. */
export interface SeatLimits {
  /** The program: `claude-code` or `codex`. */
  readonly agent?: string
  /** The program's version. */
  readonly version?: string
  /** The plan's name. */
  readonly plan?: string
  /** Percent of the 5-hour allowance used. */
  readonly fiveHourPercent?: number
  /** When the 5-hour window resets, epoch milliseconds. */
  readonly fiveHourResetAt?: number
  /** Percent of the weekly allowance used. */
  readonly weeklyPercent?: number
}

/** The program names and monograms the line knows; another program's chat shows its own name from the catalog. */
export const SEAT_AGENTS: Readonly<Record<string, { readonly name: string; readonly monogram: string }>> = {
  'claude-code': { name: 'Claude Code', monogram: 'CC' },
  codex: { name: 'Codex', monogram: 'CX' },
}

/** One chip of the limits line. */
export interface LimitChip {
  /** The dictionary key. */
  readonly key: 'limits.version' | 'limits.plan' | 'limits.fiveHour' | 'limits.fiveHourReset' | 'limits.weekly'
  /** The values the key's text takes. */
  readonly values: Readonly<Record<string, string>>
}

/**
 * The chips of an agent's limits line, in reading order, for the fields the agent has reported.
 * @param seat - the `agentSeat` projection value, or null and undefined for a chat that is not a live agent's.
 * @param clock - formats an epoch-millisecond time of day.
 * @returns the chips; empty for a plain subagent or the main chat, which have no limits line.
 */
export function limitChips(seat: SeatLimits | null | undefined, clock: (epochMs: number) => string): readonly LimitChip[] {
  if (seat === null || seat === undefined) return []
  const chips: LimitChip[] = []
  const known = seat.agent === undefined ? undefined : SEAT_AGENTS[seat.agent]
  if (known !== undefined && seat.version !== undefined) chips.push({ key: 'limits.version', values: { agent: known.name, version: seat.version } })
  if (seat.plan !== undefined) chips.push({ key: 'limits.plan', values: { plan: seat.plan } })
  if (seat.fiveHourPercent !== undefined) {
    const percent = String(Math.round(seat.fiveHourPercent))
    chips.push(seat.fiveHourResetAt === undefined
      ? { key: 'limits.fiveHour', values: { percent } }
      : { key: 'limits.fiveHourReset', values: { percent, time: clock(seat.fiveHourResetAt) } })
  }
  if (seat.weeklyPercent !== undefined) chips.push({ key: 'limits.weekly', values: { percent: String(Math.round(seat.weeklyPercent)) } })
  return chips
}
