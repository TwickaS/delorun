/**
 * The replica's own words on the page: the names of its frames and controls. The drawn studio's text is the product's
 * (`strings.ts`); the chapters' titles and captions are in the chapter files.
 * @module @delorun/website/replica/copy
 */
import type { SessionId } from './model.ts'

/** The replica's words. */
export const REPLICA_COPY = {
  /** The frame's name, by session: what the replayed studio shows. */
  frame: {
    'ordinary-work': 'The Delorun studio, replaying a piece of ordinary work',
    'changes-and-versions': 'The Delorun studio, replaying changes and setup versions',
  } satisfies Record<SessionId, string>,
  rail: 'Chapters',
  pause: 'Pause',
  play: 'Play',
  replay: 'Replay',
  terminal: 'Terminal',
  transcript: 'Chat',
} as const
