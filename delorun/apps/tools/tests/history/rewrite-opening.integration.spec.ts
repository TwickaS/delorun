/**
 * The opening rewrite on a small repository: private strings leave file contents and messages, trailer lines and label
 * citations go, upstream's commit keeps its hash, and the tip tree stays the same when the text was removed again.
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { applyReplacements, leftoverLabels, removeLabelCitations, rewriteForOpening, stripTrailer } from '../../src/history/rewrite-opening.ts'

const scratch: string[] = []
afterEach(() => { for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true }) })

const git = (cwd: string, ...args: string[]): string => execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@delorun.com', ...args], { cwd, encoding: 'utf8', timeout: 30_000 }).trim()

/** A repository with one upstream-tagged commit, then two own commits; the second one removes the private path again. */
function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'delorun-opening-'))
  scratch.push(root)
  git(root, 'init', '-q', '-b', 'main')
  mkdirSync(join(root, 'sub'))
  writeFileSync(join(root, 'sub', 'a.txt'), 'upstream\n')
  git(root, 'add', '.'); git(root, 'commit', '-q', '-m', 'upstream')
  git(root, 'tag', 'dsh-v0.0.1')
  writeFileSync(join(root, 'sub', 'a.txt'), 'path /home/someone-private/x\n')
  git(root, 'add', '.'); git(root, 'commit', '-q', '-m', 'add (A381)\n\nSees /home/someone-private here.\n\nClaude-Session: https://example.test/s')
  writeFileSync(join(root, 'sub', 'a.txt'), 'clean\n')
  git(root, 'add', '.'); git(root, 'commit', '-q', '-m', 'clean up')
  return root
}

describe('rewriteForOpening', () => {
  it('replaces text in files and messages, keeps upstream hashes and the tip tree, and verifies', () => {
    const root = fixture()
    const upstream = git(root, 'rev-parse', 'dsh-v0.0.1')
    const report = rewriteForOpening(root, 'main', 'opening', [], [{ from: '/home/someone-private', to: '/home/user' }], true)
    expect(report.problems).toEqual([])
    expect(report.totalCommits).toBe(3)
    expect(report.upstreamCommits).toBe(1)
    expect(report.rewrittenCommits).toBe(2)
    expect(report.strippedTrailers).toBe(1)
    expect(report.changedTrees).toBe(1)
    expect(report.changedFiles.map(file => file.path)).toEqual(['sub/a.txt'])
    expect(git(root, 'rev-parse', 'main^{tree}')).toBe(git(root, 'rev-parse', 'opening^{tree}'))
    expect(git(root, 'merge-base', '--is-ancestor', upstream, 'opening')).toBe('')
    const message = git(root, 'log', '--format=%B', 'opening~1')
    expect(message).toContain('/home/user')
    expect(message).not.toContain('Claude-Session')
    expect(git(root, 'log', '-1', '--format=%s', 'opening~1')).toBe('add')
    expect(git(root, 'show', 'opening~1:sub/a.txt')).toBe('path /home/user/x')
  })
})

describe('text helpers', () => {
  it('applies longer replacements first when given in that order and leaves other text alone', () => {
    expect(applyReplacements('a/home/x b', [{ from: '/home/x', to: '/home/user' }])).toBe('a/home/user b')
  })

  it('strips trailer lines and the blank lines they leave', () => {
    expect(stripTrailer('s\n\nbody\n\nClaude-Session: u\n')).toBe('s\n\nbody\n')
    expect(stripTrailer('s\n')).toBe('s\n')
  })

  it('removes label citations in parentheses and reports bare labels', () => {
    expect(removeLabelCitations('fix thing (A381)\n')).toBe('fix thing\n')
    expect(removeLabelCitations('fix (owner ruling A443, A380)\n')).toBe('fix\n')
    expect(removeLabelCitations('keep (see docs)\n')).toBe('keep (see docs)\n')
    expect(leftoverLabels('the A381 ruling and Wave 2')).toEqual(['A381', 'Wave 2'])
  })
})
