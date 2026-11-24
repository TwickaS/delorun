/**
 * The local checks: which checks a tree offers, which a selection runs and in
 * what order, the pre-commit tier, the machine budget, and the runner's
 * ordering and failure handling.
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { GATES } from '../src/checks/gates/index.ts'
import { UPSTREAM_GATES } from '../src/checks/gates/upstream.ts'
import { checkEnvironment, cgroupBudget, removeScratch, scratchDir, scratchPlace, statfsOf, headroomBytes, pnpmExecAnswer, runMemoryBytes, scopeCommand, workerCounts } from '../src/checks/machine.ts'
import { PARITY_OVERLAY_PATH } from '@delorun/contract-parity-composition'
import { affectsParity, declaredBuildOutputs, declineClosureOffHost, declineUnansweredDocker, declineWebsiteWithoutPictures, websitePicturesProblem, WEBSITE_PICTURES_VARIABLE, JOURNEY_SPEC, dependentsLeftForMerge, laneKeeps, leftForMerge, affectsUpstreamRuntime, catalog, criticalPath, packageDirOf, programLabel, readsPnpmScriptEnvironment, select, selectPreCommit, staleDelorunBuilds, type BuildProbe, type Budgets, type ForkPackage, type ForkTree, type Planned, type Selection, type UpstreamPackage, FORK_INTEGRATION_WORKERS, UPSTREAM_CHANGED_SPEC_BUDGET, unknownSelectors, upstreamSpecDirs, withDependents, withSecurityPackages } from '../src/checks/plan.ts'
import { CLOSURE_SPEC, closureHostProblem, closureRunProblem } from '../src/checks/closure.ts'
import { gateFailure, probeDocker, runPlan, type DockerRun, type Result } from '../src/checks/run.ts'
import type { GateCheck } from '../src/checks/types.ts'

const GIB = 1024 ** 3
const TSC = 'node_modules/.bin/tsc'

const TREE: ForkTree = {
  packages: [
    { name: '@delorun/control', dir: 'delorun/apps/control', forkDependencies: ['@delorun/control-protocol', '@delorun/providers'], upstreamDependencies: [], ownWorkspace: false },
    { name: '@delorun/cell', dir: 'delorun/apps/cell', forkDependencies: ['@delorun/control-protocol'], upstreamDependencies: [], ownWorkspace: false },
    { name: '@delorun/control-protocol', dir: 'delorun/packages/control-protocol', forkDependencies: [], upstreamDependencies: [], ownWorkspace: false },
    { name: '@delorun/providers', dir: 'delorun/packages/providers', forkDependencies: [], upstreamDependencies: [], ownWorkspace: false },
    { name: '@delorun/client-status', dir: 'delorun/packages/client-status', forkDependencies: ['@delorun/providers'], upstreamDependencies: [], ownWorkspace: false },
  ],
  programs: [
    { config: 'delorun/apps/control/tsconfig.json' },
    { config: 'delorun/apps/control/tsconfig.tests.json' },
    { config: 'delorun/apps/cell/tsconfig.json' },
    { config: 'delorun/packages/control-protocol/tsconfig.json' },
    { config: 'delorun/packages/providers/tsconfig.json' },
    { config: 'delorun/packages/client-status/tsconfig.json' },
    { config: 'delorun/packages/client-status/tsconfig.tests.json' },
  ],
  upstream: [
    { name: '@deepseek-ai/dsh-session', dir: 'packages/core/session', dependencies: [], runtimeDependencies: [], specs: 12 },
    { name: '@deepseek-ai/dsh-agent-loop', dir: 'packages/core/agent-loop', dependencies: ['@deepseek-ai/dsh-session'], runtimeDependencies: ['@deepseek-ai/dsh-session'], specs: 20 },
    { name: '@deepseek-ai/dsh-shell', dir: 'packages/shell/shell', dependencies: [], runtimeDependencies: [], specs: 5 },
    { name: '@deepseek-ai/dsh', dir: 'apps/cli', dependencies: ['@deepseek-ai/dsh-agent-loop'], runtimeDependencies: ['@deepseek-ai/dsh-agent-loop'], specs: 8 },
  ],
}
const BUDGETS = JSON.parse(readFileSync(new URL('../src/checks/budgets.json', import.meta.url), 'utf8')) as Budgets
const HOST = { workers: { fork: 12, upstream: 18 }, cacheDir: 'node_modules/.cache/delorun-checks', budgets: BUDGETS, staleRuntime: [] as string[], gates: [] as GateCheck[] } as const
const CHECKS = catalog(TREE, HOST)
const NONE: Selection = { targets: [], only: [], skip: [] }

/**
 * A repository gate for the fixtures.
 * @param id - the gate's id.
 * @param extra - the fields the gate sets beyond its id.
 * @returns the gate.
 */
function gate(id: string, extra: Partial<GateCheck> = {}): GateCheck {
  return { id, title: `${id} title`, command: ['node', `${id}.ts`], ...extra }
}

/**
 * The ids of a plan, in order.
 * @param plan - the plan.
 * @returns the check ids.
 */
function ids(plan: readonly Planned[]): string[] {
  return plan.map(check => check.id)
}

describe('the catalog', () => {
  it('names each program by its directory and its config suffix', () => {
    expect(programLabel('delorun/apps/control/tsconfig.json')).toBe('control')
    expect(programLabel('delorun/apps/control/tsconfig.tests.json')).toBe('control-tests')
    expect(programLabel('delorun/apps/cell/tsconfig.denial.json')).toBe('cell-denial')
  })

  it('type-checks each Delorun program with tsc -p, after upstream\'s typecheck, into the cache directory', () => {
    const control = CHECKS.find(check => check.id === 'typecheck:delorun:control')
    expect(control?.command).toEqual([TSC, '--noEmit', '-p', 'delorun/apps/control/tsconfig.json', '--incremental', '--tsBuildInfoFile', 'node_modules/.cache/delorun-checks/tsbuildinfo/control.tsbuildinfo'])
    expect(control?.needs).toEqual(['typecheck:upstream'])
    expect(CHECKS.find(check => check.id === 'typecheck:delorun:client-status-tests')?.command).toContain('delorun/packages/client-status/tsconfig.tests.json')
  })

  it('gives the fork suite its memory per worker, and the changed-upstream lane its own worker cap', () => {
    expect(CHECKS.find(check => check.id === 'tests:fork')?.memoryBytes).toBe(12 * 0.5 * GIB)
    expect(CHECKS.find(check => check.id === 'tests:fork:integration')).toMatchObject({ cpus: FORK_INTEGRATION_WORKERS, memoryBytes: FORK_INTEGRATION_WORKERS * GIB })
    expect(CHECKS.find(check => check.id === 'tests:upstream-changed')).toMatchObject({ cpus: 8, command: [expect.stringContaining('vitest'), 'run', '--config', 'vitest.config.ts', '--maxWorkers=8', '--passWithNoTests'] })
    expect(CHECKS.find(check => check.id === 'tests:snapshots')).toMatchObject({ command: ['pnpm', 'run', '--silent', 'test:snapshot'], environment: { DSH_SNAPSHOT_MAX_CONCURRENCY: '5' }, cpus: 5, exclusive: true })
  })

  it('budgets each check by its id, then its id family, then its group, and fails a check with no budget at all', () => {
    expect(CHECKS.find(check => check.id === 'typecheck:upstream')?.budget).toEqual({ memoryGiB: 2.5 })
    expect(CHECKS.find(check => check.id === 'typecheck:delorun:control')?.budget).toEqual({ memoryGiB: 1 })
    const grouped = catalog(TREE, { ...HOST, gates: [gate('secrets')] })
    expect(grouped.find(check => check.id === 'secrets')?.budget).toEqual({ memoryGiB: 0.5 })
    expect(() => catalog(TREE, { ...HOST, budgets: { tiers: {}, checks: {} } })).toThrow('budgets.json gives boundary no memory')
  })

  it('refuses two checks under one id, which the scheduler would conflate, and names the directory to rename', () => {
    const tree: ForkTree = { ...TREE, programs: [{ config: 'delorun/apps/a/tsconfig.json' }, { config: 'delorun/packages/a/tsconfig.json' }] }
    expect(() => catalog(tree, HOST)).toThrow('two checks are named typecheck:delorun:a')
  })

  it('offers no Docker, built-package, workflow or cordis check', () => {
    const offered = CHECKS.map(check => check.id)
    expect(offered.filter(id => /docker|built|docs:site|workflow|cordis|composite/.test(id))).toEqual([])
  })

  it('offers each repository gate as a gates check, and the staged ones in the pre-commit tier too', () => {
    const gates = catalog(TREE, { ...HOST, gates: [gate('gates:secrets', { staged: true, inputs: ['**'] }), gate('gates:docs')] })
    expect(gates.find(check => check.id === 'gates:secrets')).toMatchObject({ group: 'gates', tiers: ['pre-commit', 'changed', 'full'], inputs: ['**'] })
    expect(gates.find(check => check.id === 'gates:docs')).toMatchObject({ group: 'gates', tiers: ['changed', 'full'] })
    expect(gates.find(check => check.id === 'gates:docs')?.inputs).toBeUndefined()
  })

  it('marks the checks whose verdict reads commits beyond the tree: the boundary check and the range gates, and no other check', () => {
    const history = catalog(TREE, { ...HOST, gates: GATES }).filter(check => check.history === true).map(check => check.id)
    expect(history).toEqual(['boundary', 'gates:personal-data', 'gates:dco', 'gates:commits', 'gates:changelog', 'gates:doc-times', 'gates:whitespace'])
    expect(CHECKS.find(check => check.id === 'tests:fork')?.scope).toBeUndefined()
  })

  it('builds the runtime bundles only when they are missing or stale, and the lanes that run built code wait for that build', () => {
    expect(CHECKS.some(check => check.id === 'build:artifacts')).toBe(false)
    const stale = catalog(TREE, { ...HOST, staleRuntime: ['apps/cli'] })
    expect(stale.find(check => check.id === 'build:artifacts')).toMatchObject({ command: ['pnpm', 'run', '--silent', 'build:artifacts'], needs: [], tiers: ['changed', 'full'] })
    expect(stale.find(check => check.id === 'build:artifacts')?.environment).toBeUndefined()
    for (const id of ['tests:snapshots', 'tests:upstream-changed', 'tests:fork', 'parity-replay:control']) expect(stale.find(check => check.id === id)?.needs).toEqual(['generate:native', 'build:artifacts'])
    expect(stale.find(check => check.id === 'tests:fork:integration')?.needs).toEqual(['generate:native', 'build:artifacts', 'tests:fork'])
  })
})

