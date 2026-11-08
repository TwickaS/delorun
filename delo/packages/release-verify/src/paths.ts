/**
 * Where contract C18's two records live under a Delo home (contract C1): the verified checkpoint at C1's
 * `trust/checkpoint.json`, which the contract names, and the check state of each installed release beside it. C1 lists
 * the checkpoint file and no per-release state file, so this package names the second one — `trust/release-log.json` —
 * until C1 lists one, and the README states that.
 *
 * @module @delo/release-verify/paths
 */
import { DELO_HOME_ENTRIES, TRUST_FILES } from '@delo/contract-home-layout'
import { join } from 'node:path'

/** The check state of every installed release, relative to the home. */
export const RELEASE_LOG_STATE_FILE = `${DELO_HOME_ENTRIES.trust}/release-log.json`

/**
 * The path of the verified checkpoint record.
 * @param home - the resolved Delo home.
 * @returns the absolute path of `trust/checkpoint.json`.
 */
export function checkpointPath(home: string): string {
  return join(home, DELO_HOME_ENTRIES.trust, TRUST_FILES.checkpoint)
}

/**
 * The path of the check state record.
 * @param home - the resolved Delo home.
 * @returns the absolute path of {@link RELEASE_LOG_STATE_FILE}.
 */
export function checkStatePath(home: string): string {
  return join(home, RELEASE_LOG_STATE_FILE)
}
