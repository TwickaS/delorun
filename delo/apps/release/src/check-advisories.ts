/**
 * The dependency advisory check's command (contract C2), which the release workflow runs before signing:
 *
 * `node_modules/.bin/tsx delo/apps/release/src/check-advisories.ts --version <version> --release <dir> [--commit <rev>]
 * [--feed <url>]`
 *
 * It reads the closure lockfile of every runtime archive in `--release`, asks the feed (npm's bulk advisory API over
 * the GitHub Advisory Database by default) about every locked registry version, applies the reviewed entries of
 * `delo/release/advisory-acceptances.yaml` as committed at `--commit` (`HEAD` when omitted, the tag in the release
 * workflow), and writes `delorun-<version>.advisories.json`. It exits 0 when every
 * advisory that affects a locked version has a valid acceptance, and 1 otherwise, including when the feed cannot be
 * reached or answers malformed. The signing command runs the same check again against the contract's feed.
 *
 * @module @delo/release/check-advisories
 */
import { writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { ADVISORY_FEED_URL } from '@delo/contract-release-manifest'
import { repositoryRoot } from '@delo/tools/src/git.ts'
import { advisoryReportName, releaseAdvisoryCheck } from './advisory/release.ts'
import { semanticVersion } from './brands.ts'
import { commitOf } from './rebuild/record.ts'

async function main(argv: readonly string[]): Promise<number> {
  const { values } = parseArgs({ args: [...argv], strict: true, options: { version: { type: 'string' }, release: { type: 'string' }, commit: { type: 'string', default: 'HEAD' }, feed: { type: 'string', default: ADVISORY_FEED_URL } } })
  try {
    if (values.version === undefined || values.release === undefined) throw new Error('pass --version <version> and --release <dir>')
    const version = semanticVersion(values.version)
    const release = resolve(values.release)
    const repository = repositoryRoot(process.cwd())
    const report = await releaseAdvisoryCheck(repository, commitOf(repository, values.commit), release, version, values.feed)
    await writeFile(join(release, advisoryReportName(version)), `${JSON.stringify(report, undefined, 2)}\n`, { mode: 0o644 })
    for (const finding of report.findings) {
      if (finding.accepted !== undefined) console.log(`check-advisories: accepted ${finding.advisory} in ${finding.package}@${finding.version} (approved by ${finding.accepted.approver} on ${finding.accepted.added}, lapses after ${finding.accepted.lapsesAfter})`)
    }
    for (const problem of report.problems) console.error(`check-advisories: ${problem}`)
    console.log(`check-advisories: ${report.result} over ${String(report.packages)} locked versions; wrote ${advisoryReportName(version)}`)
    return report.result === 'pass' ? 0 : 1
  } catch (error) {
    console.error(`check-advisories: ${error instanceof Error ? error.message : String(error)}`)
    return 1
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2))
}
