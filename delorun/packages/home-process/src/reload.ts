/**
 * The update channel's `changes.reload` (contract C19): the running Host loads what the profile's files now name.
 *
 * It is accepted only with the person's token, as the channel's other operations that change what the Host runs are:
 * the Host's channel token, which acts for studio sessions on every listener, reach sessions included, is refused with
 * `LOOPBACK_REQUIRED` before the Host is asked anything.
 *
 * @module @delorun/home-process/reload
 */
import type { ChannelCaller } from './devices-approve.ts'
import { HomeProcessError } from './errors.ts'
import type { ChangesReloadOutcome } from '@delorun/contract-home-process'

/**
 * Run `changes.reload`.
 * @param caller - the credential the request carried.
 * @param reload - the Host's reload.
 * @returns the final line's fields: `reload`.
 * @throws {HomeProcessError} `LOOPBACK_REQUIRED` for the Host's token.
 */
export async function reloadChanges(caller: ChannelCaller, reload: () => Promise<ChangesReloadOutcome>): Promise<Readonly<Record<string, unknown>>> {
  if (caller !== 'person') throw new HomeProcessError('LOOPBACK_REQUIRED', 'loading changes is done at your computer: run delorun changes reload there')
  return { reload: await reload() }
}
