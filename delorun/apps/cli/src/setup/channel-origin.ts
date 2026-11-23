/**
 * The release channel a launcher was built for, as setup's copy names it.
 *
 * @module @delorun/cli/setup/channel-origin
 */
import { readChannelRecord } from '@delorun/install'

/** The production release channel's origin; a launcher built for it is on npm. */
export const PRODUCTION_CHANNEL_ORIGIN = 'https://releases.delorun.com'

/**
 * The channel origin the launcher recorded in the home when it installed the runtime.
 * @param home - the Delorun home.
 * @returns the origin of a launcher built for another release channel, or `undefined` for the production channel
 *   (including a record that names `https://releases.delorun.com`) or when the record cannot be read.
 */
export async function channelOriginOf(home: string): Promise<string | undefined> {
  try {
    const origin = (await readChannelRecord(home))?.channelOrigin
    return origin !== undefined && new URL(origin).origin === PRODUCTION_CHANNEL_ORIGIN ? undefined : origin
  } catch {
    // An invalid record is reported by `delorun doctor`; setup's copy then names the production hosts.
    return undefined
  }
}
