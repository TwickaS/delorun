/**
 * Change ids. An id is derived from what the change is, so the same change has the same id in `list`, `show` and
 * `apply`, and a folder that changed after it was reviewed has a different id: applying an id applies exactly the
 * content that was shown.
 *
 * @module @delo/changes/ids
 */
import { createHash } from 'node:crypto'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { ChangeId, ChangeKind, ChangeSubject, ContentVersion } from './types.ts'

/** What a change id is: `c` and ten lowercase hexadecimal digits. */
export const CHANGE_ID_PATTERN = /^c[0-9a-f]{10}$/

/**
 * The id of a change.
 * @param kind - what it changes.
 * @param subject - what it is about.
 * @param from - the content before, when it had one.
 * @param to - the content after, when it has one.
 * @param occurrence - which request of the same change this is, counted from 0: an agent's request for a plugin spec
 *   that was already decided is a new change with a new id. The first occurrence's id is the id without the count.
 * @returns the id.
 */
export function changeId(kind: ChangeKind, subject: ChangeSubject, from: ContentVersion | undefined, to: ContentVersion | undefined, occurrence = 0): ChangeId {
  const parts = [kind, subject.plugin ?? '', subject.source ?? '', subject.file ?? '', subject.setting ?? '', subject.spec ?? '', from ?? '', to ?? '', ...occurrence === 0 ? [] : [String(occurrence)], ...subject.runtime === undefined ? [] : [`runtime:${subject.runtime}`]]
  return brandString<ChangeId>(`c${createHash('sha256').update(parts.join('\0')).digest('hex').slice(0, 10)}`)
}

/**
 * Read a change id the person typed.
 * @param text - the typed id.
 * @returns the id, or undefined when it is not one.
 */
export function parseChangeId(text: string): ChangeId | undefined {
  return CHANGE_ID_PATTERN.test(text) ? brandString<ChangeId>(text) : undefined
}
