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
  ])('refuses %j', args => {
    expect(() => { assertGated(args, {}) }).toThrow(BatchError)
  })

  it('refuses skipped checks and the agent tier in the environment', () => {
    expect(() => { assertGated(['push'], { DELO_PUSH_SKIP: '' }) }).toThrow(/DELO_PUSH_SKIP/)
    expect(() => { assertGated(['push'], { DELO_TIER: 'agent' }) }).toThrow(/DELO_TIER=agent/)
    expect(() => { assertGated(['push'], { DELO_TIER: 'lane' }) }).toThrow(/DELO_TIER=lane/)
  })

  it('lets the merge tier and ordinary git through', () => {
    expect(() => { assertGated(['--changed', '--tier', 'merge'], { DELO_TIER: 'merge' }) }).not.toThrow()
    expect(() => { assertGated(['push', 'origin', 'batch/1:refs/heads/v5'], {}) }).not.toThrow()
    expect(() => { assertGated(['--tier'], {}) }).not.toThrow()
  })
})

describe('processPorts', () => {
  it('removes the runner\'s overrides, runs the merge tier on the push and refuses before starting a forbidden process', () => {
    const exec = vi.fn<Exec>(() => ({ status: 0, stdout: 'out', stderr: '' }))
    const ports = processPorts(exec, '/repo', { PATH: '/bin', DELO_PUSH_SKIP: 'tests', DELO_TIER: 'agent' })
    expect(ports.git(['status'])).toEqual({ status: 0, stdout: 'out', stderr: '' })
    expect(exec).toHaveBeenLastCalledWith('git', ['status'], { cwd: '/repo', env: { PATH: '/bin' }, output: 'capture' })
    expect(ports.checks(['--changed'])).toBe(0)
    expect(exec).toHaveBeenLastCalledWith(TSX, [RUN_CHECKS, '--changed'], { cwd: '/repo', env: { PATH: '/bin' }, output: 'show' })
    ports.push('origin', 'batch/1:refs/heads/v5')
    expect(exec).toHaveBeenLastCalledWith('git', ['push', 'origin', 'batch/1:refs/heads/v5'], { cwd: '/repo', env: { PATH: '/bin', DELO_TIER: 'merge' }, output: 'show' })
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
    expect(childEnvironment({ HOME: '/h', DELO_FULL_GATE: '1', DELO_TIER: 'merge' })).toEqual({ HOME: '/h', DELO_FULL_GATE: '1' })
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
    expect(() => spawnExec('delo-no-such-program', [], { cwd: process.cwd(), env: {}, output: 'capture' })).toThrow(/ENOENT/)
  })
})
