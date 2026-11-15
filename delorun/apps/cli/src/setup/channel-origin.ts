/**
 * The release channel a launcher was built for, as setup's copy names it.
 *
 * @module @delorun/cli/setup/channel-origin
 */
import { readChannelRecord } from '@delorun/install'

/**
 * The channel origin the launcher recorded in the home when it installed the runtime.
 * @param home - the Delorun home.
 * @returns the origin of a launcher built with `--channel-origin`, or `undefined` for the production channel or when the record cannot be read.
 */
export async function channelOriginOf(home: string): Promise<string | undefined> {
  try {
    return (await readChannelRecord(home))?.channelOrigin
  } catch {
    // An invalid record is reported by `delorun doctor`; setup's copy then names the production hosts.
    return undefined
  }
}
