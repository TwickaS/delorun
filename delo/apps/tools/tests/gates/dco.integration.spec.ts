import { describe, expect, it, type TestContext } from 'vitest'
import { dcoErrors, signOffsOf } from '../../src/checks/gates/dco.ts'
import type { RangeCommit } from '../../src/checks/gates/commit-range.ts'
import { gatePath, runTsx, scratchRepo, type Scratch } from './support.ts'

const AUTHOR = { name: 'Ivo Quillfeather', email: 'ivo@example.test' }

/**
 * Add one commit with a given author and message, touching a new file.
 * @param repo - the scratch repository.
 * @param author - the author the commit records.
 * @param message - the full commit message.
 * @param file - the file the commit adds.
 */
function commitAs(repo: Scratch, author: string, message: string, file: string): void {
  repo.write({ [file]: `${file}\n` })
  repo.run(['add', '-A'])
  repo.run(['commit', '-q', '--author', author, '-m', message])
}

/**
 * A scratch repository with one base commit, the start of the range the gate checks.
 * @param test - the running test.
 * @returns the repository and the base commit.
 */
function baseRepo(test: TestContext): { repo: Scratch; base: string } {
  const repo = scratchRepo(test)
  const base = repo.commit({ 'base.txt': 'base\n' })
  return { repo, base }
}

describe('gates:dco', () => {
  it('reads each Signed-off-by line as a name and an email', () => {
    expect(signOffsOf('Subject\n\nSigned-off-by: Quill Pseudonym <quill@example.test>\n'))
      .toEqual([{ name: 'Quill Pseudonym', email: 'quill@example.test' }])
  })

  it('accepts a sign-off that matches the author, including a pseudonymous one, and an email in another case', () => {
    const commit = (author: { name: string; email: string }, message: string): RangeCommit => ({
      sha: 'a'.repeat(40),
      author,
      committer: author,
      message,
      added: [],
    })
    expect(dcoErrors([commit(AUTHOR, `feat: a\n\nSigned-off-by: ${AUTHOR.name} <${AUTHOR.email}>\n`)])).toEqual([])
    expect(dcoErrors([commit({ name: 'Quill', email: 'quill@example.test' }, 'feat: a\n\nSigned-off-by: Quill <Quill@Example.test>\n')])).toEqual([])
  })

  it('refuses a commit without a sign-off, and one whose sign-off names another person', () => {
    const commit = (message: string): RangeCommit => ({ sha: 'b'.repeat(40), author: AUTHOR, committer: AUTHOR, message, added: [] })
    expect(dcoErrors([commit('feat: a\n')])).toEqual([`bbbbbbbbbb: no Signed-off-by line names the author ${AUTHOR.name} <${AUTHOR.email}>`])
    expect(dcoErrors([commit('feat: a\n\nSigned-off-by: Someone Else <other@example.test>\n')])).toHaveLength(1)
  })

  it('exits 1 naming the commit that lacks a matching sign-off, and 0 when every commit has one', (test) => {
    const bad = baseRepo(test)
    commitAs(bad.repo, `${AUTHOR.name} <${AUTHOR.email}>`, 'feat: unsigned\n', 'unsigned.txt')
    const failed = runTsx(bad.repo.root, gatePath('dco'), ['--base', bad.base])
    expect(failed.status).toBe(1)
    expect(failed.output).toContain('gates:dco: ')
    expect(failed.output).toContain(`no Signed-off-by line names the author ${AUTHOR.name}`)

    const good = baseRepo(test)
    commitAs(good.repo, `${AUTHOR.name} <${AUTHOR.email}>`, `feat: signed\n\nSigned-off-by: ${AUTHOR.name} <${AUTHOR.email}>\n`, 'signed.txt')
    expect(runTsx(good.repo.root, gatePath('dco'), ['--base', good.base]).status).toBe(0)
  }, 60_000)
})
