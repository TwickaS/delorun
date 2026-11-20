/**
 * The record of the chats an update stopped, kept in the profile's run folder because the update restarts the Host.
 * The new Host reads it once: it marks each chat before it sends that chat's one continue message, so a crash between
 * the mark and the send leaves the chat unsent rather than sent twice. The person's dismissal of the outcome card ends it.
 * @module @delorun/plugin-update/stopped
 */
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { RunningChatView, StoppedChatState, StoppedChatsView } from './wire.ts'

/** The one message sent to a stopped chat; the studio marks it with its own message source. */
export const CONTINUE_TEXT = 'Continue where you stopped before the update.'

/** The message source kind of the continue message. */
export const CONTINUE_SOURCE = 'delorun-update'

/** The record's file name in the profile's run folder. */
const FILE = 'update-stopped-chats.json'

/** The record on disk. */
export interface StoppedRecord {
  readonly v: 1
  /** Whether the Host continues the chats by itself (the setting when they were stopped). */
  readonly automatic: boolean
  /** When they were stopped, as an RFC 3339 UTC time. */
  readonly at: string
  readonly chats: readonly (RunningChatView & { readonly state: StoppedChatState })[]
}

/**
 * @param runFolder - the profile's run folder, the parent of the update result record.
 * @returns the record's path.
 */
export function stoppedPath(runFolder: string): string {
  return join(runFolder, FILE)
}

/**
 * @param path - the record's path.
 * @returns the record, or `undefined` when there is none or it is not this record.
 */
export async function readStopped(path: string): Promise<StoppedRecord | undefined> {
  const text = await readFile(path, 'utf8').catch(() => undefined)
  if (text === undefined) return undefined
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (error) {
    // A damaged record is no record: nothing is continued.
    void error
    return undefined
  }
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as Partial<StoppedRecord>
  if (record.v !== 1 || typeof record.automatic !== 'boolean' || typeof record.at !== 'string' || !Array.isArray(record.chats)) return undefined
  const chats = record.chats.filter(chat => typeof chat?.sessionId === 'string' && typeof chat.title === 'string' && typeof chat.state === 'string')
  return { v: 1, automatic: record.automatic, at: record.at, chats }
}

/**
 * Write the record whole, through a temporary file renamed over it.
 * @param path - the record's path.
 * @param record - the record.
 */
export async function writeStopped(path: string, record: StoppedRecord): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.${String(process.pid)}.tmp`
  await writeFile(temporary, `${JSON.stringify(record)}\n`, { mode: 0o600 })
  await rename(temporary, path)
}

/**
 * Remove the record.
 * @param path - the record's path.
 */
export async function clearStopped(path: string): Promise<void> {
  await rm(path, { force: true })
}

/**
 * @param record - the record.
 * @returns the page's view of it.
 */
export function stoppedView(record: StoppedRecord): StoppedChatsView {
  return { automatic: record.automatic, chats: record.chats }
}
