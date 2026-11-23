/**
 * The GitHub Actions workflows the public repository starts with (ST43, ST88). Every file under `.github/workflows` is
 * classified here as kept or removed, so a new upstream workflow fails the check until someone classifies it. The tool
 * only prepares a change in a checkout: it deletes the removed files and drops the heavy jobs from `ci.yml`. It enables
 * nothing; GitHub runs a workflow only after the repository's Actions settings allow it.
 * Run: `node delorun/apps/tools/src/opening/workflows.ts --repo <checkout> [--apply]`; without `--apply` it only reports.
 *
 * @module @delorun/tools/opening/workflows
 */
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'

/** Workflows the public repository keeps, with the reason. */
export const KEPT: Readonly<Record<string, string>> = {
  'gates.yml': "Delorun's own check gates; free hosted runner, no secrets.",
  'expected-filenames.yml': 'Cheap filename check; free hosted runner, no secrets.',
  'ci.yml': 'Static analysis and lint jobs only; the coverage, benchmark, consumer and compatibility jobs are removed (see KEPT_CI_JOBS).',
}

/** Jobs of `ci.yml` that stay. */
export const KEPT_CI_JOBS: readonly string[] = ['node-24', 'node-24-lint', 'all-checks-passed']

/** Workflows the public repository removes, with the reason. */
export const REMOVED: Readonly<Record<string, string>> = {
  'build-exe-for-python-sdk.yml': 'Builds a release artefact and uses a real model key.',
  'build-exe-for-ssh-helper.yml': 'Release artefact build.',
  'build-preview-cloudflare.yml': "Deploys previews to upstream's Cloudflare account.",
  'ci-master.yml': 'Self-hosted and Windows runners and a real model key.',
  'ci-python.yml': 'Python SDK checks; uses a real model key.',
  'ci-windows.yml': 'Paid or self-hosted Windows runners.',
  'cua-helper-package.yml': 'Self-hosted macOS runner; desktop app.',
  'desktop-publish.yml': 'Publishes the desktop app.',
  'desktop-rollout.yml': 'Publishes the desktop app.',
  'docs-pages.yml': "Deploys upstream's documentation site on a paid runner.",
  'e2e.yml': 'Needs a real model key.',
  'issue-lifecycle.yml': "Upstream's issue bot; needs its GitHub App secret.",
  'issue-policy.yml': "Upstream's issue bot; needs its GitHub App secret.",
  'macos-intel-package.yml': 'Self-hosted macOS runner; desktop app.',
  'macos-package.yml': 'Self-hosted macOS runner; desktop app.',
  'node-addon-system-release.yml': 'Publishes to npm.',
  'node-addon-system.yml': 'Native addon build matrix.',
  'pi-ai-provider-e2e.yml': 'Needs real provider keys.',
  'pr-check-after-approve.yml': "Upstream's approval bot; needs its GitHub App secret.",
  'pr-check-on-base-branch.yml': "Upstream's policy bot; needs its token.",
  'pr-check-on-head-branch.yml': "Upstream's policy bot on a paid runner.",
  'publish-ssh-helper.yml': 'Publishes a release artefact.',
  'python-release.yml': 'Publishes to PyPI.',
  'release-publish.yml': 'Publishes to npm.',
  'release-vendor-publish.yml': 'Publishes to npm.',
  'release-vendor.yml': 'Vendor release build.',
  'release.yml': 'Release build.',
  'sandbox.yml': 'macOS runner matrix.',
  'weighted-approval-review-event.yml': "Upstream's approval bot.",
  'weighted-approval.yml': "Upstream's approval bot; needs its GitHub App secret.",
  'windows-package.yml': 'Self-hosted Windows runner; desktop app.',
}

/**
 * Compare the workflow files in a directory with the two lists.
 * @param files - file names found.
 * @returns names that are in neither list, kept names that are missing, and removed names still present.
 */
