/**
 * Owner notes: a section at the end of a workspace's `AGENTS.md` that the
 * main chat adds to, revises and removes one dated note at a time, at the
 * person's request. Every chat in the workspace reads it with the rest of
 * the file. The text before and after the section is left as it is.
 *
 * The section runs from {@link OWNER_NOTES_START} to {@link OWNER_NOTES_END};
 * each note starts with a `<!-- delo:note <id> <date> -->` line and runs to
 * the next note or the end marker.
 *
 * @module @delo/plugin-main-chat/owner-notes
 */

/** The line that opens the section. */
export const OWNER_NOTES_START = '<!-- delo:owner-notes -->'

/** The line that closes the section. */
export const OWNER_NOTES_END = '<!-- delo:owner-notes-end -->'

const HEADING = '## Owner notes\n\nNotes the person added through the main chat. Each applies to every chat in this workspace.'

const NOTE_LINE = /^<!-- delo:note (n-[0-9a-z]{8}) (\d{4}-\d{2}-\d{2}) -->$/

// Every marker starts with this, so a note may not hold it.
const MARKER = '<!-- delo:'

/** One owner note. */
export interface OwnerNote {
  /** `n-` and eight lower-case base-36 characters. */
  readonly id: string
  /** The UTC day it was added or last revised, `YYYY-MM-DD`. */
  readonly date: string
  /** The note, without leading or trailing blank lines. */
  readonly text: string
}

/** A file split around its owner notes. */
export interface NotedFile {
  /** The text before the section. */
  readonly before: string
  /** The notes, oldest first. */
  readonly notes: readonly OwnerNote[]
  /** The text after the section's end marker. */
  readonly after: string
}

/** Why a file's section cannot be read. */
export class OwnerNotesError extends Error {
  /** @param message - what is wrong with the section, for the agent. */
  constructor(message: string) {
    super(message)
    this.name = 'OwnerNotesError'
  }
}

/**
 * Split a file around its owner notes.
 * @param text - the file, or null while it does not exist.
 * @returns the parts.
 * @throws {OwnerNotesError} when the section's markers are damaged.
 */
export function parseOwnerNotes(text: string | null): NotedFile {
  const source = (text ?? '').replace(/\r\n/g, '\n')
  const start = source.indexOf(OWNER_NOTES_START)
  if (start === -1) {
    if (source.includes(OWNER_NOTES_END)) throw new OwnerNotesError(`the owner notes section has its end marker but not its start marker, ${OWNER_NOTES_START}`)
    return { before: source, notes: [], after: '' }
  }
  const end = source.indexOf(OWNER_NOTES_END, start)
  if (end === -1) throw new OwnerNotesError(`the owner notes section has no end marker, ${OWNER_NOTES_END}`)
  if (source.indexOf(OWNER_NOTES_START, start + 1) !== -1) throw new OwnerNotesError('the file has two owner notes sections')
  const notes: OwnerNote[] = []
  let open: { id: string, date: string, lines: string[] } | undefined
  const close = (): void => {
    if (open !== undefined) notes.push({ id: open.id, date: open.date, text: open.lines.join('\n').trim() })
  }
  for (const line of source.slice(start + OWNER_NOTES_START.length, end).split('\n')) {
    const marker = NOTE_LINE.exec(line.trim())
    if (marker !== null) {
      close()
      open = { id: marker[1] ?? '', date: marker[2] ?? '', lines: [] }
    } else if (open !== undefined) {
      open.lines.push(line)
    }
  }
  close()
  return { before: source.slice(0, start), notes, after: source.slice(end + OWNER_NOTES_END.length) }
}

/**
 * Write a file back with its notes; without notes the section is left out.
 * @param file - the parts.
 * @returns the file's text, empty when nothing is left.
 */
export function renderOwnerNotes(file: NotedFile): string {
  const before = file.before.trimEnd()
  const after = file.after.trim()
  const section = file.notes.length === 0
    ? ''
    : `${OWNER_NOTES_START}\n${HEADING}\n\n${file.notes.map(note => `<!-- delo:note ${note.id} ${note.date} -->\n${note.text}`).join('\n\n')}\n${OWNER_NOTES_END}`
  const parts = [before, section, after].filter(part => part !== '')
  return parts.length === 0 ? '' : `${parts.join('\n\n')}\n`
}

/**
 * Check a note's text.
 * @param text - the text as given.
 * @param maxChars - the longest note, in UTF-16 code units.
 * @returns the trimmed text.
 * @throws {OwnerNotesError} for an empty or too long note, or one holding a marker.
 */
export function ownerNoteText(text: string, maxChars: number): string {
  const trimmed = text.replace(/\r\n/g, '\n').trim()
  if (trimmed === '') throw new OwnerNotesError('a note needs text')
  if (trimmed.length > maxChars) throw new OwnerNotesError(`a note holds at most ${String(maxChars)} characters; this one has ${String(trimmed.length)}`)
  if (trimmed.includes(MARKER)) throw new OwnerNotesError(`a note cannot contain ${MARKER}, which the section's markers start with`)
  return trimmed
}

/**
 * A new note id.
 * @returns `n-` and eight random lower-case base-36 characters.
 */
export function newOwnerNoteId(): string {
  const alphabet = '0123456789abcdefghijklmnopqrstuvwxyz'
  // The modulo slightly favours the first characters; an id is unique within one file only.
  return `n-${[...crypto.getRandomValues(new Uint8Array(8))].map(byte => alphabet[byte % 36] ?? '0').join('')}`
}
