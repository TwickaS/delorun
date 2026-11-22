/**
 * The native system addon in the check graph: the lanes that run a suite upstream prepares with `build:native-system`
 * declare that build as their need, so a fresh worktree that ran `setup-worktree.ts` builds the addon in the run that
 * first needs it instead of failing every scenario with `Cannot find module …/system.node`.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { catalog, NATIVE_CHECK_ID, select, type Budgets, type ForkTree, type Host, type Planned, type Selection } from '../src/checks/plan.ts'

const BUDGETS = JSON.parse(readFileSync(new URL('../src/checks/budgets.json', import.meta.url), 'utf8')) as Budgets
const TREE: ForkTree = {
  packages: [
    { name: '@delorun/control', dir: 'delorun/apps/control', forkDependencies: [], upstreamDependencies: [], ownWorkspace: false },
  ],
  programs: [{ config: 'delorun/apps/control/tsconfig.json' }],
  upstream: [
    { name: '@deepseek-ai/dsh-session', dir: 'packages/core/session', dependencies: [], runtimeDependencies: [], specs: 12 },
  ],
}
const HOST: Host = { workers: { fork: 4, upstream: 4 }, cacheDir: 'node_modules/.cache/delorun-checks', budgets: BUDGETS, staleRuntime: [], gates: [] }
const CHECKS = catalog(TREE, HOST)
const NONE: Selection = { targets: [], only: [], skip: [] }
/**
 * The lanes that run a suite whose upstream script is `pnpm run build:native-system && vitest run`, or the snapshot
 * suite that upstream's own gate runs after the whole build. The changed-upstream lane is upstream's unit gate, which
 * declares `needs: ['native-system']` in `scripts/run-gates.ts`.
 */
const UPSTREAM_SUITE_LANES = ['tests:snapshots', 'tests:fork', 'tests:fork:integration', 'parity-replay', 'parity-replay:control', 'tests:upstream-changed']

/**
 * A check's needs.
 * @param id - the check id.
 * @returns its needs, in order.
 */
function needs(id: string): readonly string[] {
  return CHECKS.find(check => check.id === id)?.needs ?? []
}

/**
 * The ids of a plan.
 * @param plan - the plan.
 * @returns the check ids, in plan order.
 */
function ids(plan: readonly Planned[]): string[] {
  return plan.map(check => check.id)
}

/**
 * The plan a change selects.
 * @param paths - the repository-relative changed paths.
 * @returns the plan's check ids, in plan order.
 */
function selected(paths: readonly string[]): string[] {
  return ids(select(CHECKS, TREE, { ...NONE, changed: { base: 'main', paths } }))
}

describe('the native system addon in the check graph', () => {
  it('is a need of every lane that loads it, since the addon is git-ignored and setup leaves none', () => {
    for (const id of UPSTREAM_SUITE_LANES) expect(needs(id), id).toContain(NATIVE_CHECK_ID)
    expect(needs(NATIVE_CHECK_ID)).toEqual([])
  })

  it('runs ahead of the lane it is needed by, for a fork, an upstream and a recorded-scenario change', () => {
    for (const path of ['delorun/apps/control/src/index.ts', 'packages/core/session/src/index.ts', 'snapshots/session/text-turn/snapshot.yml']) {
      const plan = selected([path])
      expect(plan, path).toContain(NATIVE_CHECK_ID)
      expect(plan.indexOf(NATIVE_CHECK_ID), path).toBeLessThan(plan.findIndex(id => id.startsWith('tests:') || id.startsWith('parity-')))
    }
  })

  it('is pulled into a run that names one lane, so `--only` and a narrowed target prepare the addon too', () => {
    expect(ids(select(CHECKS, TREE, { ...NONE, only: ['tests:snapshots'] }))).toEqual([NATIVE_CHECK_ID, 'tests:snapshots'])
    expect(ids(select(CHECKS, TREE, { ...NONE, targets: ['delorun/apps/control/src/index.ts'] }))).toContain(NATIVE_CHECK_ID)
  })

  it('stays out of every tier: a change that reaches no lane that loads it does not build it', () => {
    expect(CHECKS.find(check => check.id === NATIVE_CHECK_ID)?.tiers).toEqual([])
    expect(selected(['delorun/docs/guide/safety-and-updates/trust.md'])).not.toContain(NATIVE_CHECK_ID)
    expect(ids(select(CHECKS, TREE, { ...NONE, only: [NATIVE_CHECK_ID] }))).toEqual([NATIVE_CHECK_ID])
  })

  it('builds the addon through upstream\'s script and declares no inputs, so the pass cache never serves a pass for a tree whose addon is gone', () => {
    const native = CHECKS.find(check => check.id === NATIVE_CHECK_ID)
    expect(native?.command).toEqual(['pnpm', 'run', '--silent', 'build:native-system'])
    expect(native?.inputs).toBeUndefined()
  })

  it('runs after the runtime bundles when those are stale too, and the lane waits for both', () => {
    const stale = catalog(TREE, { ...HOST, staleRuntime: ['apps/cli'] })
    expect(stale.find(check => check.id === 'tests:snapshots')?.needs).toEqual([NATIVE_CHECK_ID, 'build:artifacts'])
  })
})
