/**
 * Ending a work session without the person (contract C21, "Work sessions"), the package entry `@delo/changes/stop`:
 * the home process calls it after its Host stopped and when the session's end time passed, and a start calls it for a
 * session a home process that ended without stopping left open. No request starts it, so it takes no proof of
 * presence, and it approves nothing; only `delorun`'s start module imports this entry, which a structural spec checks.
 *
 * @module @delo/changes/stop
 */
import { locked } from './action-support.ts'
import type { ChangesContext, ReloadHost } from './actions.ts'
import { readWorkSession } from './records.ts'
import { endWorkWithoutPerson, workSessionExpired, type WorkEnding, type WorkFinished } from './work.ts'

/**
 * End the profile's open work session without the person: the approved content stays the version the session started
 * from, the plugin's active directory holds it again, and what the folder holds waits for review as the ordinary
 * pending change. Nothing is approved, logged or recorded in the profile history.
 * @param ctx - the profile, with the clock that decides whether the session's end time passed.
 * @param ended - `stopped` when Delo stops or a start finds the session open; `expired` when its end time passed, which
 *   ends only a session whose end time did pass.
 * @param reload - reloads the running Host after the active directory went back, when Delo keeps running.
 * @returns what was done; undefined when no work session is open, or for `expired`, none whose end time passed.
 * @throws {ChangesError} when a record of Changes is not one Delo wrote.
 */
export async function finishWorkWithoutPerson(ctx: ChangesContext, ended: Exclude<WorkEnding, 'done'>, reload?: ReloadHost): Promise<WorkFinished | undefined> {
  return locked(ctx, async () => {
    const session = await readWorkSession(ctx.home, ctx.profile)
    if (session === undefined || (ended === 'expired' && !workSessionExpired(ctx, session))) return undefined
    return endWorkWithoutPerson(ctx, session, ended, reload)
  })
}
