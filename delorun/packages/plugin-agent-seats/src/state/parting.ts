/**
 * Parting detection on resume (design 4): the program kept its own conversation, and the harness log is the record. They
 * part when the program did work the log lacks, or when the program's conversation cannot be resumed at all.
 * @module @delorun/plugin-agent-seats/state/parting
 */
import type { ProgramExit } from '@delorun/external-agents/contract'
import type { SeatAgent } from './view.ts'
import type { SeatNoticeKind } from './record.ts'

/** What a driver can report about a program session without running a turn. */
export interface ProgramTail {
  /** Id of the program's newest message in the session; absent when it has none. */
  readonly lastMessageId?: string
}

/**
 * Read a program session's tail from the program's own store.
 * @param agent - the agent.
 * @param programSessionId - the program's session or thread id.
 * @returns the tail.
 */
export type ProgramTailReader = (agent: SeatAgent, programSessionId: string) => Promise<ProgramTail>

/** A notice for the chat. */
export interface PartingNotice {
  /** What happened. */
  readonly kind: SeatNoticeKind
  /** The sentence the chat shows. */
  readonly text: string
}

/**
 * The sentence for a program that cannot resume its earlier conversation (case 3). Delorun says this in the chat and
 * adds nothing to the program (EA32).
 * @param name - the agent's display name.
 * @returns the sentence.
 */
export function unresumableNotice(name: string): PartingNotice {
  return {
    kind: 'unresumable',
    text: `${name}'s earlier conversation could not be resumed. Your next message starts a new one, with that message alone.`,
  }
}

/**
 * The sentence for a program that failed, with the fixed facts only: where it failed and how its process ended. The
 * program's own words are never part of it, because they can quote paths, settings or account details.
 * @param name - the agent's display name.
 * @param stage - whether the failure came while the program started or during a turn.
 * @param exit - how the program's process ended, when known.
 * @returns the notice.
 */
export function programFailedNotice(name: string, stage: 'start' | 'turn', exit: ProgramExit | undefined): PartingNotice {
  const where = stage === 'start' ? 'while starting' : 'during its turn'
  const ended = exit?.signal !== undefined ? `its process ended with signal ${exit.signal}` : exit?.code === undefined ? undefined : `its process exited with code ${String(exit.code)}`
  return { kind: 'program-failed', text: `${name} failed ${where}${ended === undefined ? '' : `; ${ended}`}.` }
}

/**
 * Compare what the harness logged with what the program holds (cases 1 and 4: work the program did that the log
 * lacks, a crash after the program answered or another place continuing the same program session). Case 2, a message
 * the harness logged and the program never received, is sent again from the cursor and needs no notice.
 * @param stored - the program's last message id when its last turn ended; undefined when it was not recorded (a first
 *   turn that never ended, or a stopped turn), in which case nothing is compared.
 * @param tail - the program's tail now.
 * @param name - the agent's display name.
 * @returns the notice, or undefined when the two agree.
 */
export function partingNotice(stored: string | undefined, tail: ProgramTail, name: string): PartingNotice | undefined {
  if (stored === undefined || tail.lastMessageId === undefined || tail.lastMessageId === stored) return undefined
  return {
    kind: 'unrecorded-work',
    text: `${name} did work after this chat's last recorded step that Delorun did not record here. It carries on from where ${name} is now.`,
  }
}
