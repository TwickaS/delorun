/**
 * The candidate's git steps against a temporary repository, and the failures a stand-in git port reports: a branch that
 * is not one, a git step that fails, and a cherry-pick that fails without a conflict.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { applyLane, currentBranch, gitText, inspectLane, isClean, laneTip, type Git } from '../../src/batch/candidate.ts'
import { BatchError } from '../../src/batch/errors.ts'
import { processPorts } from '../../src/batch/process.ts'
import type { ProcessRun } from '../../src/batch/process.ts'
import { cleanUp, fakeExec, git, gitEnv, makeSandbox } from './fixtures.ts'

afterEach(cleanUp)

const SHA = 'b'.repeat(40)

/**
 * A git port that answers each command from a table, by its first argument, and records the commands.
 * @param answers - the outcome by git subcommand; any other succeeds with empty output.
 * @returns the port and its record.
 */
function scripted(answers: Readonly<Record<string, Partial<ProcessRun>>>): { git: Git, seen: string[] } {
  const seen: string[] = []
  return {
    seen,
    git: args => {
      seen.push(args.join(' '))
      return { status: 0, stdout: '', stderr: '', ...answers[args[0] ?? ''] }
    },
  }
}

describe('with a repository', () => {
  it('finds a lane\'s range, its branch and whether the worktree is clean', { timeout: 20_000 }, () => {
    const sandbox = makeSandbox()
    const tip = sandbox.lane('lane/a', [{ files: { 'a.txt': 'a\n' }, message: 'feat: a' }])
    const ports = processPorts(fakeExec(sandbox.root, []).exec, sandbox.root, gitEnv())
    const start = git(sandbox.root, ['rev-parse', 'origin/v5']).trim()
    expect(laneTip(ports.git, 'lane/a')).toBe(tip)
    expect(inspectLane(ports.git, 'lane/a', tip, start)).toEqual({ name: 'lane/a', tip, base: start, commits: [tip], merges: [] })
    expect(currentBranch(ports.git)).toBe('v5')
    expect(isClean(ports.git)).toBe(true)
    sandbox.write({ 'stray.txt': 'x' })
    expect(isClean(ports.git)).toBe(false)
    git(sandbox.root, ['checkout', '-q', '--detach'])
    expect(currentBranch(ports.git)).toBeUndefined()
    expect(() => laneTip(ports.git, 'lane..bad')).toThrow(BatchError)
  })
})

describe('with a stand-in git', () => {
  it('reports a failing git step with its command and error text', () => {
    const { git: port } = scripted({ status: { status: 128, stderr: 'fatal: no\n' } })
    expect(() => gitText(port, ['status'])).toThrow('git status exited 128: fatal: no')
  })

  it('sets aside a lane whose cherry-pick fails without a conflict and leaves HEAD where it was', () => {
    const { git: port, seen } = scripted({
      'rev-parse': { stdout: `${SHA}\n` },
      'cherry-pick': { status: 1, stderr: 'error: could not apply\nhint: more\n' },
      status: { stdout: ' M a.txt\n' },
    })
    expect(applyLane(port, { name: 'l', tip: SHA, base: SHA, commits: [SHA], merges: [] })).toEqual({ kind: 'set-aside', reason: { kind: 'pick-failed', commit: SHA, detail: 'error: could not apply' } })
    expect(seen.slice(-2)).toEqual(['cherry-pick --abort', `reset --quiet --hard ${SHA}`])
  })

  it('names the exit status of a cherry-pick that failed silently', () => {
    const { git: port } = scripted({ 'rev-parse': { stdout: `${SHA}\n` }, 'cherry-pick': { status: 1 }, status: { stdout: '?? x\n' } })
    expect(applyLane(port, { name: 'l', tip: SHA, base: SHA, commits: [SHA], merges: [] })).toEqual({ kind: 'set-aside', reason: { kind: 'pick-failed', commit: SHA, detail: 'exit 1' } })
  })
})
