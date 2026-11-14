/**
 * DCO gate: every non-merge commit of a range carries a `Signed-off-by` line whose name and email are the commit
 * author's. A pseudonym passes when the author records that pseudonym and its address. Run from anywhere inside the
 * repository: `node_modules/.bin/tsx delorun/apps/tools/src/checks/gates/dco.ts --base <rev>`. It prints one line per
 * commit that fails and exits 1.
 *
 * @module @delorun/tools/checks/gates/dco
 */
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { repositoryRoot } from '../../git.ts'
import { rangeCommits, type Identity, type RangeCommit } from './commit-range.ts'

const SIGN_OFF = /^Signed-off-by: (.+?) <([^<>\s]+)>\s*$/gmu

/**
 * The identities a commit message signs off with.
 * @param message - a full commit message.
 * @returns each `Signed-off-by` line's name and email, in order.
 */
export function signOffsOf(message: string): Identity[] {
  return [...message.matchAll(SIGN_OFF)].map(match => ({ name: (match[1] ?? '').trim(), email: match[2] ?? '' }))
}

/**
 * The commits whose sign-offs do not name their author: no `Signed-off-by` line carries the author's name and email.
 * The email compares without case.
 * @param commits - the commits of a range.
 * @returns one message per failing commit, naming its short id and its author; empty when every commit passes.
 */
export function dcoErrors(commits: readonly RangeCommit[]): string[] {
  return commits.flatMap((commit) => {
    const signed = signOffsOf(commit.message).some(signer => signer.name === commit.author.name
      && signer.email.toLowerCase() === commit.author.email.toLowerCase())
    return signed ? [] : [`${commit.sha.slice(0, 10)}: no Signed-off-by line names the author ${commit.author.name} <${commit.author.email}>`]
  })
}

function main(argv: readonly string[]): number {
  const { values } = parseArgs({ args: [...argv], options: { base: { type: 'string' } }, strict: true })
  if (values.base === undefined) {
    console.error('gates:dco: pass --base <rev>')
    return 2
  }
  const errors = dcoErrors(rangeCommits(repositoryRoot(process.cwd()), values.base))
  for (const error of errors) console.error(`gates:dco: ${error}`)
  if (errors.length > 0) {
    console.error('gates:dco: refused; amend each commit with `git commit --amend -s`, or rebase it with `--signoff`')
    return 1
  }
  console.log(`gates:dco: every commit in ${values.base}..HEAD is signed off by its author`)
  return 0
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2))
}
