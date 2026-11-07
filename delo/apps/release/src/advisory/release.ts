/**
 * The advisory check over a release directory: the closure lockfiles and installed packages of its runtime archives
 * and the pinned pnpm, against the acceptances file and CODEOWNERS as committed at the release's commit.
 *
 * @module @delo/release/advisory/release
 */
import { execFileSync } from 'node:child_process'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { ADVISORY_ACCEPTANCES_PATH, type SemanticVersion } from '@delo/contract-release-manifest'
import { closureName } from '../rebuild/compare.ts'
import { recipeAt } from '../rebuild/record.ts'
import { readArchiveContents } from '../sbom/release-sbom.ts'
import { checkAdvisories, codeOwners, localPackageNames, lockedPackages, readAcceptances, type AdvisoryReport, type LockedPackage } from './check.ts'

/**
 * The advisory report's file name.
 * @param version - the release.
 * @returns `delorun-<version>.advisories.json`.
 */
export function advisoryReportName(version: string): string {
  return `delorun-${version}.advisories.json`
}

/**
 * Read a file as committed at a commit.
 * @param repository - the repository.
 * @param commit - the commit.
 * @param path - the repository-relative path.
 * @returns the file's text.
 * @throws Error when the file is missing at the commit.
 */
function committedFile(repository: string, commit: string, path: string): string {
  return execFileSync('git', ['show', `${commit}:${path}`], { cwd: repository, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

/** The CODEOWNERS file GitHub reads first. */
const CODEOWNERS_PATH = '.github/CODEOWNERS'

/**
 * Run the advisory check over a release directory: every registry version each closure lockfile locks, every
 * installed package version the archives hold that is not a local workspace package, and the pnpm version
 * `toolchain.json` pins at the commit.
 * @param repository - the repository whose acceptances file, CODEOWNERS and recipe apply.
 * @param commit - the release's commit, at which those files are read; a later edit does not apply.
 * @param release - the directory holding the runtime archives.
 * @param version - the release.
 * @param feed - the bulk advisory endpoint.
 * @returns the report.
 * @throws Error when the directory holds no runtime archive of the release, or the acceptances file, CODEOWNERS or the
 * recipe is missing at the commit or does not read.
 */
export async function releaseAdvisoryCheck(repository: string, commit: string, release: string, version: SemanticVersion, feed: string): Promise<AdvisoryReport> {
  const packages: LockedPackage[] = []
  let archives = 0
  for (const name of (await readdir(release)).sort()) {
    const parsed = closureName(name)
    if (parsed?.kind !== 'archive' || parsed.version !== version) continue
    archives += 1
    const contents = await readArchiveContents(join(release, name), parsed.platform === 'win32-x64' ? 'zip' : 'tar.gz')
    const local = localPackageNames(contents.lockfile)
    packages.push(...lockedPackages(contents.lockfile), ...contents.packages.filter(entry => !local.has(entry.name)).map(entry => ({ name: entry.name, version: entry.version })))
  }
  if (archives === 0) throw new Error(`${release} holds no runtime archive of ${version}`)
  packages.push({ name: 'pnpm', version: recipeAt(repository, commit).toolchain.pnpm.version })
  return checkAdvisories({
    version,
    packages,
    acceptances: readAcceptances(committedFile(repository, commit, ADVISORY_ACCEPTANCES_PATH)),
    owners: codeOwners(committedFile(repository, commit, CODEOWNERS_PATH), ADVISORY_ACCEPTANCES_PATH),
    feed,
  })
}
