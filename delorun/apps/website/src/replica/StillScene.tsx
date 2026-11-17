/**
 * The still as the server draws it, from the session's fixture: the replay's first state, and in the same markup the
 * resting chapter's last state, which the stylesheet shows where the replay does not play (reduced motion, scripts off).
 * Only the server's `virtual:replica-island` imports this module, so no page script carries the fixtures or the real
 * sections for it; the live replica reuses the markup the server sent.
 * @module @delorun/website/replica/StillScene
 */
import strings from 'virtual:replica-strings'
import { renderToStaticMarkup } from 'react-dom/server'
import { chapterStart, shiftClock, stateAt, type ChapterFile, type ReplicaFixture, type SessionId } from './model.ts'
import { slotWidths, type ReplicaLiveProps } from './ReplicaLive.tsx'
import { ChatScreen } from './screens/ChatScreen.tsx'
import { RealChanges } from './screens/real.tsx'
import { StudioLayout, type ReplicaWidth } from './screens/StudioLayout.tsx'
import { CHAPTER_FILES } from './sessions/index.ts'
import { FIXTURE as CHANGES_AND_VERSIONS } from './sessions/changes-and-versions.session.ts'
import { FIXTURE as ORDINARY_WORK } from './sessions/ordinary-work.session.ts'

const FIXTURES: Readonly<Record<SessionId, ReplicaFixture>> = {
  'ordinary-work': ORDINARY_WORK,
  'changes-and-versions': CHANGES_AND_VERSIONS,
}

/**
 * The still's content at one width.
 * @param props - the session's chapters, its fixture with its times placed, and the width.
 * @returns the drawn studio in its first state.
 * @throws Error when the resting chapter ends on another screen than the first state, which one still cannot hold.
 */
export function StillScene({ file, fixture, width }: { readonly file: ChapterFile, readonly fixture: ReplicaFixture, readonly width: ReplicaWidth }) {
  const start = chapterStart(file, 0)
  const resting = stateAt(file, file.resting, Number.POSITIVE_INFINITY).state
  if (resting.screen !== start.screen) throw new Error(`replica still: ${file.session} rests on ${resting.screen}, but starts on ${start.screen}`)
  const changes = fixture.changes[start.changes]
  return <StudioLayout file={file} width={width} screen={file.start.screen} strings={strings} screens={{
    chat: <ChatScreen events={fixture.events} shown={Math.max(start.shown, resting.shown)} later={start.shown} draft="" typing={false} strings={strings} />,
    changes: changes === undefined ? null : <RealChanges state={changes} groups={start.groups} />,
    // Setup versions loads its list after the first render, so a still of it would show only its loading line.
    versions: null,
  }} />
}

/**
 * Each slot's still as markup, for `ReplicaLive`'s `stills`.
 * @param props - the session and the replica's width.
 * @param now - the moment the page is drawn, against which the fixture's relative times are placed.
 * @returns the markup by width.
 */
export function stillMarkup({ session, width }: Pick<ReplicaLiveProps, 'session' | 'width'>, now = Date.now()): Partial<Record<ReplicaWidth, string>> {
  const loaded = FIXTURES[session]
  const fixture = shiftClock(loaded, now - Date.parse(loaded.clock))
  return Object.fromEntries(slotWidths(width).map(each => [each, renderToStaticMarkup(<StillScene file={CHAPTER_FILES[session]} fixture={fixture} width={each} />)]))
}
