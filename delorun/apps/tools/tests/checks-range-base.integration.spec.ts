/**
 * The runner against the repository it runs in: a range base that names no commit stops a run before any check
 * starts, one that does is accepted, and a plan prints whatever the base.
 */
import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { REPO } from './gates/support.ts'

/**
 * Runs the runner on the range gates with the environment's range base.
 * @param args - the runner's arguments before the `--only` selection.
 * @param rangeBase - the value of `DELORUN_RANGE_BASE`.
 * @returns the exit status and both output streams.
 */
function runner(args: readonly string[], rangeBase: string): { status: number | null, stdout: string, stderr: string } {
  const run = spawnSync('node_modules/.bin/tsx', ['delorun/apps/tools/src/run-checks.ts', ...args, '--only', 'gates:dco,gates:commits'], {
    cwd: REPO,
    encoding: 'utf8',
    timeout: 120_000,
    env: { ...process.env, DELORUN_RANGE_BASE: rangeBase },
  })
  return { status: run.status, stdout: run.stdout, stderr: run.stderr }
}

describe('DELORUN_RANGE_BASE', () => {
  it('refuses a run whose base is not a commit, naming the ref, before any check starts', () => {
    const run = runner(['--no-cache'], 'does-not-exist')
    expect(run.status).not.toBe(0)
    expect(run.stderr).toContain('the range base does-not-exist is not a commit in this clone; fetch it, or set DELORUN_RANGE_BASE to a commit')
    expect(run.stdout).not.toContain('gates:dco')
  })

  it('prints the plan whatever the base, since a plan runs nothing', () => {
    const run = runner(['--plan'], 'does-not-exist')
    expect(run.status).toBe(0)
    expect(run.stdout).toMatch(/dco\.ts --base does-not-exist/)
  })

  it('plans the range gates once the base is a commit, and puts the base into their commands', () => {
    const run = runner(['--plan'], 'HEAD')
    expect(run.status).toBe(0)
    expect(run.stdout).toMatch(/dco\.ts --base HEAD/)
  })
})