describe('selection', () => {
  it('runs every default check with no target, and neither the changed-upstream lane nor the native build by a tier of its own', () => {
    expect(ids(select(CHECKS, TREE, NONE))).toEqual(['boundary', 'jsdoc', 'typecheck:upstream', 'typecheck:delorun:control', 'typecheck:delorun:control-tests', 'typecheck:delorun:cell', 'typecheck:delorun:control-protocol', 'typecheck:delorun:providers', 'typecheck:delorun:client-status', 'typecheck:delorun:client-status-tests', 'docs-site', 'website-site', 'generated:notices', 'generate:native', 'tests:fork', 'tests:fork:integration', 'tests:closure', 'tests:snapshots', 'parity-switches', 'parity-replay', 'parity-replay:control'])
    expect(CHECKS.find(check => check.id === 'generate:native')?.tiers).toEqual([])
    expect(ids(select(CHECKS, TREE, { ...NONE, only: ['generate:native'] }))).toEqual(['generate:native'])
  })

  it('runs the wait-time benchmarks only when asked for, alone', () => {
    expect(CHECKS.find(check => check.id === 'benchmark:delorun')).toMatchObject({ tiers: [], exclusive: true, command: ['pnpm', 'run', '--silent', 'benchmark:delorun', '--', '--check-budgets'] })
    expect(ids(select(CHECKS, TREE, { ...NONE, changed: { base: 'b', paths: ['delorun/apps/benchmarks/src/run.ts'] } }))).not.toContain('benchmark:delorun')
    expect(ids(select(CHECKS, TREE, { ...NONE, only: ['benchmark:delorun'] }))).toEqual(['benchmark:delorun'])
  })

  it('replays upstream\'s recorded sessions when an upstream-owned path changed, and not for a fork-only change', () => {
    const snapshots = (paths: string[]) => select(CHECKS, TREE, { ...NONE, changed: { base: 'b', paths } }).find(check => check.id === 'tests:snapshots')
    expect(snapshots(['packages/boot/plugin-manager/src/index.ts'])?.reason).toBe('upstream-owned code changed (packages/boot/plugin-manager/src/index.ts)')
    expect(snapshots(['delorun/packages/control-protocol/src/messages.ts'])).toBeUndefined()
  })

  it('narrows a target to its package\'s programs and specs, its dependents\' programs, the boundary and the JSDoc check', () => {
    const plan = select(CHECKS, TREE, { ...NONE, targets: ['delorun/packages/control-protocol/src/messages.ts'] })
    expect(ids(plan)).toEqual(['boundary', 'jsdoc', 'typecheck:upstream', 'typecheck:delorun:control', 'typecheck:delorun:control-tests', 'typecheck:delorun:cell', 'typecheck:delorun:control-protocol', 'generate:native', 'tests:fork', 'tests:fork:integration'])
    expect(plan.find(check => check.id === 'typecheck:delorun:cell')?.reason).toBe('delorun/apps/cell depends on a changed package')
    for (const id of ['tests:fork', 'tests:fork:integration']) expect(plan.find(check => check.id === id)?.command.slice(-1)).toEqual(['delorun/packages/control-protocol/'])
  })

  it('offers the Docker lane only in a tree with Docker specs, and runs it on the packages a change reaches', () => {
    expect(CHECKS.some(check => check.id === 'tests:docker')).toBe(false)
    const tree: ForkTree = { ...TREE, packages: TREE.packages.map(pkg => pkg.name === '@delorun/providers' ? { ...pkg, dockerSpecs: true } : pkg) }
    const checks = catalog(tree, HOST)
    const docker = checks.find(check => check.id === 'tests:docker')
    expect(docker?.command).toEqual(['node_modules/.bin/vitest', 'run', '--config', 'delorun/vitest.docker.config.ts', '--passWithNoTests'])
    const reached = select(checks, tree, { ...NONE, changed: { base: 'main', paths: ['delorun/packages/providers/src/index.ts'] } }).find(check => check.id === 'tests:docker')
    expect(reached?.reason).toBe('Docker specs of a package a change reaches (delorun/packages/providers)')
    expect(reached?.scope).toEqual(['delorun/apps/control/', 'delorun/packages/providers/', 'delorun/packages/client-status/'])
    expect(ids(select(checks, tree, { ...NONE, changed: { base: 'main', paths: ['delorun/apps/cell/src/index.ts'] } }))).not.toContain('tests:docker')
  })

  it('passes spec paths to the fork suite as they are', () => {
    const plan = select(CHECKS, TREE, { ...NONE, targets: ['delorun/apps/control/tests/front.spec.ts'] })
    expect(plan.find(check => check.id === 'tests:fork')?.command.slice(-1)).toEqual(['delorun/apps/control/tests/front.spec.ts'])
    // The phase whose project holds no such spec passes with none.
    expect(plan.find(check => check.id === 'tests:fork:integration')?.command.slice(-2)).toEqual(['--passWithNoTests', 'delorun/apps/control/tests/front.spec.ts'])
  })

  it('runs the fork suite on the packages a change reaches, by directory, dependents included, and never with vitest\'s related-file selection', () => {
    const plan = select(CHECKS, TREE, { ...NONE, changed: { base: 'main', paths: ['delorun/packages/providers/src/index.ts'] } })
    const fork = plan.find(check => check.id === 'tests:fork')
    expect(fork?.command.slice(-3)).toEqual(['delorun/apps/control/', 'delorun/packages/providers/', 'delorun/packages/client-status/'])
    expect(fork?.command).not.toContain('--changed')
    expect(fork?.reason).toBe('specs of the packages a change reaches, dependents included')
    expect(fork?.scope).toEqual(['delorun/apps/control/', 'delorun/packages/providers/', 'delorun/packages/client-status/'])
    expect(ids(plan)).not.toContain('typecheck:delorun:cell')
  })

  it('runs every fork spec for a fork-wide change, such as the checks runner\'s own sources', () => {
    const plan = select(CHECKS, TREE, { ...NONE, changed: { base: 'main', paths: ['delorun/apps/tools/src/checks/plan.ts'] } })
    expect(plan.find(check => check.id === 'tests:fork')?.command).toEqual(['node_modules/.bin/vitest', 'run', '--config', 'delorun/vitest.config.ts', '--project', 'fork', '--project', 'fork-client', '--project', 'fork-client-website', '--maxWorkers=12', '--passWithNoTests'])
    expect(plan.find(check => check.id === 'tests:fork:integration')?.command).toEqual(['node_modules/.bin/vitest', 'run', '--config', 'delorun/vitest.config.ts', '--project', 'fork-integration', `--maxWorkers=${String(FORK_INTEGRATION_WORKERS)}`, '--passWithNoTests'])
  })

  it('checks every program when code outside every package changes, such as a build script', () => {
    const plan = select(CHECKS, TREE, { ...NONE, changed: { base: 'main', paths: ['scripts/build.ts'] } })
    expect(ids(plan)).toEqual(expect.arrayContaining(['typecheck:delorun:control', 'typecheck:delorun:cell', 'typecheck:delorun:providers', 'typecheck:delorun:client-status']))
    expect(plan.find(check => check.id === 'tests:fork')?.command.slice(-2)).toEqual(['--maxWorkers=12', '--passWithNoTests'])
  })

  it('reaches only the fork packages that depend on a changed upstream package, directly or through upstream dependents', () => {
    const tree: ForkTree = { ...TREE, packages: TREE.packages.map(pkg => pkg.name === '@delorun/providers' ? { ...pkg, upstreamDependencies: ['@deepseek-ai/dsh-agent-loop'] } : pkg) }
    const plan = select(catalog(tree, HOST), tree, { ...NONE, changed: { base: 'main', paths: ['packages/core/session/src/index.ts'] } })
    expect(ids(plan)).toEqual(expect.arrayContaining(['typecheck:upstream', 'typecheck:delorun:providers', 'typecheck:delorun:control', 'typecheck:delorun:client-status-tests', 'tests:fork', 'tests:upstream-changed']))
    expect(ids(plan)).not.toContain('typecheck:delorun:cell')
    const leaf = select(catalog(tree, HOST), tree, { ...NONE, changed: { base: 'main', paths: ['packages/shell/shell/src/index.ts'] } })
    expect(ids(leaf)).toEqual(expect.arrayContaining(['typecheck:upstream', 'tests:upstream-changed']))
    expect(ids(leaf).filter(id => id.startsWith('typecheck:delorun'))).toEqual([])
    expect(ids(leaf)).not.toContain('tests:fork')
  })

  it('keeps only the named checks and groups with their needs, drops skipped needs, and selects a tier\'s family by its prefix', () => {
    expect(ids(select(CHECKS, TREE, { ...NONE, only: ['typecheck:delorun:cell'] }))).toEqual(['typecheck:upstream', 'typecheck:delorun:cell'])
    const skipped = select(CHECKS, TREE, { ...NONE, only: ['typecheck:delorun:cell'], skip: ['typecheck:upstream'] })
    expect(ids(skipped)).toEqual(['typecheck:delorun:cell'])
    expect(skipped.find(check => check.id === 'typecheck:delorun:cell')?.needs).toEqual([])
    expect(ids(select(CHECKS, TREE, { ...NONE, only: ['typecheck:delorun'] })).filter(id => id.startsWith('typecheck:delorun'))).toHaveLength(7)
    expect(ids(select(CHECKS, TREE, { ...NONE, skip: ['tests'] })).some(id => id.startsWith('tests:'))).toBe(false)
    // `tests:fork` names both phases of the fork suite; the integration phase alone still runs after the unit phase.
    expect(ids(select(CHECKS, TREE, { ...NONE, only: ['tests:fork'] }))).toEqual(['generate:native', 'tests:fork', 'tests:fork:integration'])
    expect(ids(select(CHECKS, TREE, { ...NONE, only: ['tests:fork:integration'] }))).toEqual(['generate:native', 'tests:fork', 'tests:fork:integration'])
  })

  it('runs the moved-clock check only when --only names it, after the builds, on at most 8 workers', () => {
    const check = CHECKS.find(candidate => candidate.id === 'tests:moved-clock')
    expect(check).toMatchObject({ group: 'tests', tiers: [], needs: ['generate:native'], cpus: 8, command: ['node_modules/.bin/tsx', 'delorun/apps/tools/src/checks/moved-clock.ts', '--workers=8'], budget: { memoryGiB: 0.5, perWorker: true } })
    expect(catalog(TREE, { ...HOST, workers: { ...HOST.workers, fork: 3 } }).find(candidate => candidate.id === 'tests:moved-clock')?.command.at(-1)).toBe('--workers=3')
    expect(ids(select(CHECKS, TREE, NONE))).not.toContain('tests:moved-clock')
    expect(ids(select(CHECKS, TREE, { ...NONE, changed: { base: 'main', paths: ['delorun/packages/update/tests/rollback.spec.ts'] } }))).not.toContain('tests:moved-clock')
    expect(ids(select(CHECKS, TREE, { ...NONE, only: ['tests:moved-clock'] }))).toEqual(['generate:native', 'tests:moved-clock'])
  })

  it('names the --only and --skip selectors that match no check, so a typo cannot select nothing and pass', () => {
    expect(unknownSelectors(CHECKS, ['tests:fork', 'tests', 'typecheck:delorun', 'tests:forkk', 'nope'])).toEqual(['tests:forkk', 'nope'])
  })

  it('follows dependents transitively', () => {
    const packages = [
      { name: '@delorun/a', dir: 'delorun/packages/a', forkDependencies: [], upstreamDependencies: [], ownWorkspace: false },
      { name: '@delorun/b', dir: 'delorun/packages/b', forkDependencies: ['@delorun/a'], upstreamDependencies: [], ownWorkspace: false },
      { name: '@delorun/c', dir: 'delorun/apps/c', forkDependencies: ['@delorun/b'], upstreamDependencies: [], ownWorkspace: false },
      { name: '@delorun/d', dir: 'delorun/apps/d', forkDependencies: [], upstreamDependencies: [], ownWorkspace: false },
    ]
    expect([...withDependents(packages, new Set(['@delorun/a']))].sort()).toEqual(['@delorun/a', '@delorun/b', '@delorun/c'])
    expect(packageDirOf('delorun/apps/cell/src/x.ts')).toBe('delorun/apps/cell')
    expect(packageDirOf('delorun/vitest.config.ts')).toBeUndefined()
  })
})

