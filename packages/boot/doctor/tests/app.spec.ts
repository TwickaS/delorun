import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import DoctorRegistry, { type DoctorCheck, type DoctorOutcome } from '../src/index.ts'
import * as App from '../src/app.ts'

const contexts: Context[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
})

/** Mount the registry and the app under a launcher whose readiness fires at once; `config` is the switch and `args` the invocation. */
async function launch(config: App.Config | undefined, checks: readonly DoctorCheck[], args: readonly string[] = []) {
  const ctx = new Context()
  contexts.push(ctx)
  const exit = vi.fn<(code: number) => void>()
  ctx.provide('appExit', exit)
  ctx.provide('cmdlineArgs', { get: () => args } as never)
  ctx.provide('appReady', { onReady: (listener: () => void) => { listener(); return () => undefined } } as never)
  await ctx.plugin(DoctorRegistry, { checkTimeoutMs: 1_000 })
  for (const check of checks) ctx.doctor.register(check)
  await ctx.plugin(App, config)
  return { exit }
}

const check = (id: string, outcome: DoctorOutcome): DoctorCheck => ({ id, title: `Check ${id}`, run: () => Promise.resolve(outcome) })

describe('the doctor app switch', () => {
  it('with the switch off, runs no check, writes one line to stderr and exits 1', async () => {
    const run = vi.fn(() => Promise.resolve({ status: 'pass' as const, detail: 'Fine.' }))
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const { exit } = await launch(undefined, [{ id: 'a', title: 'Check a', run }])
    await vi.waitFor(() => { expect(exit).toHaveBeenCalledWith(1) })
    expect(run).not.toHaveBeenCalled()
    expect(stdout).not.toHaveBeenCalled()
    expect(stderr).toHaveBeenCalledTimes(1)
    expect(String(stderr.mock.calls[0]?.[0])).toMatch(/^dsh doctor: the doctor is switched off in this composition;/)
    expect(String(stderr.mock.calls[0]?.[0])).toContain('set the doctor-app switch `doctor` to true')
  })

  it('with the switch on, prints one line per check and the counts, and exits 0 when none failed', async () => {
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    const { exit } = await launch({ doctor: true }, [check('a', { status: 'pass', detail: 'Fine.' })])
    await vi.waitFor(() => { expect(exit).toHaveBeenCalledWith(0) })
    expect(stdout).toHaveBeenCalledWith('ok    Check a: Fine.\n\n1 passed, 0 warned, 0 failed\n')
  })

  it('answers --help with the usage and runs no check', async () => {
    const run = vi.fn(() => Promise.resolve({ status: 'pass' as const, detail: 'Fine.' }))
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    const { exit } = await launch({ doctor: true }, [{ id: 'a', title: 'Check a', run }], ['--help'])
    await vi.waitFor(() => { expect(exit).toHaveBeenCalledWith(0) })
    expect(run).not.toHaveBeenCalled()
    expect(stdout.mock.calls.map(call => String(call[0])).join('')).toMatch(/^Usage: dsh --profile doctor \[options\]/)
  })

  it('with the switch on, exits 1 when a check failed', async () => {
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    const { exit } = await launch({ doctor: true }, [check('a', { status: 'fail', detail: 'Broken.' })])
    await vi.waitFor(() => { expect(exit).toHaveBeenCalledWith(1) })
  })
})
