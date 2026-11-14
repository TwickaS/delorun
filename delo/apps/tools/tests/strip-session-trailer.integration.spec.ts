import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { renderReport, rewriteBranch, stripTrailer } from '../src/history/strip-session-trailer.ts'
import { scratchRepo, type Scratch } from './gates/support.ts'

const TRAILER_LINE = 'Claude-Session: https://claude.ai/code/session_x'

/** Commit with a message, optionally on top of the current branch. */
function commitWith(repo: Scratch, file: string, message: string): string {
  repo.write({ [file]: `${file}\n` })
  repo.run(['add', '-A'])
  repo.run(['commit', '-q', '-m', message])
  return repo.run(['rev-parse', 'HEAD'])
}

describe('stripTrailer', () => {
  it('removes the trailer and the blank line it leaves, and keeps other trailers', () => {
    expect(stripTrailer(`feat: x\n\nbody\n\nSigned-off-by: A <a@b.c>\n\n${TRAILER_LINE}\n`)).toBe('feat: x\n\nbody\n\nSigned-off-by: A <a@b.c>\n')
    expect(stripTrailer(`feat: x\n\n${TRAILER_LINE}\nCo-Authored-By: B <b@c.d>\n`)).toBe('feat: x\n\nCo-Authored-By: B <b@c.d>\n')
  })

  it('returns a message without the trailer unchanged', () => {
    expect(stripTrailer('feat: x\n\nbody')).toBe('feat: x\n\nbody')
  })
})

describe('rewriteBranch', () => {
  /** An upstream commit with a signature header, a branch on it, and a merge. */
  function history(test: Parameters<typeof scratchRepo>[0]): { repo: Scratch; upstream: string } {
    const repo = scratchRepo(test)
    const base = commitWith(repo, 'base.txt', 'upstream: base')
    const tree = repo.run(['rev-parse', `${base}^{tree}`])
    const signed = `tree ${tree}\nparent ${base}\nauthor Up <up@example.test> 1700000000 +0000\ncommitter Up <up@example.test> 1700000000 +0000\ngpgsig -----BEGIN PGP SIGNATURE-----\n \n abc\n -----END PGP SIGNATURE-----\n\nupstream: signed\n\n${TRAILER_LINE}\n`
    const upstream = execFileSync('git', ['hash-object', '-t', 'commit', '-w', '--stdin'], { cwd: repo.root, input: signed, encoding: 'utf8', timeout: 30_000 }).trim()
    repo.run(['update-ref', 'refs/remotes/upstream/main', upstream])
    repo.run(['reset', '-q', '--hard', upstream])
    return { repo, upstream }
  }

  it('strips trailers below upstream, keeps trees, parents, merges and upstream hashes', test => {
    const { repo, upstream } = history(test)
    repo.run(['checkout', '-q', '-b', 'work'])
    commitWith(repo, 'a.txt', `feat: a\n\n${TRAILER_LINE}`)
    repo.run(['checkout', '-q', '-b', 'side', upstream])
    commitWith(repo, 'b.txt', `feat: b\n\n${TRAILER_LINE}`)
    repo.run(['checkout', '-q', 'work'])
    repo.run(['merge', '-q', '--no-ff', 'side', '-m', `merge side\n\n${TRAILER_LINE}`])
    commitWith(repo, 'c.txt', 'feat: c\n\nSigned-off-by: A <a@b.c>')
    const oldTree = repo.run(['rev-parse', 'work^{tree}'])
    const report = rewriteBranch(repo.root, 'work', [], true)
    expect(report.problems).toEqual([])
    expect(report.strippedMessages).toBe(3)
    expect(report.rewrittenCommits).toBe(4)
    expect(report.upstreamCommits).toBe(2)
    expect(report.applied).toBe(true)
    expect(repo.run(['rev-parse', 'work^{tree}'])).toBe(oldTree)
    expect(repo.run(['log', '--format=%B', 'work', `^${upstream}`])).not.toContain('Claude-Session')
    expect(repo.run(['rev-list', '--merges', '--count', `${upstream}..work`])).toBe('1')
    expect(() => repo.run(['merge-base', '--is-ancestor', upstream, 'work'])).not.toThrow()
    expect(repo.run(['show', '-s', '--format=%B', upstream])).toContain('Claude-Session')
    expect(renderReport(report)).toContain('verification: passed')
  })

  it('writes nothing to the ref on a dry run', test => {
    const { repo, upstream } = history(test)
    repo.run(['checkout', '-q', '-b', 'work'])
    const tip = commitWith(repo, 'a.txt', `feat: a\n\n${TRAILER_LINE}`)
    const report = rewriteBranch(repo.root, 'work', [], false)
    expect(report.applied).toBe(false)
    expect(repo.run(['rev-parse', 'work'])).toBe(tip)
    expect(repo.run(['rev-parse', upstream])).toBe(upstream)
  })
})