describe('the gate tiers', () => {
  const MERGE_ONLY = ['tests:closure', 'tests:snapshots', 'parity-replay', 'parity-replay:control']
  const dockerTree: ForkTree = { ...TREE, packages: TREE.packages.map(pkg => pkg.name === '@delorun/providers' ? { ...pkg, dockerSpecs: true } : pkg) }
  const upstreamChange = { base: 'main', paths: ['packages/core/session/src/index.ts'] }

  it('marks the replays, the web lane, the closure lane and the Docker lane merge-only, and no other check', () => {
    const marked = catalog(dockerTree, HOST).filter(check => check.mergeOnly === true).map(check => check.id)
    expect(marked).toEqual(['tests:docker', 'tests:web-changed', 'tests:closure', 'tests:snapshots', 'parity-replay', 'parity-replay:control'])
  })

  it('leaves each merge-only check out of the agent tier and names it, and the merge tier selects it', () => {
    const checks = catalog(dockerTree, HOST)
    const changed = { base: 'main', paths: ['packages/core/session/src/index.ts', 'delorun/packages/providers/src/index.ts'] }
    const agent = ids(select(checks, dockerTree, { ...NONE, changed, tier: 'agent' }))
    const merge = ids(select(checks, dockerTree, { ...NONE, changed, tier: 'merge' }))
    for (const id of [...MERGE_ONLY, 'tests:docker']) {
      expect(agent).not.toContain(id)
      expect(merge).toContain(id)
    }
    expect(agent).toContain('parity-switches')
    expect(leftForMerge(checks, dockerTree, { ...NONE, changed, tier: 'agent' })).toEqual(['tests:docker', 'tests:closure', 'tests:snapshots', 'parity-replay', 'parity-replay:control'])
    expect(leftForMerge(checks, dockerTree, { ...NONE, changed, tier: 'merge' })).toEqual([])
    expect(ids(select(checks, dockerTree, { ...NONE, changed }))).toEqual(merge)
  })

  it('still runs a merge-only check that --only names, in either tier', () => {
    for (const tier of ['agent', 'merge'] as const) {
      expect(ids(select(CHECKS, TREE, { ...NONE, changed: upstreamChange, only: ['parity-replay'], tier }))).toContain('parity-replay')
    }
  })

  it('keeps the mechanical rules, the changed packages\' typecheck and their own specs in the lane tier, and names the rest', () => {
    const checks = catalog(dockerTree, { ...HOST, gates: [gate('gates:commits', { history: true }), gate('gates:docs', { tier: 'agent' })] })
    const changed = { base: 'main', paths: ['delorun/packages/providers/src/index.ts', 'packages/core/session/src/index.ts'] }
    const lane = select(checks, dockerTree, { ...NONE, changed, tier: 'lane' })
    expect(ids(lane)).toEqual(['boundary', 'gates:commits', 'jsdoc', 'typecheck:upstream', 'typecheck:delorun:providers', 'generate:native', 'tests:fork', 'tests:fork:integration'])
    for (const id of ['tests:fork', 'tests:fork:integration']) expect(lane.find(check => check.id === id)?.scope).toEqual(['delorun/packages/providers/'])
    expect(lane.find(check => check.id === 'typecheck:upstream')?.reason).toBe('needed by typecheck:delorun:providers')
    expect(leftForMerge(checks, dockerTree, { ...NONE, changed, tier: 'lane' })).toEqual(['gates:docs', 'typecheck:delorun:control', 'typecheck:delorun:control-tests', 'typecheck:delorun:client-status', 'typecheck:delorun:client-status-tests', 'tests:docker', 'tests:upstream-changed', 'tests:closure', 'tests:snapshots', 'parity-switches', 'parity-replay', 'parity-replay:control'])
    // Without a changed package the lane tier runs no typecheck of Delorun's programs and no specs.
    expect(ids(select(checks, dockerTree, { ...NONE, changed: { base: 'main', paths: ['README.md'] }, tier: 'lane' }))).toEqual(['boundary', 'gates:commits'])
    const program = CHECKS.find(check => check.id === 'typecheck:delorun:control')
    expect(program === undefined ? undefined : laneKeeps({ ...program, command: ['tsc'] }, new Set(['delorun/apps/control']))).toBe(false)
  })

  it('selects no fork spec for documentation outside the packages, and still selects a package\'s specs for any file in it', () => {
    for (const tier of ['lane', 'agent', 'merge'] as const) {
      const docs = ids(select(CHECKS, TREE, { ...NONE, changed: { base: 'main', paths: ['delorun/docs/guide/a.md', 'delorun/changelog/unreleased/a.md'] }, tier }))
      expect(docs.filter(id => id.startsWith('tests:'))).toEqual([])
      const readme = select(CHECKS, TREE, { ...NONE, changed: { base: 'main', paths: ['delorun/packages/providers/README.md'] }, tier })
      expect(readme.find(check => check.id === 'tests:fork')?.scope).toContain('delorun/packages/providers/')
    }
  })

  it('runs the full gate in whole whatever the tier says', () => {
    expect(ids(select(CHECKS, TREE, { ...NONE, tier: 'agent' }))).toEqual(ids(select(CHECKS, TREE, NONE)))
    expect(leftForMerge(CHECKS, TREE, { ...NONE, tier: 'agent' })).toEqual([])
  })

  it('runs a gate in the tiers its own tier allows, and has a gate that reads built output wait for a stale build', () => {
    const gates = [gate('gates:quick'), gate('gates:slow', { tier: 'agent' }), gate('gates:heavy', { tier: 'merge', builtArtifacts: true })]
    const checks = catalog(TREE, { ...HOST, staleRuntime: ['apps/cli'], gates })
    const changed = { base: 'main', paths: ['README.md'] }
    const tiers = Object.fromEntries((['lane', 'agent', 'merge'] as const).map(tier => [tier, ids(select(checks, TREE, { ...NONE, changed, tier })).filter(id => id.startsWith('gates:'))]))
    expect(tiers).toEqual({ lane: ['gates:quick'], agent: ['gates:quick', 'gates:slow'], merge: ['gates:quick', 'gates:slow', 'gates:heavy'] })
    expect(checks.find(check => check.id === 'gates:heavy')).toMatchObject({ mergeOnly: true, needs: ['build:artifacts'] })
    expect(catalog(TREE, { ...HOST, gates }).find(check => check.id === 'gates:heavy')?.needs).toEqual([])
    expect(ids(select(checks, TREE, NONE)).filter(id => id.startsWith('gates:'))).toEqual(['gates:quick', 'gates:slow', 'gates:heavy'])
  })

  it('runs each of upstream\'s gates once, through its package script or its spec files', () => {
    const upstream = GATES.filter(entry => UPSTREAM_GATES.some(gate => gate.id === entry.id))
    expect(upstream).toHaveLength(UPSTREAM_GATES.length)
    expect(new Set(GATES.map(entry => entry.id)).size).toBe(GATES.length)
    for (const entry of UPSTREAM_GATES) expect(entry.command.slice(0, 3).join(' ')).toMatch(/^(pnpm run --silent|node_modules\/\.bin\/vitest run \S+)/)
    expect(GATES.find(entry => entry.id === 'gates:docs')?.tier).toBe('agent')
  })

  it('passes the per-test timeout only to the spec gate that sets one', () => {
    const command = (id: string) => UPSTREAM_GATES.find(gate => gate.id === id)?.command
    expect(command('gates:locale-dictionaries')).toEqual([
      'node_modules/.bin/vitest', 'run', '--testTimeout=60000',
      'scripts/locale-dictionary-parity.spec.ts', 'scripts/shipped-locales.spec.ts', 'packages/client/locale/tests/apply.client.spec.ts',
    ])
    expect(command('gates:doc-standard-tests')).toEqual(['node_modules/.bin/vitest', 'run', 'scripts/doc-standard.spec.ts'])
    expect(UPSTREAM_GATES.filter(gate => gate.command.some(arg => arg.startsWith('--testTimeout=')))).toHaveLength(1)
  })

  it('runs the CLI help generator one child at a time, as upstream\'s run-gates does, so no child hits its limit under load', () => {
    expect(GATES.find(gate => gate.id === 'gates:cli-help')?.environment).toEqual({ DSH_CLI_HELP_CONCURRENCY: '1' })
    expect(catalog(TREE, { ...HOST, gates: GATES }).find(check => check.id === 'gates:cli-help')?.environment).toEqual({ DSH_CLI_HELP_CONCURRENCY: '1' })
    expect(GATES.filter(gate => gate.environment !== undefined).map(gate => gate.id)).toEqual(['gates:cli-help'])
  })

  it('declares the documentation gate\'s own source among its inputs, so an edit to the gate reruns it', () => {
    expect(GATES.find(gate => gate.id === 'gates:docs')?.inputs).toContain('delorun/apps/tools/src/checks/gates/docs.ts')
  })
})

