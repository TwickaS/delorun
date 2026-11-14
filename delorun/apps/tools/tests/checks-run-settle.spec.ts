/**
 * Every check of a plan settles when a stored pass serves the checks around it, and a plan that cannot settle fails by
 * naming its unsettled checks.
 */
import { describe, expect, it } from 'vitest'
import type { Planned } from '../src/checks/plan.ts'
import { runPlan } from '../src/checks/run.ts'

const check = (id: string, needs: string[] = [], extra: Partial<Planned> = {}): Planned => ({
  id, needs, cpus: 1, memoryBytes: 1, cwd: '.', command: ['true'], environment: {}, reason: 'test', tiers: [], ...extra,
} as Planned)

const served = { keyOf: (planned: Planned) => planned.id, lookup: () => 'local', unitKey: () => '', lookupUnit: () => undefined, store: () => undefined, storeUnit: () => undefined } as never

const options = { root: '.', env: {}, logDir: '.', cpus: 4, memoryBytes: 1024, bail: false, report: () => undefined }

describe('runPlan settles', () => {
  it('a dependent ordered before its cached need', async () => {
    const plan = [check('generate:native'), check('tests:fork', ['generate:native'])]
    const results = await runPlan(plan, { ...options, cache: served, priority: new Map([['tests:fork', 2], ['generate:native', 1]]) })
    expect(results.map(result => [result.id, result.outcome, result.cached])).toEqual([['generate:native', 'passed', true], ['tests:fork', 'passed', true]])
  })

  it('a dependent ordered before its declined need, which it skips', async () => {
    const plan = [check('a', [], { declined: 'no host' }), check('b', ['a'])]
    const results = await runPlan(plan, { ...options, priority: new Map([['b', 2]]) })
    expect(results.map(result => result.outcome)).toEqual(['declined', 'skipped'])
  })

  it('names the checks of a plan that cannot settle', async () => {
    const plan = [check('x', ['y']), check('y', ['x'])]
    await expect(runPlan(plan, options)).rejects.toThrow(/x, y/)
  })
})
