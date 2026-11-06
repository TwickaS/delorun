/**
 * The advisory check over a release directory: the closure lockfiles of its runtime archives, the acceptances file
 * as committed at the release's commit, and the dates the acceptances were committed up to it.
 *
 * @module @delo/release/advisory/release
 */
import { execFileSync } from 'node:child_process'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { ADVISORY_ACCEPTANCES_PATH, type SemanticVersion } from '@delo/contract-release-manifest'
import { closureName } from '../rebuild/compare.ts'
import { readArchiveContents } from '../sbom/release-sbom.ts'
import { acceptanceDate, checkAdvisories, readAcceptances, type AdvisoryReport } from './check.ts'

/**
 * The advisory report's file name.
 * @param version - the release.
 * @returns `delorun-<version>.advisories.json`.
 */
export function advisoryReportName(version: string): string {
  return `delorun-${version}.advisories.json`
}

/**
 * Run the advisory check over a release directory.
 * @param repository - the repository whose acceptances file and history apply.
 * @param commit - the release's commit, at which the acceptances file is read; a later edit does not apply.
 * @param release - the directory holding the runtime archives.
 * @param version - the release.
 * @param feed - the bulk advisory endpoint.
 * @returns the report.
 * @throws Error when the directory holds no runtime archive of the release, or the acceptances file is missing at the
 * commit or does not read.
 */
export async function releaseAdvisoryCheck(repository: string, commit: string, release: string, version: SemanticVersion, feed: string): Promise<AdvisoryReport> {
  const lockfiles: string[] = []
  for (const name of (await readdir(release)).sort()) {
    const parsed = closureName(name)
    if (parsed?.kind !== 'archive' || parsed.version !== version) continue
    lockfiles.push((await readArchiveContents(join(release, name), parsed.platform === 'win32-x64' ? 'zip' : 'tar.gz')).lockfile)
  }
  if (lockfiles.length === 0) throw new Error(`${release} holds no runtime archive of ${version}`)
  const committed = execFileSync('git', ['show', `${commit}:${ADVISORY_ACCEPTANCES_PATH}`], { cwd: repository, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  return checkAdvisories({ version, lockfiles, acceptances: readAcceptances(committed), feed, added: advisory => acceptanceDate(repository, advisory, commit) })
}