describe('the pre-commit tier', () => {
  const GATED = catalog(TREE, { ...HOST, gates: [gate('gates:secrets', { staged: true }), gate('gates:docs')] })

  it('runs only the staged gates and the whitespace check, with the staged paths appended to their commands', () => {
    const plan = selectPreCommit(GATED, ['delorun/a.ts', 'README.md'])
    expect(ids(plan)).toEqual(['gates:secrets', 'whitespace:staged'])
    expect(plan[0]?.command).toEqual(['node', 'gates:secrets.ts', 'delorun/a.ts', 'README.md'])
    expect(plan[1]?.command).toEqual(['git', 'diff', '--cached', '--check', '--', 'delorun/a.ts', 'README.md'])
    expect(plan.every(check => check.declined === undefined)).toBe(true)
  })

  it('declines the tier\'s checks when no path is staged, rather than checking the whole tree', () => {
    const plan = selectPreCommit(GATED, [])
    expect(plan.map(check => check.declined)).toEqual(['no staged file to check', 'no staged file to check'])
    expect(plan[0]?.command).toEqual(['node', 'gates:secrets.ts'])
  })

  it('leaves the whitespace check out of every other tier', () => {
    expect(ids(select(GATED, TREE, { ...NONE, changed: { base: 'main', paths: ['delorun/packages/providers/src/index.ts'] } }))).not.toContain('whitespace:staged')
    expect(ids(select(GATED, TREE, NONE))).toEqual(expect.arrayContaining(['gates:secrets', 'gates:docs']))
  })
})

describe('the parity checks', () => {
  it('replay upstream\'s scenarios through the overlay with no inputs, so a selection always runs them, after a stale build', () => {
    const replay = CHECKS.find(check => check.id === 'parity-replay')
    expect(replay).toMatchObject({ group: 'parity', command: ['pnpm', 'run', '--silent', 'test:snapshot'], environment: { DSH_SNAPSHOT_PATCH: PARITY_OVERLAY_PATH, DSH_SNAPSHOT_MAX_CONCURRENCY: '5' }, needs: ['generate:native'], exclusive: true })
    expect(replay?.inputs).toBeUndefined()
    expect(catalog(TREE, { ...HOST, staleRuntime: ['apps/cli'] }).find(check => check.id === 'parity-replay')?.needs).toEqual(['generate:native', 'build:artifacts'])
    expect(CHECKS.find(check => check.id === 'parity-switches')?.command).toEqual(['node_modules/.bin/tsx', 'delorun/apps/tools/src/parity/composition/check-parity-switches.ts'])
  })

  it('run the replay\'s negative control as its own merge-only check with no inputs, after a stale build', () => {
    const control = CHECKS.find(check => check.id === 'parity-replay:control')
    expect(control).toMatchObject({ group: 'parity', mergeOnly: true, command: ['node_modules/.bin/tsx', 'delorun/apps/tools/src/parity/composition/replay-control.ts'], needs: ['generate:native'], cpus: 1, budget: { memoryGiB: 1.5 } })
    expect(control?.inputs).toBeUndefined()
    expect(control?.exclusive).toBeUndefined()
  })

  it('run when Delorun code or an upstream edit changes, and not for documentation alone or a narrowed target', () => {
    const parity = (paths: string[]) => ids(select(CHECKS, TREE, { ...NONE, changed: { base: 'b', paths } })).filter(id => id.startsWith('parity-'))
    for (const path of ['delorun/packages/control-protocol/src/messages.ts', 'delorun/apps/tools/src/parity/composition/parity.overlay.yml', 'packages/boot/plugin-manager/src/tools.ts', 'snapshots/session/text-turn/runtime.cordis.yml']) {
      expect(affectsParity(path)).toBe(true)
      expect(parity([path])).toEqual(['parity-switches', 'parity-replay', 'parity-replay:control'])
    }
    for (const path of ['delorun/docs/contracts/c16-parity-composition.md', 'delorun/apps/tools/README.i18n.yaml', 'docs/architecture.md']) expect(parity([path])).toEqual([])
    expect(ids(select(CHECKS, TREE, { ...NONE, targets: ['delorun/packages/control-protocol/src/messages.ts'] }))).not.toContain('parity-replay')
  })
})

describe('the third-party notices check', () => {
  const selected = (paths: string[]) => ids(select(CHECKS, TREE, { ...NONE, changed: { base: 'b', paths } }))

  it('runs upstream\'s generator in its check mode, with the manifests, the lockfile and the notices as inputs', () => {
    expect(CHECKS.find(check => check.id === 'generated:notices')).toMatchObject({
      command: ['node_modules/.bin/tsx', 'scripts/gen-third-party-notices.ts', '--check'],
      tiers: ['changed', 'full'],
    })
    expect(BUDGETS.checks['generated:notices']).toEqual({ memoryGiB: 1, seconds: 120 })
  })

  it('is selected by a change to any manifest, the lockfile, the notices or their generator, and by no other change', () => {
    for (const path of ['pnpm-lock.yaml', 'package.json', 'delorun/apps/cli/package.json', 'packages/core/session/package.json', 'THIRD_PARTY_NOTICES.md', 'scripts/gen-third-party-notices.ts']) expect(selected([path])).toContain('generated:notices')
    for (const path of ['delorun/apps/cli/src/main.ts', 'packages/core/session/src/index.ts', 'docs/architecture.md']) expect(selected([path])).not.toContain('generated:notices')
  })
})

describe('the documentation website check', () => {
  const selected = (paths: string[]) => ids(select(CHECKS, TREE, { ...NONE, changed: { base: 'b', paths } }))

  it('builds through its launcher, which names the install command when the site has no dependencies, with the site, Delorun\'s pages and the release version as its inputs', () => {
    expect(CHECKS.find(check => check.id === 'docs-site')).toMatchObject({
      group: 'docs-site',
      command: ['node_modules/.bin/tsx', 'delorun/apps/tools/src/check-docs-site.ts'],
      needs: [],
      tiers: ['changed', 'full'],
      inputs: ['delorun/apps/docs/**', 'delorun/packages/site-design/**', 'delorun/docs/**', 'delorun/apps/release/package.json'],
    })
    expect(BUDGETS.checks['docs-site']).toEqual({ memoryGiB: 2, seconds: 900 })
  })

  it('is selected by a change under the site, under delorun/docs, or to the release version the site names, and by no other change', () => {
    for (const path of ['delorun/apps/docs/source.config.ts', 'delorun/docs/guide/safety-and-updates/trust.md', 'delorun/docs/reference/parity-with-deepseek-harness/divergence/README.zh.md', 'delorun/apps/release/package.json']) expect(selected([path])).toContain('docs-site')
    for (const path of ['delorun/apps/cell/src/index.ts', 'delorun/apps/release/src/index.ts', 'packages/core/session/src/index.ts', 'docs/architecture.md']) expect(selected([path])).not.toContain('docs-site')
  })

  it('builds the product website through the same launcher with its name, after a stale runtime build, and selects it for the site, the design both sites share, the brand package and the changelog record', () => {
    expect(CHECKS.find(check => check.id === 'website-site')).toMatchObject({
      group: 'docs-site',
      command: ['node_modules/.bin/tsx', 'delorun/apps/tools/src/check-docs-site.ts', 'website'],
      inputs: expect.arrayContaining(['delorun/apps/website/**', 'delorun/packages/site-design/**', 'delorun/packages/brand/**', 'delorun/changelog/changelog.json', 'packages/client/ui-approval/src/**', 'delorun/packages/plugin-changes/src/**']),
      needs: [],
    })
    expect(catalog(TREE, { ...HOST, staleRuntime: ['packages/client/ui-primitives'] }).find(check => check.id === 'website-site')?.needs).toEqual(['build:artifacts'])
    for (const path of ['packages/client/ui-approval/src/client/ApprovalCard.tsx', 'delorun/packages/plugin-changes/src/client/ChangesSection.tsx']) expect(selected([path]), path).toContain('website-site')
    for (const path of ['delorun/apps/website/src/site/copy.ts', 'delorun/packages/site-design/src/mark.tsx', 'delorun/packages/brand/src/settings/AppearancePickers.tsx', 'delorun/changelog/changelog.json']) expect(selected([path])).toContain('website-site')
    expect(selected(['delorun/apps/docs/source.config.ts'])).not.toContain('website-site')
    expect(selected(['delorun/packages/site-design/src/mark.tsx'])).toContain('docs-site')
    expect(packageDirOf('delorun/apps/website/src/site/copy.ts')).toBeUndefined()
  })

  it('leaves the fork suite out of a change under the site, since the site is its own workspace with no fork specs', () => {
    expect(packageDirOf('delorun/apps/docs/source.config.ts')).toBeUndefined()
    expect(selected(['delorun/apps/docs/source.config.ts'])).not.toContain('tests:fork')
    expect(selected(['delorun/apps/docs/source.config.ts'])).toContain('docs-site')
  })

  it('declines the product website as a host limit when the pictures it builds from are absent, and runs it when they are there', () => {
    const site = (): Planned[] => select(CHECKS, TREE, { ...NONE, changed: { base: 'main', paths: ['delorun/apps/website/src/site/copy.ts'] }, tier: 'merge' })
    const present = (): boolean => true
    const absent = (): boolean => false
    // The pictures are not in the repository, so a checkout that never received them cannot build the site.
    const unset = websitePicturesProblem({}, present)
    expect(unset).toContain(WEBSITE_PICTURES_VARIABLE)
    expect(unset).toContain('not in the repository')
    expect(websitePicturesProblem({ [WEBSITE_PICTURES_VARIABLE]: '' }, present)).toBe(unset)
    expect(websitePicturesProblem({ [WEBSITE_PICTURES_VARIABLE]: '/pictures' }, absent)).toContain('/pictures')
    expect(websitePicturesProblem({ [WEBSITE_PICTURES_VARIABLE]: '/pictures' }, present)).toBeUndefined()
    const declined = declineWebsiteWithoutPictures(site(), unset).find(check => check.id === 'website-site')
    expect(declined).toMatchObject({ declined: unset, declinedByHost: true })
    expect(declineWebsiteWithoutPictures(site(), undefined).find(check => check.id === 'website-site')?.declined).toBeUndefined()
    // Only the product website reads the pictures; the documentation site has none, though it shares the group name.
    const both = declineWebsiteWithoutPictures(select(CHECKS, TREE, { ...NONE, changed: { base: 'main', paths: ['delorun/docs/guide/safety-and-updates/trust.md'] }, tier: 'merge' }), unset)
    expect(both.find(check => check.id === 'docs-site')?.declined).toBeUndefined()
  })
})

