/**
 * The replica's data and its timeline. A session is a fixture (recorded session events for the chat, typed data for the
 * Changes and Setup versions sections, and the moment the recording was made) and a chapter file (chapters, captions and
 * the steps that play each one). {@link stateAt} folds a chapter's steps into what the drawn studio shows at a moment, so
 * the player, the reduced-motion stills and the tests read one definition of every chapter.
 * @module @delorun/website/replica/model
 */
import type { ChangesStateView } from '../../../../packages/plugin-changes/src/wire.ts'
import type { VersionChanges, VersionsAnswer } from '../../../../packages/bundle-local/src/client/versions-api.ts'
import type { en as versionsEn } from '../../../../packages/bundle-local/src/client/versions-locales.ts'
import type { en as changesEn } from '../../../../packages/plugin-changes/src/client/locales.ts'
import type { en as approvalEn } from '#studio/ui-approval/src/client/locales.ts'

/** One text part of a message, as the session log keeps it. */
export interface TextPart {
  readonly type: 'text'
  readonly text: string
}

/**
 * One row of a recorded session, in the wire form a committed fixture keeps (without `seq` and `time`). Only the event
 * types the replica draws are listed; the parity test renders the same rows through the product's own transcript.
 */
export type ReplicaEvent =
  | { readonly type: 'turn/start', readonly data: { readonly turn: number } }
  | { readonly type: 'turn/end', readonly data: { readonly turn: number, readonly reason: { readonly kind: 'completed' } } }
  | { readonly type: 'step/start' | 'step/end', readonly data: { readonly turn: number, readonly step: number } }
  | { readonly type: 'user/message', readonly data: { readonly id: string, readonly role: 'user', readonly content: readonly TextPart[], readonly source: { readonly kind: 'user' } } }
  | { readonly type: 'assistant/message', readonly data: { readonly turn: number, readonly step: number, readonly message: { readonly id: string, readonly role: 'assistant', readonly content: readonly TextPart[] } } }
  | { readonly type: 'tool/call', readonly data: { readonly turn: number, readonly step: number, readonly callId: string, readonly name: 'bash', readonly arguments: string } }
  // `escalatesTo` is the request's presentation field (`ApprovalEscalation`), not logged: the sandbox mode the card's
  // "Allow for this chat" switches the chat to.
  | { readonly type: 'approval/asked', readonly data: { readonly id: string, readonly toolName: string, readonly callId: string, readonly reason: string, readonly escalatesTo: 'workspace-write' | 'danger-full-access' } }
  | { readonly type: 'approval/decided', readonly data: { readonly id: string, readonly outcome: 'allowed-once' | 'rejected' } }
  | { readonly type: 'tool/result', readonly data: { readonly turn: number, readonly step: number, readonly message: { readonly id: string, readonly role: 'tool', readonly toolCallId: string, readonly content: readonly TextPart[], readonly isError: boolean } } }

/** The sessions the page replays. */
export const SESSION_IDS = ['ordinary-work', 'changes-and-versions'] as const

/** One replayed session. */
export type SessionId = typeof SESSION_IDS[number]

/** Everything one replayed session draws. */
export interface ReplicaFixture {
  readonly id: SessionId
  /** True for a hand-made stand-in; a fixture made from a real run sets false. */
  readonly standIn: boolean
  /** The release the fixture was made on. */
  readonly release: string
  /** The moment the recording was made, as an ISO time; every time in the fixture is read against it (see {@link shiftClock}). */
  readonly clock: string
  readonly events: readonly ReplicaEvent[]
  /** The Changes section's states, by the name a chapter step uses. */
  readonly changes: Readonly<Record<string, ChangesStateView>>
  /** The Setup versions lists, by the name a chapter step uses. */
  readonly versions: Readonly<Record<string, VersionsAnswer>>
  /** What switching to a listed version changes. */
  readonly versionChanges?: VersionChanges | undefined
  /**
   * What the terminal window shows: the command and the lines it printed, made by the product (see
   * `tests/product/replica-terminal.spec.ts`). Only a session with a terminal chapter has one.
   */
  readonly terminal?: { readonly command: string, readonly output: readonly string[] } | undefined
}

/** The screens of the drawn studio's navigation. */
export type StudioScreen = 'chat' | 'changes' | 'versions'

/**
 * What the frame shows. `terminal` is a terminal window drawn in place of the studio, with no sidebar: the studio has no
 * terminal page.
 */
export type Screen = StudioScreen | 'terminal'

/**
 * A group of the real Changes section, by the key of its heading in the section's dictionary. A chapter shows only the
 * groups it is about; the rest are hidden.
 */
