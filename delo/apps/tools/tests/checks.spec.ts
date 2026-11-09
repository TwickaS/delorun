/**
 * The local checks: which checks a tree offers, which a selection runs and in
 * what order, the pre-commit tier, the machine budget, and the runner's
 * ordering and failure handling.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { GATES } from '../src/checks/gates/index.ts'
import { checkEnvironment, cgroupBudget, headroomBytes, pnpmExecAnswer, runMemoryBytes, scopeCommand, workerCounts } from '../src/checks/machine.ts'
import { PARITY_OVERLAY_PATH } from '@delo/contract-parity-composition'
import { affectsParity, affectsUpstreamRuntime, catalog, criticalPath, packageDirOf, programLabel, readsPnpmScriptEnvironment, select, selectPreCommit, type Budgets, type ForkTree, type Planned, type Selection, type UpstreamPackage, UPSTREAM_CHANGED_SPEC_BUDGET, unknownSelectors, upstreamSpecDirs, withDependents } from '../src/checks/plan.ts'
import { runPlan, type Result } from '../src/checks/run.ts'
import type { GateCheck } from '../src/checks/types.ts'

const GIB = 1024 ** 3
const TSC = 'node_modules/.bin/tsc'

const TREE: ForkTree = {
  packages: [
    { name: '@delo/control', dir: 'delo/apps/control', forkDependencies: ['@delo/control-protocol', '@delo/providers'], upstreamDependencies: [], ownWorkspace: false },
    { name: '@delo/cell', dir: 'delo/apps/cell', forkDependencies: ['@delo/control-protocol'], upstreamDependencies: [], ownWorkspace: false },
    { name: '@delo/control-protocol', dir: 'delo/packages/control-protocol', forkDependencies: [], upstreamDependencies: [], ownWorkspace: false },
    { name: '@delo/providers', dir: 'delo/packages/providers', forkDependencies: [], upstreamDependencies: [], ownWorkspace: false },
    { name: '@delo/client-status', dir: 'delo/packages/client-status', forkDependencies: ['@delo/providers'], upstreamDependencies: [], ownWorkspace: false },
  ],
  programs: [
    { config: 'delo/apps/control/tsconfig.json' },
    { config: 'delo/apps/control/tsconfig.tests.json' },
    { config: 'delo/apps/cell/tsconfig.json' },
    { config: 'delo/packages/control-protocol/tsconfig.json' },
    { config: 'delo/packages/providers/tsconfig.json' },
    { config: 'delo/packages/client-status/tsconfig.json' },
    { config: 'delo/packages/client-status/tsconfig.tests.json' },
  ],
  upstream: [
    { name: '@deepseek-ai/dsh-session', dir: 'packages/core/session', dependencies: [], runtimeDependencies: [], specs: 12 },
    { name: '@deepseek-ai/dsh-agent-loop', dir: 'packages/core/agent-loop', dependencies: ['@deepseek-ai/dsh-session'], runtimeDependencies: ['@deepseek-ai/dsh-session'], specs: 20 },
    { name: '@deepseek-ai/dsh-shell', dir: 'packages/shell/shell', dependencies: [], runtimeDependencies: [], specs: 5 },
    { name: '@deepseek-ai/dsh', dir: 'apps/cli', dependencies: ['@deepseek-ai/dsh-agent-loop'], runtimeDependencies: ['@deepseek-ai/dsh-agent-loop'], specs: 8 },
  ],
}
const BUDGETS = JSON.parse(readFileSync(new URL('../src/checks/budgets.json', import.meta.url), 'utf8')) as Budgets
const HOST = { workers: { fork: 12, upstream: 18 }, cacheDir: 'node_modules/.cache/delo-checks', budgets: BUDGETS, staleRuntime: [] as string[], gates: [] as GateCheck[] } as const
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
    expect(programLabel('delo/apps/control/tsconfig.json')).toBe('control')
    expect(programLabel('delo/apps/control/tsconfig.tests.json')).toBe('control-tests')
    expect(programLabel('delo/apps/cell/tsconfig.denial.json')).toBe('cell-denial')
  })

  it('type-checks each Delo program with tsc -p, after upstream\'s typecheck, into the cache directory', () => {
    const control = CHECKS.find(check => check.id === 'typecheck:delo:control')
    expect(control?.command).toEqual([TSC, '--noEmit', '-p', 'delo/apps/control/tsconfig.json', '--incremental', '--tsBuildInfoFile', 'node_modules/.cache/delo-checks/tsbuildinfo/control.tsbuildinfo'])
    expect(control?.needs).toEqual(['typecheck:upstream'])
    expect(CHECKS.find(check => check.id === 'typecheck:delo:client-status-tests')?.command).toContain('delo/packages/client-status/tsconfig.tests.json')
  })

  it('gives the fork suite its memory per worker, and the changed-upstream lane its own worker cap', () => {
    expect(CHECKS.find(check => check.id === 'tests:fork')?.memoryBytes).toBe(12 * 0.5 * GIB)
    expect(CHECKS.find(check => check.id === 'tests:upstream-changed')).toMatchObject({ cpus: 8, command: [expect.stringContaining('vitest'), 'run', '--config', 'vitest.config.ts', '--maxWorkers=8', '--passWithNoTests'] })
    expect(CHECKS.find(check => check.id === 'tests:snapshots')).toMatchObject({ command: ['pnpm', 'run', '--silent', 'test:snapshot'], environment: { DSH_SNAPSHOT_MAX_CONCURRENCY: '5' }, cpus: 5, exclusive: true })
  })

  it('budgets each check by its id, then its id family, then its group, and fails a check with no budget at all', () => {
    expect(CHECKS.find(check => check.id === 'typecheck:upstream')?.budget).toEqual({ memoryGiB: 2.5 })
    expect(CHECKS.find(check => check.id === 'typecheck:delo:control')?.budget).toEqual({ memoryGiB: 1 })
    const grouped = catalog(TREE, { ...HOST, gates: [gate('secrets')] })
    expect(grouped.find(check => check.id === 'secrets')?.budget).toEqual({ memoryGiB: 0.5 })
    expect(() => catalog(TREE, { ...HOST, budgets: { tiers: {}, checks: {} } })).toThrow('budgets.json gives boundary no memory')
  })

  it('refuses two checks under one id, which the scheduler would conflate, and names the directory to rename', () => {
    const tree: ForkTree = { ...TREE, programs: [{ config: 'delo/apps/a/tsconfig.json' }, { config: 'delo/packages/a/tsconfig.json' }] }
    expect(() => catalog(tree, HOST)).toThrow('two checks are named typecheck:delo:a')
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
    expect(history).toEqual(['boundary', 'gates:personal-data', 'gates:dco', 'gates:commits', 'gates:changelog', 'gates:doc-times'])
    expect(CHECKS.find(check => check.id === 'tests:fork')?.scope).toBeUndefined()
  })

  it('builds the runtime bundles only when they are missing or stale, and the lanes that run built code wait for that build', () => {
    expect(CHECKS.some(check => check.id === 'build:artifacts')).toBe(false)
    const stale = catalog(TREE, { ...HOST, staleRuntime: ['apps/cli'] })
    expect(stale.find(check => check.id === 'build:artifacts')).toMatchObject({ command: ['pnpm', 'run', '--silent', 'build:artifacts'], needs: [], tiers: ['changed', 'full'] })
    expect(stale.find(check => check.id === 'build:artifacts')?.environment).toBeUndefined()
    for (const id of ['tests:snapshots', 'tests:upstream-changed', 'tests:fork']) expect(stale.find(check => check.id === id)?.needs).toEqual(['generate:native', 'build:artifacts'])
  })
})

describe('selection', () => {
  it('runs every default check with no target, and neither the changed-upstream lane nor the native build by a tier of its own', () => {
    expect(ids(select(CHECKS, TREE, NONE))).toEqual(['boundary', 'jsdoc', 'typecheck:upstream', 'typecheck:delo:control', 'typecheck:delo:control-tests', 'typecheck:delo:cell', 'typecheck:delo:control-protocol', 'typecheck:delo:providers', 'typecheck:delo:client-status', 'typecheck:delo:client-status-tests', 'docs-site', 'generated:notices', 'generate:native', 'tests:fork', 'tests:snapshots', 'parity-switches', 'parity-replay'])
    expect(CHECKS.find(check => check.id === 'generate:native')?.tiers).toEqual([])
    expect(ids(select(CHECKS, TREE, { ...NONE, only: ['generate:native'] }))).toEqual(['generate:native'])
  })

  it('replays upstream\'s recorded sessions when an upstream-owned path changed, and not for a fork-only change', () => {
    const snapshots = (paths: string[]) => select(CHECKS, TREE, { ...NONE, changed: { base: 'b', paths } }).find(check => check.id === 'tests:snapshots')
    expect(snapshots(['packages/boot/plugin-manager/src/index.ts'])?.reason).toBe('upstream-owned code changed (packages/boot/plugin-manager/src/index.ts)')
    expect(snapshots(['delo/packages/control-protocol/src/messages.ts'])).toBeUndefined()
  })

  it('narrows a target to its package\'s programs and specs, its dependents\' programs, the boundary and the JSDoc check', () => {
    const plan = select(CHECKS, TREE, { ...NONE, targets: ['delo/packages/control-protocol/src/messages.ts'] })
    expect(ids(plan)).toEqual(['boundary', 'jsdoc', 'typecheck:upstream', 'typecheck:delo:control', 'typecheck:delo:control-tests', 'typecheck:delo:cell', 'typecheck:delo:control-protocol', 'generate:native', 'tests:fork'])
    expect(plan.find(check => check.id === 'typecheck:delo:cell')?.reason).toBe('delo/apps/cell depends on a changed package')
    expect(plan.find(check => check.id === 'tests:fork')?.command.slice(-1)).toEqual(['delo/packages/control-protocol/'])
  })

  it('offers the Docker lane only in a tree with Docker specs, and runs it on the packages a change reaches', () => {
    expect(CHECKS.some(check => check.id === 'tests:docker')).toBe(false)
    const tree: ForkTree = { ...TREE, packages: TREE.packages.map(pkg => pkg.name === '@delo/providers' ? { ...pkg, dockerSpecs: true } : pkg) }
    const checks = catalog(tree, HOST)
    const docker = checks.find(check => check.id === 'tests:docker')
    expect(docker?.command).toEqual(['node_modules/.bin/vitest', 'run', '--config', 'delo/vitest.docker.config.ts', '--passWithNoTests'])
    const reached = select(checks, tree, { ...NONE, changed: { base: 'v5', paths: ['delo/packages/providers/src/index.ts'] } }).find(check => check.id === 'tests:docker')
    expect(reached?.reason).toBe('Docker specs of a package a change reaches (delo/packages/providers)')
    expect(reached?.scope).toEqual(['delo/apps/control/', 'delo/packages/providers/', 'delo/packages/client-status/'])
    expect(ids(select(checks, tree, { ...NONE, changed: { base: 'v5', paths: ['delo/apps/cell/src/index.ts'] } }))).not.toContain('tests:docker')
  })

  it('passes spec paths to the fork suite as they are', () => {
    const plan = select(CHECKS, TREE, { ...NONE, targets: ['delo/apps/control/tests/front.spec.ts'] })
    expect(plan.find(check => check.id === 'tests:fork')?.command.slice(-1)).toEqual(['delo/apps/control/tests/front.spec.ts'])
  })

  it('runs the fork suite on the packages a change reaches, by directory, dependents included, and never with vitest\'s related-file selection', () => {
    const plan = select(CHECKS, TREE, { ...NONE, changed: { base: 'v5', paths: ['delo/packages/providers/src/index.ts'] } })
    const fork = plan.find(check => check.id === 'tests:fork')
    expect(fork?.command.slice(-3)).toEqual(['delo/apps/control/', 'delo/packages/providers/', 'delo/packages/client-status/'])
    expect(fork?.command).not.toContain('--changed')
    expect(fork?.reason).toBe('specs of the packages a change reaches, dependents included')
    expect(fork?.scope).toEqual(['delo/apps/control/', 'delo/packages/providers/', 'delo/packages/client-status/'])
    expect(ids(plan)).not.toContain('typecheck:delo:cell')
  })

  it('runs every fork spec for a fork-wide change, such as the checks runner\'s own sources', () => {
    const fork = select(CHECKS, TREE, { ...NONE, changed: { base: 'v5', paths: ['delo/apps/tools/src/checks/plan.ts'] } }).find(check => check.id === 'tests:fork')
    expect(fork?.command).toEqual(['node_modules/.bin/vitest', 'run', '--config', 'delo/vitest.config.ts', '--maxWorkers=12'])
  })

  it('checks every program when code outside every package changes, such as a build script', () => {
    const plan = select(CHECKS, TREE, { ...NONE, changed: { base: 'v5', paths: ['scripts/build.ts'] } })
    expect(ids(plan)).toEqual(expect.arrayContaining(['typecheck:delo:control', 'typecheck:delo:cell', 'typecheck:delo:providers', 'typecheck:delo:client-status']))
    expect(plan.find(check => check.id === 'tests:fork')?.command.slice(-1)).toEqual(['--maxWorkers=12'])
  })

  it('reaches only the fork packages that depend on a changed upstream package, directly or through upstream dependents', () => {
    const tree: ForkTree = { ...TREE, packages: TREE.packages.map(pkg => pkg.name === '@delo/providers' ? { ...pkg, upstreamDependencies: ['@deepseek-ai/dsh-agent-loop'] } : pkg) }
    const plan = select(catalog(tree, HOST), tree, { ...NONE, changed: { base: 'v5', paths: ['packages/core/session/src/index.ts'] } })
    expect(ids(plan)).toEqual(expect.arrayContaining(['typecheck:upstream', 'typecheck:delo:providers', 'typecheck:delo:control', 'typecheck:delo:client-status-tests', 'tests:fork', 'tests:upstream-changed']))
    expect(ids(plan)).not.toContain('typecheck:delo:cell')
    const leaf = select(catalog(tree, HOST), tree, { ...NONE, changed: { base: 'v5', paths: ['packages/shell/shell/src/index.ts'] } })
    expect(ids(leaf)).toEqual(expect.arrayContaining(['typecheck:upstream', 'tests:upstream-changed']))
    expect(ids(leaf).filter(id => id.startsWith('typecheck:delo'))).toEqual([])
    expect(ids(leaf)).not.toContain('tests:fork')
  })

  it('keeps only the named checks and groups with their needs, drops skipped needs, and selects a tier\'s family by its prefix', () => {
    expect(ids(select(CHECKS, TREE, { ...NONE, only: ['typecheck:delo:cell'] }))).toEqual(['typecheck:upstream', 'typecheck:delo:cell'])
    const skipped = select(CHECKS, TREE, { ...NONE, only: ['typecheck:delo:cell'], skip: ['typecheck:upstream'] })
    expect(ids(skipped)).toEqual(['typecheck:delo:cell'])
    expect(skipped.find(check => check.id === 'typecheck:delo:cell')?.needs).toEqual([])
    expect(ids(select(CHECKS, TREE, { ...NONE, only: ['typecheck:delo'] })).filter(id => id.startsWith('typecheck:delo'))).toHaveLength(7)
    expect(ids(select(CHECKS, TREE, { ...NONE, skip: ['tests'] })).some(id => id.startsWith('tests:'))).toBe(false)
  })

  it('names the --only and --skip selectors that match no check, so a typo cannot select nothing and pass', () => {
    expect(unknownSelectors(CHECKS, ['tests:fork', 'tests', 'typecheck:delo', 'tests:forkk', 'nope'])).toEqual(['tests:forkk', 'nope'])
  })

  it('follows dependents transitively', () => {
    const packages = [
      { name: '@delo/a', dir: 'delo/packages/a', forkDependencies: [], upstreamDependencies: [], ownWorkspace: false },
      { name: '@delo/b', dir: 'delo/packages/b', forkDependencies: ['@delo/a'], upstreamDependencies: [], ownWorkspace: false },
      { name: '@delo/c', dir: 'delo/apps/c', forkDependencies: ['@delo/b'], upstreamDependencies: [], ownWorkspace: false },
      { name: '@delo/d', dir: 'delo/apps/d', forkDependencies: [], upstreamDependencies: [], ownWorkspace: false },
    ]
    expect([...withDependents(packages, new Set(['@delo/a']))].sort()).toEqual(['@delo/a', '@delo/b', '@delo/c'])
    expect(packageDirOf('delo/apps/cell/src/x.ts')).toBe('delo/apps/cell')
    expect(packageDirOf('delo/vitest.config.ts')).toBeUndefined()
  })
})

describe('the pre-commit tier', () => {
  const GATED = catalog(TREE, { ...HOST, gates: [gate('gates:secrets', { staged: true }), gate('gates:docs')] })

  it('runs only the staged gates and the whitespace check, with the staged paths appended to their commands', () => {
    const plan = selectPreCommit(GATED, ['delo/a.ts', 'README.md'])
    expect(ids(plan)).toEqual(['gates:secrets', 'whitespace:staged'])
    expect(plan[0]?.command).toEqual(['node', 'gates:secrets.ts', 'delo/a.ts', 'README.md'])
    expect(plan[1]?.command).toEqual(['git', 'diff', '--cached', '--check', '--', 'delo/a.ts', 'README.md'])
    expect(plan.every(check => check.declined === undefined)).toBe(true)
  })

  it('declines the tier\'s checks when no path is staged, rather than checking the whole tree', () => {
    const plan = selectPreCommit(GATED, [])
    expect(plan.map(check => check.declined)).toEqual(['no staged file to check', 'no staged file to check'])
    expect(plan[0]?.command).toEqual(['node', 'gates:secrets.ts'])
  })

  it('leaves the whitespace check out of every other tier', () => {
    expect(ids(select(GATED, TREE, { ...NONE, changed: { base: 'v5', paths: ['delo/packages/providers/src/index.ts'] } }))).not.toContain('whitespace:staged')
    expect(ids(select(GATED, TREE, NONE))).toEqual(expect.arrayContaining(['gates:secrets', 'gates:docs']))
  })
})

describe('the parity checks', () => {
  it('replay upstream\'s scenarios through the overlay with no inputs, so a selection always runs them, after a stale build', () => {
    const replay = CHECKS.find(check => check.id === 'parity-replay')
    expect(replay).toMatchObject({ group: 'parity', command: ['pnpm', 'run', '--silent', 'test:snapshot'], environment: { DSH_SNAPSHOT_PATCH: PARITY_OVERLAY_PATH, DSH_SNAPSHOT_MAX_CONCURRENCY: '5' }, needs: ['generate:native'], exclusive: true })
    expect(replay?.inputs).toBeUndefined()
    expect(catalog(TREE, { ...HOST, staleRuntime: ['apps/cli'] }).find(check => check.id === 'parity-replay')?.needs).toEqual(['generate:native', 'build:artifacts'])
    expect(CHECKS.find(check => check.id === 'parity-switches')?.command).toEqual(['node_modules/.bin/tsx', 'delo/apps/tools/src/parity/composition/check-parity-switches.ts'])
  })

  it('run when Delo code or an upstream edit changes, and not for documentation alone or a narrowed target', () => {
    const parity = (paths: string[]) => ids(select(CHECKS, TREE, { ...NONE, changed: { base: 'b', paths } })).filter(id => id.startsWith('parity-'))
    for (const path of ['delo/packages/control-protocol/src/messages.ts', 'delo/apps/tools/src/parity/composition/parity.overlay.yml', 'packages/boot/plugin-manager/src/tools.ts', 'snapshots/session/text-turn/runtime.cordis.yml']) {
      expect(affectsParity(path)).toBe(true)
      expect(parity([path])).toEqual(['parity-switches', 'parity-replay'])
    }
    for (const path of ['delo/docs/contracts/c16-parity-composition.md', 'delo/apps/tools/README.i18n.yaml', 'docs/architecture.md']) expect(parity([path])).toEqual([])
    expect(ids(select(CHECKS, TREE, { ...NONE, targets: ['delo/packages/control-protocol/src/messages.ts'] }))).not.toContain('parity-replay')
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
    for (const path of ['pnpm-lock.yaml', 'package.json', 'delo/apps/cli/package.json', 'packages/core/session/package.json', 'THIRD_PARTY_NOTICES.md', 'scripts/gen-third-party-notices.ts']) expect(selected([path])).toContain('generated:notices')
    for (const path of ['delo/apps/cli/src/main.ts', 'packages/core/session/src/index.ts', 'docs/architecture.md']) expect(selected([path])).not.toContain('generated:notices')
  })
})

describe('the documentation website check', () => {
  const selected = (paths: string[]) => ids(select(CHECKS, TREE, { ...NONE, changed: { base: 'b', paths } }))

  it('builds through its launcher, which names the install command when the site has no dependencies, with the site, Delo\'s pages and the release version as its inputs', () => {
    expect(CHECKS.find(check => check.id === 'docs-site')).toMatchObject({
      group: 'docs-site',
      command: ['node_modules/.bin/tsx', 'delo/apps/tools/src/check-docs-site.ts'],
      needs: [],
      tiers: ['changed', 'full'],
      inputs: ['delo/apps/docs/**', 'delo/docs/**', 'delo/apps/release/package.json'],
    })
    expect(BUDGETS.checks['docs-site']).toEqual({ memoryGiB: 2, seconds: 900 })
  })

  it('is selected by a change under the site, under delo/docs, or to the release version the site names, and by no other change', () => {
    for (const path of ['delo/apps/docs/source.config.ts', 'delo/docs/guide/trust.md', 'delo/docs/reference/divergence/README.zh.md', 'delo/apps/release/package.json']) expect(selected([path])).toContain('docs-site')
    for (const path of ['delo/apps/cell/src/index.ts', 'delo/apps/release/src/index.ts', 'packages/core/session/src/index.ts', 'docs/architecture.md']) expect(selected([path])).not.toContain('docs-site')
  })

  it('leaves the fork suite out of a change under the site, since the site is its own workspace with no fork specs', () => {
    expect(packageDirOf('delo/apps/docs/source.config.ts')).toBeUndefined()
    expect(selected(['delo/apps/docs/source.config.ts'])).not.toContain('tests:fork')
    expect(selected(['delo/apps/docs/source.config.ts'])).toContain('docs-site')
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

  it('hands the changed-upstream lane pnpm\'s script environment even when no other planned check runs pnpm', () => {
    // The native build runs pnpm too, so it is skipped here to leave the lane alone in the plan.
    const plan = select(CHECKS, TREE, { ...NONE, only: ['tests:upstream-changed'], skip: ['generate:native'], changed: { base: 'base', paths: ['packages/core/session/src/index.ts'] } })
    expect(plan.map(check => check.id)).toEqual(['tests:upstream-changed'])
    expect(plan.some(readsPnpmScriptEnvironment)).toBe(true)
    expect(readsPnpmScriptEnvironment({ command: ['pnpm', 'run', 'typecheck'] })).toBe(true)
    expect(readsPnpmScriptEnvironment({ command: ['node_modules/.bin/vitest', 'run'] })).toBe(false)
  })

  it('leaves the changed-upstream lane out of a fork-only change and the full gate, and declines it with nothing to narrow to', () => {
    expect(ids(select(CHECKS, TREE, { ...NONE, changed: { base: 'base', paths: ['delo/apps/control/src/index.ts'] } }))).not.toContain('tests:upstream-changed')
    expect(ids(select(CHECKS, TREE, NONE))).not.toContain('tests:upstream-changed')
    expect(select(CHECKS, TREE, { ...NONE, only: ['tests:upstream-changed'] }).find(check => check.id === 'tests:upstream-changed')?.declined).toBe('no upstream package changed')
  })
})

describe('ordering', () => {
  it('ranks a check by its own time and the longest chain waiting for it', () => {
    const plan = select(CHECKS, TREE, NONE)
    const chain = criticalPath(plan, { 'typecheck:upstream': 30, 'typecheck:delo:cell': 8, 'tests:fork': 40 })
    expect(chain.get('typecheck:delo:cell')).toBe(8)
    expect(chain.get('typecheck:upstream')).toBe(38)
    expect(chain.get('tests:fork')).toBe(40)
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
    expect(scopeCommand(['node', 'run-checks.ts'], 13 * GIB)).toEqual(['systemd-run', '--user', '--scope', '--quiet', '--collect', '-p', `MemoryMax=${String(13 * GIB)}`, '-p', 'MemorySwapMax=0', '-p', 'CPUWeight=50', '-p', 'IOWeight=50', '--description=delo checks', '--', 'node', 'run-checks.ts'])
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
    logDir = mkdtempSync(join(tmpdir(), 'delo-checks-spec-'))
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
    logDir = mkdtempSync(join(tmpdir(), 'delo-checks-spec-'))
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