describe('the closure lane', () => {
  const merge = (paths: readonly string[]): Planned[] => select(CHECKS, TREE, { ...NONE, changed: { base: 'main', paths }, tier: 'merge' })

  it('builds and boots the closure through its own module, after the builds it reads', () => {
    const lane = catalog(TREE, { ...HOST, staleRuntime: ['apps/cli'] }).find(check => check.id === 'tests:closure')
    expect(lane).toMatchObject({ mergeOnly: true, command: ['node_modules/.bin/tsx', 'delorun/apps/tools/src/checks/closure.ts'], exclusive: true })
    expect(lane?.needs).toContain('build:artifacts')
  })

  it('runs in the merge tier for a change to Delorun code, a manifest or the lockfile, and not for documentation', () => {
    expect(ids(merge(['delorun/apps/release/package.json']))).toContain('tests:closure')
    expect(ids(merge(['delorun/apps/cli/src/main.ts']))).toContain('tests:closure')
    expect(ids(merge(['pnpm-lock.yaml']))).toContain('tests:closure')
    expect(ids(merge(['delorun/docs/contracts/c19-home-process.md']))).not.toContain('tests:closure')
    expect(ids(select(CHECKS, TREE, { ...NONE, changed: { base: 'main', paths: ['delorun/apps/cli/src/main.ts'] }, tier: 'agent' }))).not.toContain('tests:closure')
  })

  it('declines the lane on a host other than linux-x64 as a host limit, naming it, and keeps it on linux-x64', () => {
    expect(closureHostProblem('linux', 'x64')).toBeUndefined()
    const problem = closureHostProblem('darwin', 'arm64')
    expect(problem).toBe('the closure lane builds and boots the linux-x64 closure, and this host is darwin-arm64')
    const declined = declineClosureOffHost(merge(['delorun/apps/cli/src/main.ts']), problem).find(check => check.id === 'tests:closure')
    expect(declined).toMatchObject({ declined: problem, declinedByHost: true, mergeOnly: true })
    expect(declineClosureOffHost(merge(['delorun/apps/cli/src/main.ts']), undefined).find(check => check.id === 'tests:closure')?.declined).toBeUndefined()
  })

  it('names a closure spec that exists in the repository', () => {
    expect(existsSync(fileURLToPath(new URL(`../../../../${CLOSURE_SPEC}`, import.meta.url)))).toBe(true)
  })

  it('fails a run that passed no test, skipped one or failed one, and passes one where every test ran and passed', () => {
    const report = (total: number, passed: number, pending = 0, failed = 0): string => JSON.stringify({ numTotalTests: total, numPassedTests: passed, numFailedTests: failed, numPendingTests: pending, numTodoTests: 0 })
    expect(closureRunProblem(report(0, 0))).toBe(`no closure test ran; ${CLOSURE_SPEC} found no test to run`)
    expect(closureRunProblem(report(3, 0, 3))).toBe('3 of 3 closure tests did not run')
    expect(closureRunProblem(report(3, 2, 0, 1))).toBe('1 of 3 closure tests did not pass')
    expect(closureRunProblem('')).toMatch(/^the closure specs' report does not read: /u)
    expect(closureRunProblem('{}')).toBe(`no closure test ran; ${CLOSURE_SPEC} found no test to run`)
    expect(closureRunProblem(report(3, 3))).toBeUndefined()
  })
})

describe('the Docker lane', () => {
  const dockerTree: ForkTree = { ...TREE, packages: TREE.packages.map(pkg => pkg.name === '@delorun/providers' ? { ...pkg, dockerSpecs: true } : pkg) }
  const checks = catalog(dockerTree, HOST)
  const changed = { base: 'main', paths: ['delorun/packages/providers/src/index.ts'] }
  const planned = (): Planned[] => select(checks, dockerTree, { ...NONE, changed, tier: 'merge' })

  it('requires the Docker specs of the lane through the environment its command runs under', () => {
    expect(checks.find(check => check.id === 'tests:docker')?.environment).toEqual({ DELORUN_DOCKER_SPECS: '1' })
  })

  it('declines the lane for a limit of this host while no engine answers, and probes only when the plan holds it', () => {
    let asked = 0
    const down = (): string => { asked += 1; return 'no engine' }
    const declined = declineUnansweredDocker(planned(), down).find(check => check.id === 'tests:docker')
    expect(declined).toMatchObject({ declined: 'no engine', declinedByHost: true, mergeOnly: true })
    expect(asked).toBe(1)
    const up = declineUnansweredDocker(planned(), () => undefined).find(check => check.id === 'tests:docker')
    expect(up?.declined).toBeUndefined()
    asked = 0
    const without = select(checks, dockerTree, { ...NONE, changed: { base: 'main', paths: ['delorun/apps/cell/src/index.ts'] }, tier: 'merge' })
    expect(declineUnansweredDocker(without, down)).toEqual(without)
    expect(asked).toBe(0)
  })

  it('names why the engine does not answer and how to start one', () => {
    const answer = (status: number | null, stderr = '', error?: Error): DockerRun => () => ({ status, stderr, error })
    expect(probeDocker(answer(0))).toBeUndefined()
    const refused = probeDocker(answer(1, '\nCannot connect to the Docker daemon at unix:///var/run/docker.sock\nIs the daemon running?\n'))
    expect(refused).toContain('(Cannot connect to the Docker daemon at unix:///var/run/docker.sock)')
    expect(refused).toContain('start Docker Desktop')
    expect(refused).toContain('docker info')
    expect(probeDocker(answer(null, '', new Error('spawn docker ENOENT')))).toContain('(spawn docker ENOENT)')
    expect(probeDocker(answer(null))).toContain('(no answer within the timeout)')
    expect(probeDocker(answer(125))).toContain('(exit 125)')
    const seen: unknown[] = []
    probeDocker((command, args, timeoutMs) => { seen.push(command, args, timeoutMs); return { status: 0, stderr: '' } })
    expect(seen).toEqual(['docker', ['info', '--format', '{{.ServerVersion}}'], 30_000])
  })

  it('fails the merge tier for a merge-only check this host could not run, and no other tier or decline', async () => {
    const lane = declineUnansweredDocker(planned(), () => 'no engine').find(check => check.id === 'tests:docker')
    if (lane === undefined) throw new Error('the lane is planned')
    const { results } = await runDeclined([lane])
    expect(results).toEqual([expect.objectContaining({ id: 'tests:docker', outcome: 'declined', detail: 'no engine', unrun: true })])
    expect(gateFailure(results[0]!, 'merge')).toBe(true)
    expect(gateFailure(results[0]!, undefined)).toBe(true)
    expect(gateFailure(results[0]!, 'agent')).toBe(false)
    // An empty selection is not a limit of the host: the web lane declines when no spec maps to the change.
    const { declinedByHost, ...rest } = lane
    const web = await runDeclined([{ ...rest, id: 'tests:web-changed', declined: 'no web e2e spec maps to the change' }])
    expect(web.results[0]).toMatchObject({ outcome: 'declined' })
    expect(web.results[0]?.unrun).toBeUndefined()
    expect(gateFailure(web.results[0]!, 'merge')).toBe(false)
    expect(gateFailure({ id: 'x', outcome: 'failed', seconds: 0 }, 'agent')).toBe(true)
    expect(gateFailure({ id: 'x', outcome: 'passed', seconds: 0 }, 'merge')).toBe(false)
  })

  it('fails the merge tier for a merge-only check too large for the run\'s memory, and leaves other checks declined without failing', async () => {
    const huge = (extra: Partial<Planned>): Planned => ({ id: 'huge', group: 'tests', title: 'huge', cwd: '', command: [process.execPath, '-e', ''], needs: [], cpus: 1, memoryBytes: 5000, tiers: ['changed'], budget: { memoryGiB: 0.001 }, reason: 'test', ...extra })
    const { results } = await runDeclined([huge({ id: 'merge-only', mergeOnly: true }), huge({ id: 'plain' })])
    expect(results.map(result => [result.id, result.outcome, result.unrun])).toEqual([['merge-only', 'declined', true], ['plain', 'declined', undefined]])
  })
})

/**
 * Run a plan whose checks are all declined, in the merge tier.
 * @param plan - the declined checks.
 * @returns the results.
 */
async function runDeclined(plan: Planned[]): Promise<{ results: Result[] }> {
  const logDir = mkdtempSync(join(tmpdir(), 'delorun-checks-spec-'))
  try {
    return { results: await runPlan(plan, { root: process.cwd(), env: process.env, logDir, cpus: 1, memoryBytes: 1000, bail: false, tier: 'merge', report: () => {} }) }
  } finally {
    rmSync(logDir, { recursive: true, force: true })
  }
}

describe('the journey', () => {
  const journeyTree: ForkTree = { ...TREE, journey: true }
  const checks = catalog(journeyTree, HOST)
  const merge = (paths: readonly string[]): Planned[] => select(checks, journeyTree, { ...NONE, changed: { base: 'main', paths }, tier: 'merge' })

  it('is offered only in a tree that holds its spec, as a merge-only check that runs the spec alone under the Docker configuration', () => {
    expect(CHECKS.some(check => check.id === 'journey')).toBe(false)
    expect(JOURNEY_SPEC).toBe('delorun/apps/release/tests/journey/journey.docker.spec.ts')
    const journey = checks.find(check => check.id === 'journey')
    expect(journey).toMatchObject({ group: 'journey', mergeOnly: true, exclusive: true, environment: { DELORUN_JOURNEY: '1' }, tiers: ['changed', 'full'], needs: [] })
    expect(journey?.command).toEqual(['node_modules/.bin/vitest', 'run', '--config', 'delorun/vitest.docker.config.ts', '--reporter=verbose'])
    expect(journey?.inputs).toEqual(expect.arrayContaining(['delorun/**', 'packages/**']))
    expect(journey?.memoryBytes).toBe(Math.round(BUDGETS.checks['journey']!.memoryGiB * GIB))
  })

  it('waits for the builds a stale tree needs, since it releases the tree\'s built artifacts', () => {
    const stale = catalog(journeyTree, { ...HOST, staleRuntime: ['apps/cli'], staleDelorunBuilds: [{ name: '@delorun/plugin-trash', reason: 'older' }] })
    expect(stale.find(check => check.id === 'journey')?.needs).toEqual(['build:artifacts', 'build:delorun'])
  })

  it('runs in the merge tier for a change to what the installed release runs, and not for documentation alone', () => {
    expect(merge(['delorun/packages/providers/src/index.ts']).find(check => check.id === 'journey')?.reason).toBe('Delorun code the installed release runs changed (delorun/packages/providers/src/index.ts)')
    expect(merge(['packages/core/session/src/index.ts']).find(check => check.id === 'journey')?.reason).toBe('upstream-owned code the installed release runs changed (packages/core/session/src/index.ts)')
    expect(ids(merge(['delorun/docs/contracts/c03-update-report.md', 'docs/architecture.md']))).not.toContain('journey')
    const changed = { base: 'main', paths: ['delorun/packages/providers/src/index.ts'] }
    expect(ids(select(checks, journeyTree, { ...NONE, changed, tier: 'agent' }))).not.toContain('journey')
    expect(leftForMerge(checks, journeyTree, { ...NONE, changed, tier: 'agent' })).toContain('journey')
    expect(ids(select(checks, journeyTree, { ...NONE, only: ['journey'], tier: 'agent' }))).toEqual(['journey'])
  })

  it('is declined for a limit of this host while no engine answers, with the Docker lane on one probe', async () => {
    const tree: ForkTree = { ...journeyTree, packages: journeyTree.packages.map(pkg => pkg.name === '@delorun/providers' ? { ...pkg, dockerSpecs: true } : pkg) }
    const plan = select(catalog(tree, HOST), tree, { ...NONE, changed: { base: 'main', paths: ['delorun/packages/providers/src/index.ts'] }, tier: 'merge' })
    let asked = 0
    const declined = declineUnansweredDocker(plan, () => { asked += 1; return 'no engine' })
    expect(asked).toBe(1)
    expect(declined.filter(check => check.declinedByHost === true).map(check => check.id)).toEqual(['tests:docker', 'journey'])
    const alone = declineUnansweredDocker(merge(['delorun/packages/providers/src/index.ts']), () => 'no engine').find(check => check.id === 'journey')
    expect(alone).toMatchObject({ declined: 'no engine', declinedByHost: true })
    const { results } = await runDeclined([alone!])
    expect(results).toEqual([expect.objectContaining({ id: 'journey', outcome: 'declined', unrun: true })])
    expect(gateFailure(results[0]!, 'merge')).toBe(true)
    expect(declineUnansweredDocker(merge(['delorun/packages/providers/src/index.ts']), () => undefined).find(check => check.id === 'journey')?.declined).toBeUndefined()
  })
})

describe('the build of Delorun\'s packages', () => {
  const MANIFEST = {
    scripts: { build: 'tsc -b tsconfig.json && tsdown' },
    exports: { '.': { types: './lib/types/index.d.ts', default: './lib/index.js' }, './client': { default: './lib/client.js' }, './wire': './src/wire.ts', './package.json': './package.json' },
    files: ['lib/index.js', 'lib/client.js', 'lib/types/**/*.d.ts', 'locale/*.json'],
  }

  it('reads the runtime files under lib that the exports and files name, and none for a package without a build', () => {
    expect(declaredBuildOutputs(MANIFEST)).toEqual(['lib/index.js', 'lib/client.js'])
    expect(declaredBuildOutputs({ ...MANIFEST, scripts: { test: 'vitest' } })).toEqual([])
    expect(declaredBuildOutputs({ exports: './lib/index.js', files: ['./lib/other.mjs'], scripts: { build: 'x' } })).toEqual(['lib/index.js', 'lib/other.mjs'])
    expect(declaredBuildOutputs({ scripts: { build: 'x' } })).toEqual([])
  })

  const pkg = (name: string, buildOutputs?: readonly string[]): ForkPackage => ({ name, dir: `delorun/packages/${name}`, forkDependencies: [], upstreamDependencies: [], ownWorkspace: false, ...buildOutputs === undefined ? {} : { buildOutputs } })
  const probe = (facts: { missing?: readonly string[], source?: number, output?: number }): BuildProbe => ({
    exists: path => !(facts.missing ?? []).includes(path),
    newestOutput: () => facts.output ?? 10,
    newestSource: () => facts.source ?? 5,
  })

  it('marks a package with no output stale, a fresh one not, and a package without a build ignored', () => {
    const packages = [pkg('trash', ['lib/index.js', 'lib/client.js']), pkg('plain'), pkg('no-output', [])]
    expect(staleDelorunBuilds(packages, probe({ missing: ['delorun/packages/trash/lib/client.js'] }))).toEqual([{ name: 'trash', reason: 'delorun/packages/trash/lib/client.js is missing' }])
    expect(staleDelorunBuilds(packages, probe({ source: 20, output: 10 }))).toEqual([{ name: 'trash', reason: 'delorun/packages/trash is older than its sources' }])
    expect(staleDelorunBuilds(packages, probe({}))).toEqual([])
  })

  it('adds a build check that runs after upstream\'s build, and every lane that loads built code waits for it', () => {
    expect(CHECKS.some(check => check.id === 'build:delorun')).toBe(false)
    const stale = [{ name: '@delorun/plugin-trash', reason: 'delorun/packages/plugin-trash/lib/index.js is missing' }, { name: '@delorun/plugin-main-chat', reason: 'older' }]
    const checks = catalog(TREE, { ...HOST, staleRuntime: ['apps/cli'], staleDelorunBuilds: stale })
    const build = checks.find(check => check.id === 'build:delorun')
    expect(build).toMatchObject({ needs: ['build:artifacts'], tiers: ['changed', 'full'] })
    expect(build?.command).toEqual(['pnpm', '--silent', '--workspace-concurrency=1', '--filter', '@delorun/plugin-trash', '--filter', '@delorun/plugin-main-chat', 'run', 'build'])
    for (const id of ['tests:fork', 'tests:snapshots', 'parity-replay', 'tests:upstream-changed']) expect(checks.find(check => check.id === id)?.needs).toEqual(['generate:native', 'build:artifacts', 'build:delorun'])
    const alone = catalog(TREE, { ...HOST, staleDelorunBuilds: stale })
    expect(alone.find(check => check.id === 'build:delorun')?.needs).toEqual([])
    expect(alone.find(check => check.id === 'tests:fork')?.needs).toEqual(['generate:native', 'build:delorun'])
    // A program can read a built package's emitted declarations, which the stale build lacks until it has run.
    expect(checks.find(check => check.id === 'typecheck:delorun:control')?.needs).toEqual(['typecheck:upstream', 'build:delorun'])
    expect(CHECKS.find(check => check.id === 'typecheck:delorun:control')?.needs).toEqual(['typecheck:upstream'])
  })
})

describe('the changed-upstream lane', () => {
  it('builds upstream\'s runtime first only when its bundles are missing or stale, and the replay waits for that build', () => {
    const plan = select(catalog(TREE, { ...HOST, staleRuntime: ['apps/cli'] }), TREE, { ...NONE, changed: { base: 'base', paths: ['packages/core/session/src/index.ts'] } })
    expect(ids(plan).indexOf('build:artifacts')).toBeLessThan(ids(plan).indexOf('tests:snapshots'))
  })

  it('replays recorded sessions for upstream code, the scenarios and their harness, but not for upstream documentation, translations, notes or specs', () => {
    for (const path of ['packages/core/session/src/index.ts', 'snapshots/session/text-turn/snapshot.yml', 'apps/cli/package.json']) expect(affectsUpstreamRuntime(path)).toBe(true)
    for (const path of ['docs/architecture.md', 'packages/core/session/README.md', 'packages/core/session/README.i18n.yaml', '.agents/notes/a.md', 'packages/core/session/tests/a.spec.ts', 'website/index.md']) expect(affectsUpstreamRuntime(path)).toBe(false)
    expect(ids(select(CHECKS, TREE, { ...NONE, changed: { base: 'base', paths: ['packages/core/session/README.md'] } }))).not.toContain('tests:snapshots')
  })

  it('runs a changed upstream package\'s specs and its direct dependents\', and only the package\'s own above the spec budget', () => {
    expect(upstreamSpecDirs(TREE.upstream, ['packages/core/session/src/index.ts'])).toEqual({ dirs: ['packages/core/session/', 'packages/core/agent-loop/'], dependents: true })
    const wide: UpstreamPackage[] = [...TREE.upstream, { name: '@deepseek-ai/dsh-wide', dir: 'packages/core/wide', dependencies: ['@deepseek-ai/dsh-session'], runtimeDependencies: ['@deepseek-ai/dsh-session'], specs: UPSTREAM_CHANGED_SPEC_BUDGET }]
    expect(upstreamSpecDirs(wide, ['packages/core/session/src/index.ts'])).toEqual({ dirs: ['packages/core/session/'], dependents: false })
    const plan = select(CHECKS, TREE, { ...NONE, changed: { base: 'base', paths: ['packages/core/session/src/index.ts'] } })
    expect(plan.find(check => check.id === 'tests:upstream-changed')?.command.slice(-2)).toEqual(['packages/core/session/', 'packages/core/agent-loop/'])
  })

  describe('a security-ledger package', () => {
    const CONNECTION = '@deepseek-ai/dsh-client-connection'
    const wide: UpstreamPackage[] = [
      { name: CONNECTION, dir: 'packages/client/connection', dependencies: [], runtimeDependencies: [], specs: 30, security: true },
      // A development dependency still reaches the dependent: its specs load the package.
      { name: '@deepseek-ai/dsh-api-gateway', dir: 'packages/api/gateway', dependencies: [CONNECTION], runtimeDependencies: [], specs: 100 },
      { name: '@deepseek-ai/dsh-web-app', dir: 'packages/bundle/web-app', dependencies: [CONNECTION], runtimeDependencies: [CONNECTION], specs: 60 },
      { name: '@deepseek-ai/dsh-unrelated', dir: 'packages/core/unrelated', dependencies: [], runtimeDependencies: [], specs: 400 },
    ]
    const change = ['packages/client/connection/src/api-request-trust.ts']

    it('runs every direct dependent in the merge tier above the spec budget, development dependents included', () => {
      for (const tier of [undefined, 'merge'] as const) {
        expect(upstreamSpecDirs(wide, change, tier)).toEqual({ dirs: ['packages/client/connection/', 'packages/api/gateway/', 'packages/bundle/web-app/'], dependents: true, forced: true })
      }
    })

    it('leaves the dependents over the budget to the merge tier in the agent tier, and names them', () => {
      expect(upstreamSpecDirs(wide, change, 'agent')).toEqual({ dirs: ['packages/client/connection/'], dependents: false, left: ['@deepseek-ai/dsh-api-gateway', '@deepseek-ai/dsh-web-app'] })
      const tree: ForkTree = { ...TREE, upstream: wide }
      const selection: Selection = { ...NONE, changed: { base: 'main', paths: change }, tier: 'agent' }
      expect(dependentsLeftForMerge(tree, selection)).toEqual(['specs of the direct dependents of a security-ledger package (@deepseek-ai/dsh-api-gateway, @deepseek-ai/dsh-web-app)'])
      expect(dependentsLeftForMerge(tree, { ...selection, tier: 'merge' })).toEqual([])
      expect(dependentsLeftForMerge(tree, { ...selection, changed: { base: 'main', paths: ['packages/client/connection/README.md', 'delorun/apps/control/src/index.ts'] } })).toEqual([])
      expect(dependentsLeftForMerge(tree, { ...NONE, tier: 'agent' })).toEqual([])
    })

    it('says in the plan why the lane runs the dependents or leaves them', () => {
      const tree: ForkTree = { ...TREE, upstream: wide }
      const checks = catalog(tree, HOST)
      const lane = (tier: 'agent' | 'merge'): Planned | undefined => select(checks, tree, { ...NONE, changed: { base: 'main', paths: change }, tier }).find(check => check.id === 'tests:upstream-changed')
      expect(lane('merge')?.scope).toEqual(['packages/client/connection/', 'packages/api/gateway/', 'packages/bundle/web-app/'])
      expect(lane('merge')?.reason).toBe('3 upstream package(s): the changed ones and the direct dependents of a security-ledger package, whatever their spec count')
      expect(lane('agent')?.scope).toEqual(['packages/client/connection/'])
      expect(lane('agent')?.reason).toBe('the changed upstream package(s) only; the direct dependents of a security-ledger package exceed 150 spec files and run in the merge tier')
    })

    it('keeps the budget for a package without a ledger entry, and runs the dependents that fit in either tier', () => {
      const plain = wide.map(({ security, ...pkg }) => pkg)
      for (const tier of ['agent', 'merge'] as const) expect(upstreamSpecDirs(plain, change, tier)).toEqual({ dirs: ['packages/client/connection/'], dependents: false })
      const small = wide.map(pkg => pkg.name === '@deepseek-ai/dsh-api-gateway' ? { ...pkg, specs: 20 } : pkg.name === '@deepseek-ai/dsh-web-app' ? { ...pkg, specs: 20 } : pkg)
      expect(upstreamSpecDirs(small, change, 'agent')).toEqual({ dirs: ['packages/client/connection/', 'packages/api/gateway/', 'packages/bundle/web-app/'], dependents: true })
      const tree: ForkTree = { ...TREE, upstream: plain }
      const lane = select(catalog(tree, HOST), tree, { ...NONE, changed: { base: 'main', paths: change }, tier: 'merge' }).find(check => check.id === 'tests:upstream-changed')
      expect(lane?.reason).toBe('the changed upstream package(s) only; their direct dependents exceed 150 spec files and run in upstream\'s full suite')
    })

    it('marks the packages that hold a security entry\'s path', () => {
      const plain = wide.map(({ security, ...pkg }) => pkg)
      const marked = withSecurityPackages(plain, [
        { path: 'packages/client/connection/src/api-request-trust.ts', class: 'security' },
        { path: 'packages/api/gateway-extra/src/a.ts', class: 'security' },
        { path: 'packages/core/unrelated/src/a.ts', class: 'generic-fix' },
      ])
      expect(marked.filter(pkg => pkg.security === true).map(pkg => pkg.name)).toEqual([CONNECTION])
    })
  })

  it('hands the changed-upstream lane pnpm\'s script environment even when no other planned check runs pnpm', () => {
    // The native build runs pnpm too, so it is skipped here to leave the lane alone in the plan.
    const plan = select(CHECKS, TREE, { ...NONE, only: ['tests:upstream-changed'], skip: ['generate:native'], changed: { base: 'base', paths: ['packages/core/session/src/index.ts'] } })
    expect(plan.map(check => check.id)).toEqual(['tests:upstream-changed'])
    expect(plan.some(readsPnpmScriptEnvironment)).toBe(true)
    expect(readsPnpmScriptEnvironment({ command: ['pnpm', 'run', 'typecheck'] })).toBe(true)
    expect(readsPnpmScriptEnvironment({ command: ['node_modules/.bin/vitest', 'run'] })).toBe(false)
  })

  it('leaves the changed-upstream lane out of a fork-only change and the full gate, and declines it with nothing to narrow to', () => {
    expect(ids(select(CHECKS, TREE, { ...NONE, changed: { base: 'base', paths: ['delorun/apps/control/src/index.ts'] } }))).not.toContain('tests:upstream-changed')
    expect(ids(select(CHECKS, TREE, NONE))).not.toContain('tests:upstream-changed')
    expect(select(CHECKS, TREE, { ...NONE, only: ['tests:upstream-changed'] }).find(check => check.id === 'tests:upstream-changed')?.declined).toBe('no upstream package changed')
  })
})

describe('ordering', () => {
  it('ranks a check by its own time and the longest chain waiting for it', () => {
    const plan = select(CHECKS, TREE, NONE)
    const chain = criticalPath(plan, { 'typecheck:upstream': 30, 'typecheck:delorun:cell': 8, 'tests:fork': 40, 'tests:fork:integration': 90 })
    expect(chain.get('typecheck:delorun:cell')).toBe(8)
    expect(chain.get('typecheck:upstream')).toBe(38)
    expect(chain.get('tests:fork')).toBe(130)
    expect(chain.get('tests:fork:integration')).toBe(90)
    expect(chain.get('boundary')).toBe(1)
  })
})

describe('the machine budget', () => {
  it('keeps at least 2 GiB and an eighth of the memory outside the run', () => {
    expect(headroomBytes(15 * GIB)).toBe(2 * GIB)
    expect(headroomBytes(64 * GIB)).toBe(8 * GIB)
    expect(runMemoryBytes(15 * GIB)).toBe(13 * GIB)
    expect(runMemoryBytes(2 * GIB)).toBe(2 * GIB)
  })

  it('sizes the fork suite by the CPUs less two and the memory left beside the compilers, and the changed-upstream lane by its CPUs and memory', () => {
    expect(workerCounts(22, 13 * GIB)).toEqual({ fork: 20, upstream: 13 })
    expect(workerCounts(4, 13 * GIB)).toEqual({ fork: 2, upstream: 3 })
    expect(workerCounts(64, 4 * GIB)).toEqual({ fork: 2, upstream: 4 })
  })

  it('lowers the machine\'s CPUs and memory to the cgroup\'s limits, which nproc and free do not report', () => {
    const cgroup = (files: Record<string, string>) => (name: string): string => {
      const text = files[name]
      if (text === undefined) throw new Error(`no ${name}`)
      return text
    }
    expect(cgroupBudget(22, 15 * GIB, cgroup({ 'cpu.max': '400000 100000\n', 'memory.max': `${String(6 * GIB)}\n` }))).toEqual({ cpus: 4, memoryBytes: 6 * GIB })
    expect(cgroupBudget(22, 15 * GIB, cgroup({ 'cpu.max': 'max 100000\n', 'memory.max': 'max\n' }))).toEqual({ cpus: 22, memoryBytes: 15 * GIB })
    expect(cgroupBudget(22, 15 * GIB, cgroup({}))).toEqual({ cpus: 22, memoryBytes: 15 * GIB })
    expect(cgroupBudget(22, 15 * GIB, cgroup({ 'cpu.max': '50000 100000' }))).toEqual({ cpus: 1, memoryBytes: 15 * GIB })
  })

  it('hands checks no git repository variables, so a hook\'s GIT_DIR never reaches a fixture\'s git', () => {
    const env = checkEnvironment({ PATH: '/usr/bin', GIT_DIR: '/repo/.git', GIT_INDEX_FILE: '/repo/.git/index', GIT_EXEC_PATH: '/usr/lib/git-core', HOME: '/home/me' }, '/dev/shm/run')
    expect(env).toEqual({ PATH: '/usr/bin', HOME: '/home/me', TMPDIR: '/dev/shm/run', TMP: '/dev/shm/run', TEMP: '/dev/shm/run', NO_COLOR: '1', FORCE_COLOR: '0' })
  })

  it('hands checks no ambient NODE_ENV, so the invoking shell\'s value cannot pick React\'s production build in the client lane', () => {
    const env = checkEnvironment({ PATH: '/usr/bin', NODE_ENV: 'production', HOME: '/home/me' }, '/dev/shm/run')
    expect(env).not.toHaveProperty('NODE_ENV')
  })

  it('puts temporary files on the disk unless memory is asked for and a memory file system has the room, which the budget gives up', () => {
    const TMPFS = 0x01021994
    const probe = (facts: Record<string, { type: number, freeBytes: number }>) => ({ tmpdir: '/tmp', statfs: (dir: string) => facts[dir] })
    expect(scratchPlace({}, probe({ '/dev/shm': { type: TMPFS, freeBytes: 10 * GIB } }))).toEqual({ base: '/tmp', memory: false, capBytes: 0 })
    expect(scratchPlace({ DELORUN_CHECKS_SCRATCH: 'disk' }, probe({}))).toEqual({ base: '/tmp', memory: false, capBytes: 0 })
    expect(scratchPlace({ DELORUN_CHECKS_SCRATCH: 'memory' }, probe({ '/dev/shm': { type: TMPFS, freeBytes: 10 * GIB } }))).toEqual({ base: '/dev/shm', memory: true, capBytes: 4 * GIB })
    expect(scratchPlace({ DELORUN_CHECKS_SCRATCH: 'memory', DELORUN_CHECKS_SCRATCH_GIB: '1', XDG_RUNTIME_DIR: '/run/user/1' }, probe({ '/dev/shm': { type: 1, freeBytes: 10 * GIB }, '/run/user/1': { type: TMPFS, freeBytes: 2 * GIB } }))).toEqual({ base: '/run/user/1', memory: true, capBytes: GIB })
    expect(scratchPlace({ DELORUN_CHECKS_SCRATCH: 'memory', XDG_RUNTIME_DIR: '' }, probe({ '/dev/shm': { type: TMPFS, freeBytes: GIB } }))).toEqual({ base: '/tmp', memory: false, capBytes: 0, fallback: 'no memory file system (/dev/shm) has 4 GiB free' })
    expect(() => scratchPlace({ DELORUN_CHECKS_SCRATCH: 'ram' }, probe({}))).toThrow('DELORUN_CHECKS_SCRATCH takes disk or memory, got ram')
    expect(() => scratchPlace({ DELORUN_CHECKS_SCRATCH: 'memory', DELORUN_CHECKS_SCRATCH_GIB: '0' }, probe({}))).toThrow('DELORUN_CHECKS_SCRATCH_GIB takes a positive number of GiB, got 0')
    expect(statfsOf(tmpdir())?.freeBytes).toBeGreaterThan(0)
    expect(statfsOf('/no/such/directory')).toBeUndefined()
    const made = scratchDir(tmpdir())
    expect(made).toContain('delorun-checks-')
    rmSync(made, { recursive: true, force: true })
  })

  it('removes a scratch directory that a check left unreadable, and reports one it cannot remove', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'delorun-scratch-'))
    mkdirSync(join(scratch, 'locked', 'inner'), { recursive: true })
    writeFileSync(join(scratch, 'locked', 'inner', 'file'), 'x')
    chmodSync(join(scratch, 'locked', 'inner'), 0o000)
    chmodSync(join(scratch, 'locked'), 0o000)
    expect(removeScratch(scratch)).toBeUndefined()
    expect(existsSync(scratch)).toBe(false)
    expect(removeScratch(scratch)).toMatch(/ENOENT/)
  })

  it('hands checks none of the variables that steer the runner, which the pass cache does not key', () => {
    const env = checkEnvironment({ PATH: '/usr/bin', DELORUN_TIER: 'merge', DELORUN_GATE_PRIORITY: 'trunk', DELORUN_FULL_GATE: '1', DELORUN_PUSH_SKIP: 'tests', DELORUN_CHECKS_SCOPE: '1', DELORUN_DOCKER_SPECS: '1' }, '/dev/shm/run')
    expect(Object.keys(env).filter(name => name.startsWith('DELORUN_'))).toEqual(['DELORUN_DOCKER_SPECS'])
  })

  it('confines checks to the Linux side of WSL: no Windows PATH directories, no WSL interop variables', () => {
    const env = checkEnvironment({ PATH: '/usr/bin:/mnt/c/Windows/system32:/usr/local/bin', WSL_DISTRO_NAME: 'Ubuntu', WSL_INTEROP: '/run/WSL/1_interop', WSLENV: 'X', DISPLAY: ':0', NoDefaultCurrentDirectoryInExePath: '1' }, '/tmp/run')
    expect(env['PATH']).toBe('/usr/bin:/usr/local/bin')
    expect(env).not.toHaveProperty('WSL_INTEROP')
    expect(env).not.toHaveProperty('DISPLAY')
    // Upstream's Windows command lookup reads it from the process environment on any platform; a leaked value drops the current directory from spawn-runner.spec.ts's search roots.
    expect(env).not.toHaveProperty('NoDefaultCurrentDirectoryInExePath')
  })

  it('reads pnpm\'s script environment from the last line, after pnpm\'s own warnings', () => {
    const answer = '["/repo/node_modules/pnpm/bin/pnpm.cjs","false"]'
    expect(pnpmExecAnswer(answer)).toEqual({ execpath: '/repo/node_modules/pnpm/bin/pnpm.cjs', verify: 'false' })
    expect(pnpmExecAnswer(`native/system/packages/darwin-arm64 | [WARN] Unsupported platform\n${answer}`)).toEqual({ execpath: '/repo/node_modules/pnpm/bin/pnpm.cjs', verify: 'false' })
    expect(() => pnpmExecAnswer('native/system/packages/darwin-arm64 | [WARN] Unsupported platform\n')).toThrow('pnpm exec printed no answer on its last line: native/system/packages/darwin-arm64 | [WARN] Unsupported platform')
    expect(() => pnpmExecAnswer('["",""]')).toThrow('pnpm exec gave no npm_execpath')
    expect(() => pnpmExecAnswer('{"execpath":"/x"}')).toThrow('pnpm exec answered something else')
  })

  it('runs the command in a user scope with the ceiling and no swap', () => {
    expect(scopeCommand(['node', 'run-checks.ts'], 13 * GIB)).toEqual(['systemd-run', '--user', '--scope', '--quiet', '--collect', '-p', `MemoryMax=${String(13 * GIB)}`, '-p', 'MemorySwapMax=0', '-p', 'CPUWeight=50', '-p', 'IOWeight=50', '--description=delorun checks', '--', 'node', 'run-checks.ts'])
  })
})

