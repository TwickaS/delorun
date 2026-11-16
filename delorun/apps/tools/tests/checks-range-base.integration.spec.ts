/**
 * The runner against the repository it runs in: a range base that names no commit stops the run before any check
 * starts, and one that does is accepted.
 */
import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { REPO } from './gates/support.ts'

/**
 * Plans the range gates with the environment's range base.
 * @param rangeBase - the value of `DELORUN_RANGE_BASE`.
 * @returns the exit status and both output streams.
 */
function plan(rangeBase: string): { status: number | null, stdout: string, stderr: string } {
  const run = spawnSync('node_modules/.bin/tsx', ['delorun/apps/tools/src/run-checks.ts', '--plan', '--only', 'gates:dco,gates:commits'], {
    cwd: REPO,
    encoding: 'utf8',
    timeout: 120_000,
    env: { ...process.env, DELORUN_RANGE_BASE: rangeBase },
  })
  return { status: run.status, stdout: run.stdout, stderr: run.stderr }
}

describe('DELORUN_RANGE_BASE', () => {
  it('refuses a base that is not a commit, naming the ref, before any check is planned', () => {
    const run = plan('does-not-exist')
    expect(run.status).not.toBe(0)
    expect(run.stderr).toContain('the range base does-not-exist is not a commit in this clone; fetch it, or set DELORUN_RANGE_BASE to a commit')
    expect(run.stdout).not.toContain('gates:dco')
  })

  it('plans the range gates once the base is a commit, and puts the base into their commands', () => {
    const run = plan('HEAD')
    expect(run.status).toBe(0)
    expect(run.stdout).toMatch(/dco\.ts --base HEAD/)
  })
})
