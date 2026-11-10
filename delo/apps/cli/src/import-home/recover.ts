/**
 * The withdrawal of a stock-home import that a crash interrupted, for the
 * start path: a profile must never run over half of an import. When the
 * import's journal exists, the starting process's own registration turns
 * exclusive, as the import itself registers, and it refuses while any other
 * live process uses the stores or an update, a rollback or a restore of any
 * profile is unfinished, so an update's recovery and an import's recovery are
 * never both pending at once. Without a journal it changes nothing and returns
 * at once, so an ordinary start pays one `lstat`. The first pre-start step of
 * both starts calls it ([pre-start](../pre-start.ts)).
 *
 * @module @delo/cli/import-home/recover
 */
import { lstat } from 'node:fs/promises'
import { join } from 'node:path'
import { recoverStockImport, STOCK_IMPORT_DIRECTORY, STOCK_IMPORT_JOURNAL, type DshImportRecovery } from '@delo/archive/dsh-import'
import { asSoleUser, assertNoUpdateInProgress, type OwnRegistration } from '../home-exclusion.ts'

/**
 * Withdraw an interrupted stock-home import before a profile starts.
 * @param home - the resolved Delo home.
 * @param own - the registration the starting process already holds, which turns exclusive while the import is
 *   withdrawn and shared again afterwards.
 * @returns what the withdrawal did, or `undefined` when no import was interrupted.
 * @throws {CliError} when another process uses the shared stores or an update, a rollback or a restore is unfinished;
 *   the journal stays for a later start. DshImportError from {@link recoverStockImport} when the journal cannot be
 *   trusted or its staging directory is gone, which keeps the profile from starting.
 */
export async function recoverInterruptedImport(home: string, own: OwnRegistration): Promise<DshImportRecovery | undefined> {
  try {
    await lstat(join(home, STOCK_IMPORT_DIRECTORY, STOCK_IMPORT_JOURNAL))
  } catch (error: unknown) {
    // ENOENT: no import was interrupted. Any other failure is the recovery's to report, under the registration.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
  }
  return asSoleUser(home, own, 'an interrupted import of a DeepSeek Harness home waits to be withdrawn', () => recoverStockImport(home), () => assertNoUpdateInProgress(home))
}
