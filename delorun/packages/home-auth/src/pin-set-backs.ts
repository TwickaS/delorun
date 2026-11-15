/**
 * Read the settings an unlocked PIN page loosened that have not been set back yet, from the files in the home and
 * without the home running ([C14](../../../docs/contracts/c14-oidc-passkeys.md#pin-mode)).
 *
 * @module @delorun/home-auth/pin-set-backs
 */
import { join } from 'node:path'
import { HOME_AUTH_FILES } from '@delorun/contract-device-approval'
import { DangerousSettingsLedger, type LiftField } from './dangerous-settings.ts'

/**
 * @param directory - the home-auth secrets directory.
 * @returns the namespace and field of each recorded lift, never a value; empty when none waits.
 * @throws {Error} when the file is refused or is not this package's record.
 */
export async function readPinSetBacks(directory: string): Promise<readonly LiftField[]> {
  const ledger = new DangerousSettingsLedger(join(directory, HOME_AUTH_FILES.reachPinSettings), 'PIN mode settings')
  await ledger.load()
  return ledger.fields()
}