export type ChangesGroup = 'recent.heading' | 'pending.heading' | 'requests.heading' | 'self.heading' | 'protection.heading' | 'leftOut.heading' | 'work.heading'

/** The dictionaries of the real sections, by the name a press names them with. */
export interface SectionDictionaries {
  readonly changes: typeof changesEn
  readonly versions: typeof versionsEn
  readonly approval: typeof approvalEn
}

/**
 * A control the script presses: the button whose text is the product's text for `key` in `dictionary`, inside the
 * element that matches `within` (the whole studio when absent).
 */
export type PressTarget = { readonly [D in keyof SectionDictionaries]: {
  readonly dictionary: D
  readonly key: keyof SectionDictionaries[D] & string
  /** A selector for the region that holds the button, such as `[data-change-id="chg-2"]` or `[role="dialog"]`. */
  readonly within?: string | undefined
} }[keyof SectionDictionaries]

/**
 * One step of a chapter. Every step takes `hold` milliseconds of the chapter's time before the next one starts, except
 * `type` and `command`, which take `perChar` milliseconds for each character and then `hold`. `command` types its text
 * into the terminal window; the fixture's terminal output appears once the last character is typed.
 */
export type Step =
  | { readonly kind: 'screen', readonly screen: Screen, readonly hold: number }
  | { readonly kind: 'type', readonly text: string, readonly perChar: number, readonly hold: number }
  | { readonly kind: 'send', readonly hold: number }
  | { readonly kind: 'show', readonly through: number, readonly hold: number }
  | { readonly kind: 'press', readonly target: PressTarget, readonly hold: number }
  | { readonly kind: 'changes', readonly state: string, readonly groups: readonly ChangesGroup[], readonly hold: number }
  | { readonly kind: 'versions', readonly state: string, readonly hold: number }
  | { readonly kind: 'command', readonly command: string, readonly perChar: number, readonly hold: number }
  | { readonly kind: 'wait', readonly hold: number }

/** One chapter: a tab on the rail, the caption that is its text alternative, and its steps. */
export interface Chapter {
  readonly id: string
  /** The rail's label. */
  readonly title: string
  /** One or two sentences that say what the chapter shows; announced when the chapter starts. */
  readonly caption: string
  readonly steps: readonly Step[]
}

/** A session's chapters. */
export interface ChapterFile {
  readonly session: SessionId
  /** The workspace the sidebar names. */
  readonly workspace: string
  /** The chat's title, and the titles of the older chats the sidebar lists under it. */
  readonly chats: readonly string[]
  /** The first state the studio shows, before the first chapter's steps; the still the frame shows until the replay plays. */
  readonly start: Pick<StudioState, 'shown' | 'changes' | 'groups' | 'versions'> & { readonly screen: StudioScreen }
  /**
   * The chapter a replay that does not play shows first: under reduced motion, and with scripts off, where the still
   * draws its last state. That state shows the same screen as {@link start}.
   */
  readonly resting: number
  readonly chapters: readonly Chapter[]
}

/** What the drawn studio shows at one moment. */
export interface StudioState {
  readonly screen: Screen
  /** How many of the session's events the chat shows. */
  readonly shown: number
  /** The text in the composer. */
  readonly draft: string
  /** Whether the composer is being typed in. */
  readonly typing: boolean
  /** The Changes state's name. */
  readonly changes: string
  readonly groups: readonly ChangesGroup[]
  /** The Setup versions list's name. */
  readonly versions: string
  /** The terminal window: the command typed so far, and whether it has been typed in full so its output shows. */
  readonly terminal: { readonly typed: string, readonly ran: boolean }
}

/** A press the timeline reached: which step and what it presses. */
export interface Press {
  /** The step's index in its chapter. */
  readonly step: number
  readonly target: PressTarget
}

/**
 * The next moment after `at` at which a chapter's state changes: a step's start, or the next character of a `type` or
 * `command` step.
 * @param chapter - the chapter.
 * @param at - milliseconds since the chapter started.
 * @returns the moment, or undefined when nothing changes after `at` (the chapter's end is then {@link chapterLength}).
 */
export function nextChange(chapter: Chapter, at: number): number | undefined {
  let start = 0
  for (const step of chapter.steps) {
    if (start > at) return start
    if (step.kind === 'type' || step.kind === 'command') {
      const typedBy = start + typedLength(step) * step.perChar
      if (at < typedBy) return start + (Math.floor((at - start) / step.perChar) + 1) * step.perChar
    }
    start += stepLength(step)
  }
  return undefined
}

