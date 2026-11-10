/**
 * The withdrawal of a stock-home import that a crash interrupted, for the
 * start path: a profile must never run over half of an import. When the
 * import's journal exists, this process registers as the one exclusive user
 * of the home's shared stores, as the import itself does, and refuses while
 * any other live process uses them or an update, a rollback or a restore of
 * any profile is unfinished, so an update's recovery and an import's recovery
 * are never both pending at once. Without a journal it registers nothing and
 * returns at once, so an ordinary start pays one `lstat`.
 *
 * The start path is to call {@link recoverInterruptedImport} first in
 * `startForeground`, after the profile check and before the home process
 * registers, and in `runHeadless` before its shared registration. This module
 * does not wire either call; the start path does.
 *
 * @module @delo/cli/import-home/recover
 */
import { lstat } from 'node:fs/promises'
import { join } from 'node:path'
import { recoverStockImport, STOCK_IMPORT_DIRECTORY, STOCK_IMPORT_JOURNAL, type DshImportRecovery } from '@delo/archive/dsh-import'
import { CliError, EXIT } from '../exit.ts'
import { assertNoUpdateInProgress, assertSoleDataUser, DataInUseError, registerDataUser } from '../home-exclusion.ts'

/**
 * Withdraw an interrupted stock-home import before a profile starts.
 * @param home - the resolved Delo home.
 * @param command - the `delorun` command that starts the profile, named in other users' refusals.
 * @returns what the withdrawal did, or `undefined` when no import was interrupted.
 * @throws {CliError} when another process uses the shared stores or an update, a rollback or a restore is unfinished;
 *   the journal stays for a later start. DshImportError from {@link recoverStockImport} when the journal cannot be
 *   trusted or its staging directory is gone, which keeps the profile from starting.
 */
export async function recoverInterruptedImport(home: string, command: string): Promise<DshImportRecovery | undefined> {
  try {
    await lstat(join(home, STOCK_IMPORT_DIRECTORY, STOCK_IMPORT_JOURNAL))
  } catch (error: unknown) {
    // ENOENT: no import was interrupted. Any other failure is the recovery's to report, under the registration.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
  }
  const release = registerDataUser(home, 'exclusive', command)
  try {
    try {
      assertSoleDataUser(home)
      await assertNoUpdateInProgress(home)
    } catch (error: unknown) {
      if (error instanceof DataInUseError) throw new CliError(EXIT.failed, `delorun ${command}: an interrupted import of a DeepSeek Harness home waits to be withdrawn, and ${error.detail}`)
      throw error
    }
    return await recoverStockImport(home)
  } finally {
    release()
  }
}
