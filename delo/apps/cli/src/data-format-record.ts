/**
 * The pre-start step that records the running release's data formats in the home's `data-format.json` (contract C1),
 * before a Host opens any data. A runtime that does not run from the runtime store (a source run) has no signed
 * `data-formats.json` and records nothing.
 *
 * @module @delo/cli/data-format-record
 */
import { fileURLToPath } from 'node:url'
import { DELO_HOME_ENTRIES } from '@delo/contract-home-layout'
import { recordHomeDataFormat } from '@delo/update'
import { join } from 'node:path'
import type { PreStartContext } from './pre-start.ts'
import { runtimeOfFile } from './update/runtime.ts'
import { deloVersion, dshVersion } from './version.ts'

/**
 * Record the running release's data formats in the home.
 * @param context - the start.
 * @returns when the record is written, kept or not applicable.
 * @throws {Error} when the record cannot be written, which refuses the start: the home's data must not be opened
 *   without the record that guards a later repair.
 */
export async function recordDataFormatStep(context: PreStartContext): Promise<void> {
  const running = runtimeOfFile(context.home, fileURLToPath(import.meta.url))
  if (!running.store) return
  await recordHomeDataFormat({ home: context.home, runtimeDirectory: join(context.home, DELO_HOME_ENTRIES.runtimes, running.version), delo: deloVersion(), dsh: dshVersion() })
}
