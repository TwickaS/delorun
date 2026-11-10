/**
 * Ending a work session because Delo stops (contract C21, "Work sessions"), the package entry `@delo/changes/stop`.
 * The home process calls it after its Host stopped, and a start calls it for a session a home process that ended
 * without stopping left open. No request starts it, so it takes no proof of presence; only `delorun`'s start module
 * imports this entry, which a structural spec checks.
 *
 * @module @delo/changes/stop
 */
import { locked } from './action-support.ts'
import type { ChangesContext } from './actions.ts'
import { readWorkSession } from './records.ts'
import { endWork, type WorkFinished } from './work.ts'

/**
 * End the profile's open work session as Delo stops: the folder's content becomes the approved version, or the content
 * that last loaded when the folder's newest content failed to load or the folder is gone, and the whole difference since
 * the session began is one applied change, decided where the session was started, and one profile history version.
 * Nothing is loaded: the Host is not running.
 * @param ctx - the profile.
 * @returns what was done; undefined when no work session is open.
 * @throws {ChangesError} when a record of Changes is not one Delo wrote or the folder changed while it was read.
 */
export async function finishWorkWithoutPerson(ctx: ChangesContext): Promise<WorkFinished | undefined> {
  return locked(ctx, async () => {
    const session = await readWorkSession(ctx.home, ctx.profile)
    return session === undefined ? undefined : endWork(ctx, session, session.startedFrom, undefined)
  })
}