/**
 * The time a step takes.
 * @param step - the step.
 * @returns its length in milliseconds.
 */
export function stepLength(step: Step): number {
  return step.kind === 'type' || step.kind === 'command' ? typedLength(step) * step.perChar + step.hold : step.hold
}

/**
 * The number of characters a typing step types.
 * @param step - a `type` or `command` step.
 * @returns its character count.
 */
function typedLength(step: Extract<Step, { readonly kind: 'type' | 'command' }>): number {
  return step.kind === 'type' ? step.text.length : step.command.length
}

/**
 * The time a chapter takes.
 * @param chapter - the chapter.
 * @returns the sum of its steps' lengths in milliseconds.
 */
export function chapterLength(chapter: Chapter): number {
  return chapter.steps.reduce((total, step) => total + stepLength(step), 0)
}

/**
 * A state after one step, or part of a `type` step.
 * @param state - the state before the step.
 * @param step - the step.
 * @param into - for a `type` or `command` step, the milliseconds since it started; any other step applies in full.
 * @returns the state after it.
 */
function apply(state: StudioState, step: Step, into = Number.POSITIVE_INFINITY): StudioState {
  switch (step.kind) {
    case 'screen': return { ...state, screen: step.screen }
    case 'type': {
      const typed = Math.min(step.text.length, Math.floor(into / step.perChar))
      return { ...state, draft: step.text.slice(0, typed), typing: typed < step.text.length }
    }
    case 'command': {
      const typed = Math.min(step.command.length, Math.floor(into / step.perChar))
      return { ...state, terminal: { typed: step.command.slice(0, typed), ran: typed === step.command.length } }
    }
    case 'send': return { ...state, draft: '', typing: false }
    case 'show': return { ...state, shown: step.through + 1 }
    case 'changes': return { ...state, changes: step.state, groups: step.groups }
    case 'versions': return { ...state, versions: step.state }
    case 'press':
    case 'wait': return state
  }
}

/**
 * The state a chapter starts from: the file's first state with every earlier chapter's steps applied.
 * @param file - the session's chapters.
 * @param chapter - the chapter's index.
 * @returns the state.
 */
export function chapterStart(file: ChapterFile, chapter: number): StudioState {
  let state: StudioState = { ...file.start, draft: '', typing: false, terminal: { typed: '', ran: false } }
  for (const earlier of file.chapters.slice(0, chapter)) for (const step of earlier.steps) state = apply(state, step)
  return state
}

/**
 * What the studio shows a number of milliseconds into a chapter, and the presses the chapter has reached by then.
 * @param file - the session's chapters.
 * @param chapter - the chapter's index.
 * @param at - milliseconds since the chapter started; `Infinity` gives the chapter's last state.
 * @returns the state and the presses reached, in order.
 */
export function stateAt(file: ChapterFile, chapter: number, at: number): { readonly state: StudioState, readonly presses: readonly Press[] } {
  let state = chapterStart(file, chapter)
  const presses: Press[] = []
  let start = 0
  const steps = file.chapters[chapter]?.steps ?? []
  for (const [index, step] of steps.entries()) {
    if (at < start) break
    state = apply(state, step, at - start)
    if (step.kind === 'press') presses.push({ step: index, target: step.target })
    start += stepLength(step)
  }
  return { state, presses }
}

/** An ISO time as fixtures write it. */
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?Z$/

/**
 * A fixture's data with its times placed for the visit. The ISO time strings, which the Changes section reads as
 * relative times, move by the same amount, so "8 min ago" stays "8 min ago". The numbers under a key named `at`, which
 * Setup versions writes as a date and time in the visitor's time zone, keep the recording's own UTC date and time
 * instead, so every visitor, in any zone and on any day, reads the same "17 Nov 2026, 10:50".
 * @param value - the data.
 * @param by - the milliseconds to move the relative times by.
 * @returns a copy with the times placed.
 */
export function shiftClock<T>(value: T, by: number): T {
  const walk = (item: unknown, key?: string): unknown => {
    if (typeof item === 'string') return ISO_TIME.test(item) ? new Date(Date.parse(item) + by).toISOString() : item
    // `getTimezoneOffset` is UTC minus local time, so adding it makes the local reading equal the UTC one.
    if (typeof item === 'number') return key === 'at' ? item + new Date(item).getTimezoneOffset() * 60_000 : item
    if (Array.isArray(item)) return item.map(entry => walk(entry))
    if (item !== null && typeof item === 'object') return Object.fromEntries(Object.entries(item).map(([name, entry]) => [name, walk(entry, name)]))
    return item
  }
  return walk(value) as T
}
