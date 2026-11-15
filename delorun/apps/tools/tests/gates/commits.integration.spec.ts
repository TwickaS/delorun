import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { FRAGMENTS, messageErrors, rangeErrors, type Commit } from '../../src/check-commits.ts'
import { REPO, runTsx, scratchRepo, type Scratch } from './support.ts'

const SIGNED = 'Signed-off-by: Delorun Contributor <contributor@example.com>'
const CHECK = join(REPO, 'delorun/apps/tools/src/check-commits.ts')

/**
 * A commit as the range check reads it.
 * @param sha - the commit id.
 * @param message - the full commit message.
 * @param added - the paths the commit adds.
 * @returns the commit.
 */
function commit(sha: string, message: string, added: readonly string[] = []): Commit {
  return { sha, message, added }
}

describe('a commit message', () => {
  it('passes with a typed subject, an optional scope and a sign-off', () => {
    expect(messageErrors(`feat(tools): narrow upstream changes\n\nBody.\n\n${SIGNED}\n`)).toEqual([])
    expect(messageErrors(`fix!: drop the old base\n\n${SIGNED}`)).toEqual([])
  })

  it('names a subject without a known type, a missing sign-off and a reasonless `Changelog: none`', () => {
    expect(messageErrors(`Update things\n\n${SIGNED}`)).toEqual([expect.stringContaining('is not `type(scope): summary`')])
    expect(messageErrors('docs: a page')).toEqual([expect.stringContaining('Signed-off-by')])
    expect(messageErrors(`chore: tidy\n\nChangelog: none\n${SIGNED}`)).toEqual([expect.stringContaining('needs its reason')])
    expect(messageErrors(`chore: tidy\n\nChangelog: none (tooling only)\n${SIGNED}`)).toEqual([])
  })

  it('ignores git\'s comment lines and exempts merges and reverts from the subject rule', () => {
    expect(messageErrors(`# Please enter the commit message\ndocs: a page\n\n${SIGNED}\n# On branch main`)).toEqual([])
    expect(messageErrors(`Merge branch 'main'\n\n${SIGNED}`)).toEqual([])
    expect(messageErrors(`Revert "feat: a thing"\n\n${SIGNED}`)).toEqual([])
  })
})

describe('a push\'s commits', () => {
  it('pass when the push adds a changelog fragment or every commit says why none is needed', () => {
    expect(rangeErrors([commit('a1', `feat: a thing\n\n${SIGNED}`, [`${FRAGMENTS}a-thing.md`]), commit('b2', `fix: it\n\n${SIGNED}`)])).toEqual([])
    expect(rangeErrors([commit('a1', `test: more\n\nChangelog: none (tests only)\n${SIGNED}`)])).toEqual([])
  })

  it('name each commit with neither a fragment in the push nor a reasoned trailer, and do not count the folder\'s README', () => {
    expect(rangeErrors([commit('a1b2c3d4e5f6', `feat: a thing\n\n${SIGNED}`, [`${FRAGMENTS}README.md`])]))
      .toEqual(['a1b2c3d4e5: no changelog fragment under delorun/changelog/unreleased/ in this push and no `Changelog: none` trailer'])
  })
})

describe('gates:commits from the command line', () => {
  /**
   * Run the commit-message check on one message, as the commit-msg hook does.
   * @param message - the message the hook receives.
   * @returns the exit status and output.
   */
  function hook(message: string): { status: number; output: string } {
    const dir = mkdtempSync(join(tmpdir(), 'delorun-commit-msg-'))
    try {
      const file = join(dir, 'COMMIT_EDITMSG')
      writeFileSync(file, message)
      return runTsx(dir, CHECK, ['--message', file])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  it('refuses a message the commit-msg hook receives without a conventional subject, and accepts a conforming one', () => {
    const refused = hook(`Update things\n\n${SIGNED}\n`)
    expect(refused.status).toBe(1)
    expect(refused.output).toContain('is not `type(scope): summary`')
    expect(hook(`docs: a page\n\n${SIGNED}\nChangelog: none (tooling only)\n`).status).toBe(0)
  }, 60_000)

  it('checks each commit of a range against the trailer rule, with the base the caller names', (test) => {
    const repo: Scratch = scratchRepo(test)
    const base = repo.commit({ 'base.txt': 'base\n' })
    repo.write({ 'unlogged.txt': 'x\n' })
    repo.run(['add', '-A'])
    repo.run(['commit', '-q', '-m', `feat: unlogged\n\n${SIGNED}`])
    const refused = runTsx(repo.root, CHECK, ['--base', base])
    expect(refused.status).toBe(1)
    expect(refused.output).toContain('no changelog fragment under delorun/changelog/unreleased/')

    repo.write({ 'delorun/changelog/unreleased/feat-unlogged.md': 'Unlogged is now logged.\n' })
    repo.run(['add', '-A'])
    repo.run(['commit', '-q', '-m', `docs: add the fragment\n\n${SIGNED}`])
    expect(runTsx(repo.root, CHECK, ['--base', base]).status).toBe(0)
  }, 60_000)
})
