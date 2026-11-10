/**
 * The doctor's `update` check: what the last update check of the profile found, read from its record
 * (`run/<profile>/update-check.json`, design `delo/docs/design/update-notice.md`). The doctor sends no request: it
 * reports the record. A failed check, silent in the notice, is a warning here, and so is a newer release.
 *
 * @module @delo/cli/doctor/update
 */
import type { RuntimePlatform } from '@delo/contract-release-manifest'
import { UPDATE_COMMAND } from '@delo/contract-update-report'
import { noticeLine, noticeOf, profileReader, readUpdateCheck, runningRelease } from '../update/notice.ts'
import type { RunningRuntime } from '../update/runtime.ts'
import type { TrustedRootSource } from '@delo/runtime-store'
import type { CheckResult } from './checks.ts'

/**
 * Report the last update check.
 * @param home - the resolved Delo home.
 * @param profile - the CLI profile.
 * @param runtime - the runtime this command runs.
 * @param platform - the runtime platform; read only when the runtime runs from the store.
 * @param root - the stored root, anchored on the launcher's roots; read only when a record exists.
 * @returns `pass` when no check has run, the running release is the newest, or this Delo has no channel; `warn` when
 *   the last check failed or a newer release exists.
 * @throws {Error} when the running release's signed files do not read or verify.
 */
export async function checkUpdate(home: string, profile: string, runtime: RunningRuntime, platform: () => RuntimePlatform, root: TrustedRootSource): Promise<CheckResult> {
  if (!runtime.store) return { name: 'update', status: 'pass', message: 'this Delo does not run from the runtime store, so it checks no release channel.' }
  const record = await readUpdateCheck(home, profile)
  if (record === undefined) return { name: 'update', status: 'pass', message: `no update check is recorded for this profile; it runs while Delo runs unless Settings → Privacy turns it off, and ${UPDATE_COMMAND} --check runs one now.` }
  if (record.failure !== undefined) {
    return { name: 'update', status: 'warn', message: `the last update check, at ${record.checked}, failed, so the studio shows no notice: ${record.failure}. Run ${UPDATE_COMMAND} --check to try again.` }
  }
  const running = await runningRelease(home, platform(), runtime.version, await root())
  const notice = await noticeOf(record, running, profileReader(home, profile))
  if (notice !== undefined) return { name: 'update', status: 'warn', message: `${noticeLine(notice)} (checked ${record.checked}).` }
  return { name: 'update', status: 'pass', message: `Delorun ${running.delo} is the newest release on the ${running.channel} channel (checked ${record.checked}).` }
}
