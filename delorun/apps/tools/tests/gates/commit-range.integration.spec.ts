import { describe, expect, it } from 'vitest'
import { rangeCommits } from '../../src/checks/gates/commit-range.ts'
import { ledgerText, scratchRepo, type Scratch } from './support.ts'

/**
 * Add one commit with a given subject, touching a new file.
 * @param repo - the scratch repository.
 * @param subject - the commit subject.
 * @param files - the files the commit writes.
 * @returns the new commit id.
 */
function commitWith(repo: Scratch, subject: string, files: Record<string, string>): string {
  repo.write(files)
  repo.run(['add', '-A'])
  repo.run(['commit', '-q', '-m', subject])
  return repo.run(['rev-parse', 'HEAD'])
}

describe('rangeCommits', () => {
  it('leaves out the commits the pinned upstream commit reaches and keeps Delorun commits on both sides of the merge', (test) => {
    const repo = scratchRepo(test)
    const base = repo.commit({ 'base.txt': 'base\n' })
    repo.run(['switch', '-q', '-c', 'upstream'])
    const upstream = commitWith(repo, 'upstream: its own commit', { 'upstream.txt': 'u\n' })
    repo.run(['switch', '-q', 'main'])
    const before = commitWith(repo, 'feat: before the merge', { 'delorun/upstream-patches.json': ledgerText(upstream) })
    repo.run(['merge', '-q', '--no-ff', '-m', 'merge upstream', 'upstream'])
    const after = commitWith(repo, 'feat: after the merge', { 'after.txt': 'a\n' })

    expect(rangeCommits(repo.root, base).map(commit => commit.sha)).toEqual([before, after])
  }, 60_000)

  it('reads every non-merge commit when the repository holds no ledger', (test) => {
    const repo = scratchRepo(test)
    const base = repo.commit({ 'base.txt': 'base\n' })
    const first = commitWith(repo, 'feat: first', { 'first.txt': 'f\n' })

    expect(rangeCommits(repo.root, base).map(commit => commit.sha)).toEqual([first])
  }, 60_000)
})