describe('the runner', () => {
  let logDir: string | undefined
  afterEach(() => {
    if (logDir !== undefined) rmSync(logDir, { recursive: true, force: true })
  })

  /**
   * A planned check that runs a script.
   * @param id - the check's id.
   * @param script - the script `node -e` runs.
   * @param needs - the checks it waits for.
   * @param extra - fields beyond the defaults.
   * @returns the planned check.
   */
  function check(id: string, script: string, needs: string[] = [], extra: Partial<Planned> = {}): Planned {
    return { id, group: 'tests', title: id, cwd: '', command: [process.execPath, '-e', script], needs, cpus: 1, memoryBytes: 1024 ** 2, tiers: ['changed'], budget: { memoryGiB: 0.001 }, reason: 'test', ...extra }
  }

  /**
   * Run a plan in a fresh log directory and record the order of its events.
   * @param plan - the checks.
   * @param options - the CPU and memory budget and the bail flag.
   * @returns each result and the order of the start and end events.
   */
  async function run(plan: Planned[], options: { cpus?: number, bail?: boolean, memoryBytes?: number } = {}): Promise<{ results: Result[], order: string[] }> {
    logDir = mkdtempSync(join(tmpdir(), 'delorun-checks-spec-'))
    const order: string[] = []
    const results = await runPlan(plan, { root: process.cwd(), env: process.env, logDir, cpus: options.cpus ?? 4, memoryBytes: options.memoryBytes ?? 1024 ** 3, bail: options.bail ?? false, report: event => { order.push(`${event.kind}:${event.check.id}`) } })
    return { results, order }
  }

  it('starts a check after its needs pass, and skips the dependents of a failure', async () => {
    const { results, order } = await run([
      check('a', 'process.exit(0)'),
      check('b', 'process.exit(3)'),
      check('c', 'process.exit(0)', ['a']),
      check('d', 'process.exit(0)', ['b']),
      check('e', '', [], { declined: 'not installed' }),
    ])
    expect(results.map(result => [result.id, result.outcome, result.detail])).toEqual([['a', 'passed', undefined], ['b', 'failed', 'exit 3'], ['c', 'passed', undefined], ['d', 'skipped', 'b did not pass'], ['e', 'declined', 'not installed']])
    expect(order.indexOf('start:c')).toBeGreaterThan(order.indexOf('end:a'))
  })

  it('starts the ready check with the highest priority first', async () => {
    logDir = mkdtempSync(join(tmpdir(), 'delorun-checks-spec-'))
    const order: string[] = []
    await runPlan([check('short', 'process.exit(0)'), check('long', 'process.exit(0)')], { root: process.cwd(), env: process.env, logDir, cpus: 1, memoryBytes: 1024 ** 3, bail: false, priority: new Map([['long', 60], ['short', 1]]), report: event => { order.push(`${event.kind}:${event.check.id}`) } })
    expect(order[0]).toBe('start:long')
  })

  it('keeps memory inside the ceiling, runs an exclusive check alone, and declines one that cannot fit, failing nothing', async () => {
    const { results, order } = await run([
      check('a', 'setTimeout(() => {}, 150)', [], { memoryBytes: 600 }),
      check('b', 'process.exit(0)', [], { memoryBytes: 600 }),
      check('docker', 'process.exit(0)', [], { exclusive: true, memoryBytes: 100 }),
      check('huge', 'process.exit(0)', [], { memoryBytes: 5000 }),
      check('engine', '', [], { declined: 'no engine' }),
    ], { memoryBytes: 1000 })
    expect(order.indexOf('start:b')).toBeGreaterThan(order.indexOf('end:a'))
    expect(order.indexOf('start:docker')).toBeGreaterThan(Math.max(order.indexOf('end:a'), order.indexOf('end:b')))
    expect(results.find(result => result.id === 'huge')).toMatchObject({ outcome: 'declined' })
    expect(results.find(result => result.id === 'engine')).toMatchObject({ outcome: 'declined', detail: 'no engine' })
    expect(results.filter(result => result.outcome === 'failed')).toEqual([])
  })

  it('keeps the CPUs busy no more than the budget, but runs a larger check alone', async () => {
    const { order } = await run([check('wide', 'setTimeout(() => {}, 200)', [], { cpus: 8 }), check('narrow', 'process.exit(0)')], { cpus: 4 })
    expect(order.slice(0, 3)).toEqual(['start:wide', 'end:wide', 'start:narrow'])
  })

  it('starts nothing more after a failure with bail', async () => {
    const { results } = await run([check('a', 'process.exit(1)'), check('b', 'process.exit(0)', ['a']), check('c', 'process.exit(0)')], { cpus: 1, bail: true })
    expect(results.map(result => [result.id, result.outcome])).toEqual([['a', 'failed'], ['b', 'skipped'], ['c', 'skipped']])
  })
})
