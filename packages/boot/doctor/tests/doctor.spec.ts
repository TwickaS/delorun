import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import DoctorRegistry, { type DoctorCheck } from '../src/index.ts'
import * as Checks from '../src/checks.ts'
import { nodeOutcome } from '../src/checks.ts'
import { report } from '../src/app.ts'

const contexts: Context[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
})

async function registry(checkTimeoutMs = 10_000): Promise<Context> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(DoctorRegistry, { checkTimeoutMs })
  return ctx
}

const check = (id: string, run: DoctorCheck['run']): DoctorCheck => ({ id, title: `Check ${id}`, run })

describe('the doctor registry', () => {
  it('runs every check and reports them in registration order', async () => {
    const ctx = await registry()
    ctx.doctor.register(check('b', () => Promise.resolve({ status: 'warn', detail: 'B warned.' })))
    ctx.doctor.register(check('a', () => Promise.resolve({ status: 'pass', detail: 'A passed.' })))
    expect(await ctx.doctor.run(new AbortController().signal)).toEqual([
      { id: 'b', title: 'Check b', status: 'warn', detail: 'B warned.' },
      { id: 'a', title: 'Check a', status: 'pass', detail: 'A passed.' },
    ])
  })

  it('reports a check that throws or outlives its deadline as failed, without holding the others', async () => {
    const ctx = await registry(50)
    ctx.doctor.register(check('throws', () => Promise.reject(new Error('no disk'))))
    ctx.doctor.register(check('hangs', signal => new Promise((_resolve, reject) => { signal.addEventListener('abort', () => { reject(signal.reason) }) })))
    ctx.doctor.register(check('fine', () => Promise.resolve({ status: 'pass', detail: 'Fine.' })))
    expect(await ctx.doctor.run(new AbortController().signal)).toEqual([
      { id: 'throws', title: 'Check throws', status: 'fail', detail: 'it stopped with an error: no disk' },
      { id: 'hangs', title: 'Check hangs', status: 'fail', detail: 'it did not finish within 50 ms' },
      { id: 'fine', title: 'Check fine', status: 'pass', detail: 'Fine.' },
    ])
  })

  it('ends the run when the caller cancels it', async () => {
    const ctx = await registry()
    const controller = new AbortController()
    ctx.doctor.register(check('waits', signal => new Promise((_resolve, reject) => { signal.addEventListener('abort', () => { reject(signal.reason) }) })))
    const running = ctx.doctor.run(controller.signal)
    controller.abort(new Error('stopped'))
    await expect(running).rejects.toThrow('stopped')
  })

  it('refuses a second check with the same id, and removes a check with its plugin', async () => {
    const ctx = await registry()
    const fiber = await ctx.plugin({ inject: ['doctor'], apply: (child: Context) => { child.doctor.register(check('owned', () => Promise.resolve({ status: 'pass', detail: 'Owned.' }))) } })
    expect(() => ctx.doctor.register(check('owned', () => Promise.resolve({ status: 'pass', detail: 'Again.' })))).toThrow('a check with id "owned" is already registered')
    await fiber.dispose()
    expect(await ctx.doctor.run(new AbortController().signal)).toEqual([])
  })
})

describe('the shipped checks', () => {
  it('passes a supported Node.js and fails one outside the range', () => {
    expect(nodeOutcome('24.9.0')).toEqual({ status: 'pass', detail: 'Node.js 24.9.0 is in the supported range >=24.9.0.' })
    expect(nodeOutcome('22.19.0')).toEqual({ status: 'fail', detail: 'Node.js 22.19.0 is outside the supported range >=24.9.0; install a supported version.' })
  })

  it('warns that commands run unconfined when the composition has no sandbox', async () => {
    const ctx = await registry()
    await ctx.plugin(Checks)
    const results = await ctx.doctor.run(new AbortController().signal)
    expect(results.map(result => result.id)).toEqual(['node-version', 'sandbox-enforcement'])
    expect(results[1]).toMatchObject({ status: 'warn', detail: 'This composition has no sandbox, so commands run unconfined.' })
  })

  it('warns when the sandbox enforces the mode only in part, and passes when in full', async () => {
    for (const [enforcement, status] of [['partial', 'warn'], ['full', 'pass']] as const) {
      const ctx = await registry()
      ctx.provide('sandboxPolicy', { resolve: () => ({ mode: 'workspace-write', workspaceRoot: '/work' }) } as never)
      ctx.provide('sandbox', { confine: (argv: readonly string[]) => Promise.resolve({ argv, enforcement, runnerFailureRules: [] }) } as never)
      await ctx.plugin(Checks)
      const sandbox = (await ctx.doctor.run(new AbortController().signal)).find(result => result.id === 'sandbox-enforcement')
      expect(sandbox?.status).toBe(status)
    }
  })
})

describe('the doctor report', () => {
  it('prints one line per check and the counts', () => {
    expect(report([
      { id: 'a', title: 'Node.js version', status: 'pass', detail: 'Fine.' },
      { id: 'b', title: 'Command sandbox', status: 'warn', detail: 'Partial.' },
      { id: 'c', title: 'Disk', status: 'fail', detail: 'Full.' },
    ])).toBe('ok    Node.js version: Fine.\nwarn  Command sandbox: Partial.\nFAIL  Disk: Full.\n\n1 passed, 1 warned, 1 failed\n')
  })
})
