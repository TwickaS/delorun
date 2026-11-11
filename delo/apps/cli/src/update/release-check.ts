/**
 * Contract C18's release-log start check of an installed version, run before a home process starts from it without
 * the launcher: an update's or a rollback's successor, and the start after an interrupted update. It is the check the
 * launcher runs before every start: the stored release-log bundle offline, then the online check against the log the
 * anchored root names, with the state and the verified checkpoint recorded under `trust/`. A check that could not
 * complete lets the start go on; a verifiable failure, or a missing bundle beside a release the store installed, stops
 * it.
 *
 * @module @delo/cli/update/release-check
 */
import { readFile } from 'node:fs/promises'
import type { RuntimeVersion } from '@delo/contract-home-layout'
import type { RootMetadata, RuntimePlatform } from '@delo/contract-release-manifest'
import type { LogCheckResult } from '@delo/contract-update-report'
import { HomeProcessError } from '@delo/home-process'
import { checkAndRecord, logEndpoints, readCheckRecords, tilesTransport, type Fetch } from '@delo/release-verify'
import type { ReleaseLogTransport } from '@delo/release-verify/online'
import { StorePaths } from '@delo/runtime-store'

/** What one check reads beside the version and the root. */
export interface ReleaseCheckEnvironment {
  /**
   * The transport to the log a root names.
   * @param root - the anchored root.
   * @returns the transport.
   */
  readonly transport: (root: RootMetadata) => ReleaseLogTransport
  /** The clock, in milliseconds. */
  readonly now: () => number
}

/**
 * This process's transport, over its own fetch to the log the root names, and its clock.
 * @param fetch - the fetch; this process's by default.
 * @returns the environment.
 */
export function processReleaseCheck(fetch: Fetch = globalThis.fetch.bind(globalThis)): ReleaseCheckEnvironment {
  return { transport: root => tilesTransport({ fetch, ...logEndpoints(root) }), now: Date.now }
}

/**
 * The release-log start check before a home process starts from an installed version.
 * @param home - the resolved Delo home.
 * @param platform - the platform whose release files the store keeps.
 * @param version - the installed version.
 * @param root - the anchored root its start check verified it under.
 * @param environment - the transport and the clock; this process's by default.
 * @throws {HomeProcessError} `VERIFY_FAILED` when the check fails verifiably, naming the refusal and `delorun verify`.
 */
export async function releaseLogStartCheck(home: string, platform: RuntimePlatform, version: RuntimeVersion, root: RootMetadata, environment: ReleaseCheckEnvironment = processReleaseCheck()): Promise<void> {
  const files = new StorePaths(home, platform).releaseFiles(version)
  const manifest = await readFile(files.manifest)
  const bundle = await readFile(files.bundle).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  })
  const check = await checkAndRecord(home, {
    root, version, manifest, bundle, missingBundle: 'failed', now: Math.floor(environment.now() / 1000), mode: 'enforce',
    transport: environment.transport(root),
  })
  if (check.stop) {
    throw new HomeProcessError('VERIFY_FAILED', `release ${String(version)} failed its release-log check (${String(check.refusal)}): ${String(check.detail)}; Delo did not start it. Run delorun verify --release ${String(version)} to see every check`)
  }
}

/**
 * The release-log check state an install recorded for a version in `trust/release-log.json`, as C3's report states it:
 * `passed` for `verified`, and the recorded `unchecked` or `failed` as they are. A version with no record is
 * `unchecked`, because nothing shows its log check completed.
 * @param home - the resolved Delo home.
 * @param version - the installed version.
 * @returns the report's `release.log`.
 * @throws HomeLayoutError `SECRET_FILE_MODE` when the record is a link, another user's or laxer than 0600.
 */
export async function recordedLogCheck(home: string, version: RuntimeVersion): Promise<LogCheckResult> {
  const record = (await readCheckRecords(home)).get(String(version))
  if (record === undefined) return 'unchecked'
  switch (record.state) {
    case 'verified':
      return 'passed'
    case 'unchecked':
      return 'unchecked'
    case 'failed':
      return 'failed'
  }
}
