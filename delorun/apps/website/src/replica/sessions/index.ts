/**
 * The replayed sessions: each one's chapters, which the page carries (the captions are the replica's text alternative
 * and its still with scripts off), and its fixture, which loads with the drawn studio as a chunk of its own.
 * @module @delorun/website/replica/sessions
 */
import type { ChapterFile, ReplicaFixture, SessionId } from '../model.ts'
import { CHAPTERS as CHANGES_AND_VERSIONS } from './changes-and-versions.chapters.ts'
import { CHAPTERS as ORDINARY_WORK } from './ordinary-work.chapters.ts'

/** Each session's chapters. */
export const CHAPTER_FILES: Readonly<Record<SessionId, ChapterFile>> = {
  'ordinary-work': ORDINARY_WORK,
  'changes-and-versions': CHANGES_AND_VERSIONS,
}

/**
 * Load a session's fixture.
 * @param id - the session.
 * @returns the fixture.
 */
export async function loadFixture(id: SessionId): Promise<ReplicaFixture> {
  switch (id) {
    case 'ordinary-work': return (await import('./ordinary-work.fixture.ts')).FIXTURE
    case 'changes-and-versions': return (await import('./changes-and-versions.fixture.ts')).FIXTURE
  }
}
