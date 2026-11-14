/**
 * Where contract C18's two records live under a Delorun home (contract C1): the verified checkpoint at
 * `trust/checkpoint.json` and the check state of each installed release at `trust/release-log.json`, both named by C1's
 * `TRUST_FILES`.
 *
 * @module @delorun/release-verify/paths
 */
import { DELORUN_HOME_ENTRIES, TRUST_FILES } from '@delorun/contract-home-layout'
import { join } from 'node:path'

/** The check state of every installed release, relative to the home. */
export const RELEASE_LOG_STATE_FILE = `${DELORUN_HOME_ENTRIES.trust}/${TRUST_FILES.releaseLog}`

/**
 * The path of the verified checkpoint record.
 * @param home - the resolved Delorun home.
 * @returns the absolute path of `trust/checkpoint.json`.
 */
export function checkpointPath(home: string): string {
  return join(home, DELORUN_HOME_ENTRIES.trust, TRUST_FILES.checkpoint)
}

/**
 * The path of the check state record.
 * @param home - the resolved Delorun home.
 * @returns the absolute path of {@link RELEASE_LOG_STATE_FILE}.
 */
export function checkStatePath(home: string): string {
  return join(home, RELEASE_LOG_STATE_FILE)
}