export function classify(files: readonly string[]): { unclassified: string[]; missing: string[]; remaining: string[] } {
  const known = new Set([...Object.keys(KEPT), ...Object.keys(REMOVED)])
  const present = new Set(files)
  return {
    unclassified: files.filter(name => !known.has(name)),
    missing: Object.keys(KEPT).filter(name => !present.has(name)),
    remaining: Object.keys(REMOVED).filter(name => present.has(name)),
  }
}

/**
 * Remove jobs from a workflow's text, with the comment lines directly above each.
 * @param text - the workflow file.
 * @param keep - the job keys to keep; every other job under `jobs:` goes.
 * @returns the text, with `needs:` lists on the kept jobs reduced to kept jobs.
 */
export function keepJobs(text: string, keep: readonly string[]): string {
  const lines = text.split('\n')
  const jobsAt = lines.indexOf('jobs:')
  if (jobsAt < 0) throw new Error('no jobs: section')
  const starts: { index: number; key: string }[] = []
  for (let i = jobsAt + 1; i < lines.length; i += 1) {
    const match = /^ {2}([a-z0-9-]+):\s*$/u.exec(lines[i]!)
    if (match !== null) starts.push({ index: i, key: match[1]! })
  }
  const out = lines.slice(0, jobsAt + 1)
  for (const [n, job] of starts.entries()) {
    const previous = n === 0 ? jobsAt + 1 : starts[n - 1]!.index + 1
    let from = job.index
    while (from > previous && /^ {2}#/u.test(lines[from - 1]!)) from -= 1
    const to = n + 1 < starts.length ? starts[n + 1]!.index : lines.length
    let nextFrom = to
    if (n + 1 < starts.length) while (nextFrom > job.index + 1 && /^ {2}#/u.test(lines[nextFrom - 1]!)) nextFrom -= 1
    if (n === 0) out.push(...lines.slice(jobsAt + 1, from))
    if (keep.includes(job.key)) out.push(...lines.slice(from, nextFrom))
  }
  return out.join('\n').replace(/^( {4}needs: )\[([^\]]*)\]/gmu, (_all, head: string, list: string) => `${head}[${list.split(',').map(item => item.trim()).filter(item => keep.includes(item)).join(', ')}]`)
}

/**
 * The workflow files in a directory: every `.yml` and `.yaml` file, so a file with either extension is classified.
 * @param dir - the `.github/workflows` directory.
 * @returns the file names, sorted.
 */
export function workflowFiles(dir: string): string[] {
  return readdirSync(dir).filter(name => /\.ya?ml$/u.test(name)).sort()
}

function main(argv: readonly string[]): number {
  const { values } = parseArgs({ args: [...argv], options: { repo: { type: 'string' }, apply: { type: 'boolean', default: false } } })
  if (values.repo === undefined) {
    console.error('usage: workflows.ts --repo <checkout> [--apply]')
    return 2
  }
  const dir = join(values.repo, '.github', 'workflows')
  const files = workflowFiles(dir)
  const { unclassified, missing, remaining } = classify(files)
  if (unclassified.length > 0) console.error(`unclassified workflows: ${unclassified.join(', ')}`)
  if (missing.length > 0) console.error(`kept workflows that are missing: ${missing.join(', ')}`)
  if (values.apply && unclassified.length === 0) {
    for (const name of remaining) rmSync(join(dir, name))
    const ci = join(dir, 'ci.yml')
    if (existsSync(ci)) writeFileSync(ci, keepJobs(readFileSync(ci, 'utf8'), KEPT_CI_JOBS))
  }
  const left = values.apply ? [] : remaining
  console.log(left.length === 0 ? `nothing left to remove${values.apply ? ' (applied)' : ''}` : `${String(left.length)} to remove (report only): ${left.join(', ')}`)
  return unclassified.length === 0 && missing.length === 0 ? 0 : 1
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main(process.argv.slice(2))
