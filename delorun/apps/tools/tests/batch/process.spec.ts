/**
 * The batch's process guard: every argument and variable that would let a commit reach the trunk without the merge tier is
 * refused before a process starts, the runner's overrides never reach a process, and the push always runs the merge tier.
 */
import { describe, expect, it, vi } from 'vitest'
import { BatchError } from '../../src/batch/errors.ts'
import { assertGated, childEnvironment, processPorts, RUN_CHECKS, spawnExec, TSX, type Exec } from '../../src/batch/process.ts'

describe('assertGated', () => {
  it.each([
    [['push', '--force', 'origin', 'x']],
    [['push', '-f', 'origin', 'x']],
    [['push', '--force-with-lease', 'origin', 'x']],
    [['push', '--force-with-lease=v5:abc', 'origin', 'x']],
    [['push', '--force-if-includes', 'origin', 'x']],
    [['push', '--no-verify', 'origin', 'x']],
    [['push', 'origin', '+batch/1:refs/heads/v5']],
    [['--changed', '--tier', 'agent']],
    [['--changed', '--tier=agent']],
    [['--changed', '--tier', 'lane']],
    [['--changed', '--tier=lane']],
    [['--changed', '--skip', 'tests']],
    [['--changed', '--skip=tests:fork']],
    [['-c', 'core.hooksPath=/dev/null', 'push']],
    [['-c', 'CORE.hookspath=/dev/null', 'push']],
    [['-ccore.hooksPath=/dev/null', 'push']],
    [['-c', '--config-env=core.hooksPath=X', 'push']],
    [['--config-env=core.hooksPath=X', 'push']],
  ])('refuses %j', args => {
    expect(() => { assertGated(args, {}) }).toThrow(BatchError)
  })

  it('refuses skipped checks and the agent tier in the environment', () => {
    expect(() => { assertGated(['push'], { DELORUN_PUSH_SKIP: '' }) }).toThrow(/DELORUN_PUSH_SKIP/)
    expect(() => { assertGated(['push'], { DELORUN_TIER: 'agent' }) }).toThrow(/DELORUN_TIER=agent/)
    expect(() => { assertGated(['push'], { DELORUN_TIER: 'lane' }) }).toThrow(/DELORUN_TIER=lane/)
  })

  it.each([
    [{ LEFTHOOK: '0' }, 'LEFTHOOK'],
    [{ LEFTHOOK_EXCLUDE: 'pre-push' }, 'LEFTHOOK_EXCLUDE'],
    [{ LEFTHOOK_BIN: '/bin/true' }, 'LEFTHOOK_BIN'],
    [{ GIT_CONFIG_COUNT: '1' }, 'GIT_CONFIG_COUNT'],
    [{ GIT_CONFIG_KEY_0: 'core.hooksPath' }, 'GIT_CONFIG_KEY_0'],
    [{ GIT_CONFIG_PARAMETERS: 'x' }, 'GIT_CONFIG_PARAMETERS'],
    [{ GIT_CONFIG_GLOBAL: '/dev/null' }, 'GIT_CONFIG_GLOBAL'],
    [{ GIT_CONFIG_SYSTEM: '/dev/null' }, 'GIT_CONFIG_SYSTEM'],
    [{ GIT_CONFIG_NOSYSTEM: '1' }, 'GIT_CONFIG_NOSYSTEM'],
  ])('refuses the hook variable %j', (env, name) => {
    expect(() => { assertGated(['push'], env) }).toThrow(name)
  })

  it('lets the merge tier and ordinary git through', () => {
    expect(() => { assertGated(['--changed', '--tier', 'merge'], { DELORUN_TIER: 'merge' }) }).not.toThrow()
    expect(() => { assertGated(['push', 'origin', 'batch/1:refs/heads/v5'], {}) }).not.toThrow()
    expect(() => { assertGated(['--tier'], {}) }).not.toThrow()
    expect(() => { assertGated(['-c', 'user.name=x', 'commit'], { LEFTHOOK: '1', GIT_DIR: '.git' }) }).not.toThrow()
    expect(() => { assertGated(['commit'], { LEFTHOOK: 'true' }) }).not.toThrow()
    expect(() => { assertGated(['-c'], {}) }).not.toThrow()
    expect(() => { assertGated(['cherry-pick', '--skip'], {}) }).not.toThrow()
  })
})

describe('processPorts', () => {
  it('removes the runner\'s overrides, runs the merge tier on the push and refuses before starting a forbidden process', () => {
    const exec = vi.fn<Exec>(() => ({ status: 0, stdout: 'out', stderr: '' }))
    const ports = processPorts(exec, '/repo', { PATH: '/bin', DELORUN_PUSH_SKIP: 'tests', DELORUN_TIER: 'agent', LEFTHOOK: '1', LEFTHOOK_EXCLUDE: 'x', LEFTHOOK_BIN: 'y', GIT_CONFIG_COUNT: '1', GIT_CONFIG_GLOBAL: '/dev/null' })
    expect(ports.git(['status'])).toEqual({ status: 0, stdout: 'out', stderr: '' })
    expect(exec).toHaveBeenLastCalledWith('git', ['status'], { cwd: '/repo', env: { PATH: '/bin' }, output: 'capture' })
    expect(ports.checks(['--changed'])).toBe(0)
    expect(exec).toHaveBeenLastCalledWith(TSX, [RUN_CHECKS, '--changed'], { cwd: '/repo', env: { PATH: '/bin' }, output: 'show' })
    ports.push('origin', 'batch/1:refs/heads/v5')
    expect(exec).toHaveBeenLastCalledWith('git', ['push', 'origin', 'batch/1:refs/heads/v5'], { cwd: '/repo', env: { PATH: '/bin', DELORUN_TIER: 'merge' }, output: 'show' })
    exec.mockClear()
    expect(() => ports.push('origin', '+batch/1:refs/heads/v5')).toThrow(BatchError)
    expect(() => ports.git(['push', '--force'])).toThrow(BatchError)
    expect(() => ports.checks(['--tier', 'agent'])).toThrow(BatchError)
    expect(exec).not.toHaveBeenCalled()
  })

  it('reports a check runner stopped by a signal as a failure', () => {
    const ports = processPorts(() => ({ status: null, stdout: '', stderr: '' }), '/repo', {})
    expect(ports.checks([])).toBe(1)
  })

  it('keeps the integrator\'s other variables', () => {
    expect(childEnvironment({ HOME: '/h', DELORUN_FULL_GATE: '1', DELORUN_TIER: 'merge' })).toEqual({ HOME: '/h', DELORUN_FULL_GATE: '1' })
  })
})

describe('spawnExec', () => {
  it('captures both streams, or shows standard output and keeps standard error', () => {
    const env = { PATH: process.env['PATH'] ?? '' }
    expect(spawnExec('git', ['--version'], { cwd: process.cwd(), env, output: 'capture' }).stdout).toMatch(/^git version/)
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const shown = spawnExec('git', ['--no-such-option'], { cwd: process.cwd(), env, output: 'show' })
    expect(shown.stdout).toBe('')
    expect(shown.stderr).toContain('no-such-option')
    expect(write).toHaveBeenCalledWith(shown.stderr)
    write.mockRestore()
  })

  it('throws when the program cannot start', () => {
    expect(() => spawnExec('delorun-no-such-program', [], { cwd: process.cwd(), env: {}, output: 'capture' })).toThrow(/ENOENT/)
  })
})
