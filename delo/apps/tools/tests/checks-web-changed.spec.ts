/**
 * The web browser lane: which inventory specs a change reaches, the cap above which the lane is declined, the WebKit
 * exclusion, the lane's steps and environment, and its wall-clock budget.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { catalog, select, type Budgets, type ForkTree, type Host, type Planned } from '../src/checks/plan.ts'
import { laneEnvironment, readSpecImports, readWebSpecs, refusal, selectWebLane, WEB_BUILD_COMMAND, WEB_CHECK_ID, WEB_LANE_MODULE, WEB_SPEC_CAP, webLaneSteps, type WebSpec, type WorkspacePackage } from '../src/checks/web.ts'

const BUDGETS = JSON.parse(readFileSync(new URL('../src/checks/budgets.json', import.meta.url), 'utf8')) as Budgets
const PACKAGES: WorkspacePackage[] = [
  { name: '@deepseek-ai/dsh-web-frontend', dir: 'apps/web' },
  { name: '@deepseek-ai/dsh-client-ui-status', dir: 'packages/client/ui-status' },
  { name: '@deepseek-ai/dsh-client-ui-quiet', dir: 'packages/client/ui-quiet' },
  { name: '@deepseek-ai/dsh-client-ui-other', dir: 'packages/client/ui-other' },
  { name: '@deepseek-ai/dsh-client-ui-cap', dir: 'packages/client/ui-cap' },
  { name: '@deepseek-ai/dsh-session', dir: 'packages/core/session' },
  { name: '@deepseek-ai/dsh-unrelated', dir: 'packages/core/unrelated' },
]
const HOST: Host = { workers: { fork: 4, upstream: 4 }, cacheDir: 'node_modules/.cache/delo-checks', budgets: BUDGETS, staleRuntime: [], gates: [] }
/** A planted inventory: one spec per behaviour the lane must tell apart. */
const SPECS: Readonly<Record<string, string>> = {
  'apps/web/tests/scaffold.ts': 'export const launchWebScaffold = (): void => undefined\n',
  'apps/web/tests/status-panel.e2e.ts': "import { panel } from '@deepseek-ai/dsh-client-ui-status'\nimport { launchWebScaffold } from './scaffold.ts'\n",
  'apps/web/tests/session-replay.e2e.ts': "import { replay } from '@deepseek-ai/dsh-session'\nimport { launchWebScaffold } from './scaffold.ts'\n",
  'apps/web/tests/plain-load.e2e.ts': "import { launchWebScaffold } from './scaffold.ts'\n",
  'apps/web/tests/engine-matrix.e2e.ts': "import { chromium, webkit } from 'playwright'\nimport { launchWebScaffold } from './scaffold.ts'\n",
  'apps/web/tests/ui-other-badge.e2e.ts': "it('shows the badge', () => undefined)\n",
  'apps/web/tests/unmapped-probe.e2e.ts': "it('probes', () => undefined)\n",
}

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/**
 * A temporary repository holding the given files.
 * @param files - repository-relative paths and their text.
 * @returns the repository root.
 */
function plant(files: Readonly<Record<string, string>>): string {
  const root = mkdtempSync(join(tmpdir(), 'delo-web-lane-'))
  roots.push(root)
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(root, dirname(path)), { recursive: true })
    writeFileSync(join(root, path), text)
  }
  return root
}

/**
 * The inventory of the planted repository.
 * @returns the specs, read from the planted sources.
 */
function inventory(): WebSpec[] {
  return readWebSpecs(plant(SPECS), PACKAGES)
}

/**
 * Inventory specs that all map to one package, for the cap.
 * @param count - how many specs.
 * @returns the specs, each mapped to `packages/client/ui-cap`.
 */
function capped(count: number): WebSpec[] {
  return Array.from({ length: count }, (_, index) => ({ path: `apps/web/tests/cap-${String(index)}.e2e.ts`, packages: ['packages/client/ui-cap'], webkit: false }))
}

/**
 * The catalogue's fixture tree: upstream's packages and the given inventory.
 * @param webSpecs - the inventory.
 * @returns the tree.
 */
function treeOf(webSpecs: readonly WebSpec[]): ForkTree {
  return { packages: [], programs: [], upstream: PACKAGES.map(pkg => ({ ...pkg, dependencies: [], runtimeDependencies: [], specs: 0 })), webSpecs }
}

/**
 * The web lane's entry in the plan for a change, when the plan picks it.
 * @param paths - the changed paths.
 * @param webSpecs - the inventory.
 * @returns the planned lane, or undefined when the plan does not pick it.
 */
function planFor(paths: readonly string[], webSpecs: readonly WebSpec[]): Planned | undefined {
  const tree = treeOf(webSpecs)
  return select(catalog(tree, HOST), tree, { targets: [], changed: { base: 'v5', paths }, only: [], skip: [] }).find(check => check.id === WEB_CHECK_ID)
}

describe('the web lane inventory', () => {
  it('maps each spec to the packages its imports and relative imports reach, and flags a WebKit spec', () => {
    const byPath = new Map(inventory().map(spec => [spec.path, spec]))
    expect(byPath.get('apps/web/tests/status-panel.e2e.ts')).toEqual({ path: 'apps/web/tests/status-panel.e2e.ts', packages: ['apps/web', 'packages/client/ui-status'], webkit: false })
    expect(byPath.get('apps/web/tests/plain-load.e2e.ts')?.packages).toEqual(['apps/web'])
    expect(byPath.get('apps/web/tests/engine-matrix.e2e.ts')?.webkit).toBe(true)
    expect(byPath.get('apps/web/tests/status-panel.e2e.ts')?.webkit).toBe(false)
    expect([...byPath.keys()].some(path => path.endsWith('scaffold.ts'))).toBe(false)
  })

  it('maps a spec with no import by a package directory its file name carries, and leaves an unrelated name unmapped', () => {
    const byPath = new Map(inventory().map(spec => [spec.path, spec]))
    expect(byPath.get('apps/web/tests/ui-other-badge.e2e.ts')?.packages).toEqual(['packages/client/ui-other'])
    expect(byPath.get('apps/web/tests/unmapped-probe.e2e.ts')?.packages).toEqual([])
  })

  it('reads WebKit only from a value import of playwright, not from a type import or Chromium alone', () => {
    expect(readSpecImports('a.e2e.ts', "import { chromium, webkit as engine } from 'playwright'\n").webkit).toBe(true)
    expect(readSpecImports('a.e2e.ts', "import { chromium } from 'playwright'\nimport type { Browser } from 'playwright'\n").webkit).toBe(false)
  })

  it('reads dynamic and re-exported module specifiers, so a spec maps to a package they reach', () => {
    const { specifiers } = readSpecImports('apps/web/tests/a.e2e.ts', "export { panel } from '@deepseek-ai/dsh-client-ui-status'\nawait import('@deepseek-ai/dsh-session')\n")
    expect(specifiers).toEqual(['@deepseek-ai/dsh-client-ui-status', '@deepseek-ai/dsh-session'])
  })
})

describe('the web lane selection', () => {
  it('is left to the merge tier: the agent tier omits it, and the merge tier plans it', () => {
    const tree = treeOf(capped(1))
    const plan = (tier: 'agent' | 'merge') => select(catalog(tree, HOST), tree, { targets: [], changed: { base: 'v5', paths: ['packages/client/ui-cap/src/index.ts'] }, tier, only: [], skip: [] }).map(check => check.id)
    expect(plan('merge')).toContain(WEB_CHECK_ID)
    expect(plan('agent')).not.toContain(WEB_CHECK_ID)
  })

  it('selects the specs mapped to a changed client package', () => {
    expect(selectWebLane(inventory(), ['packages/client/ui-status/src/panel.ts'], PACKAGES, false).specs).toEqual(['apps/web/tests/status-panel.e2e.ts'])
  })

  it('reaches a client package no spec maps to, but selects nothing, and a documentation-only client change reaches nothing', () => {
    const quiet = selectWebLane(inventory(), ['packages/client/ui-quiet/src/index.ts'], PACKAGES, false)
    expect(quiet).toMatchObject({ reached: true, specs: [] })
    expect(quiet.declined).toContain('no web e2e spec maps to the change')
    expect(selectWebLane(inventory(), ['packages/client/ui-status/README.md'], PACKAGES, false)).toMatchObject({ reached: false, specs: [] })
  })

  it('selects nothing and does not reach the lane for a change to an unrelated package', () => {
    expect(selectWebLane(inventory(), ['packages/core/unrelated/src/index.ts'], PACKAGES, false)).toMatchObject({ reached: false, specs: [] })
    expect(planFor(['packages/core/unrelated/src/index.ts'], inventory())).toBeUndefined()
  })

  it('selects the specs that import a changed package, and no other spec', () => {
    const selected = selectWebLane(inventory(), ['packages/core/session/src/index.ts'], PACKAGES, false).specs
    expect(selected).toEqual(['apps/web/tests/session-replay.e2e.ts'])
    expect(selected).not.toContain('apps/web/tests/plain-load.e2e.ts')
  })

  it('selects a changed spec itself, even when no package maps to it, and no sibling spec', () => {
    const selected = selectWebLane(inventory(), ['apps/web/tests/unmapped-probe.e2e.ts'], PACKAGES, false).specs
    expect(selected).toEqual(['apps/web/tests/unmapped-probe.e2e.ts'])
    expect(selectWebLane(inventory(), ['apps/web/tests/plain-load.e2e.ts'], PACKAGES, false).specs).toEqual(['apps/web/tests/plain-load.e2e.ts'])
  })

  it('selects every spec that imports a changed helper under apps/web, and no spec that imports none of it', () => {
    const selected = selectWebLane(inventory(), ['apps/web/tests/scaffold.ts'], PACKAGES, false).specs
    expect(selected).toEqual(['apps/web/tests/plain-load.e2e.ts', 'apps/web/tests/session-replay.e2e.ts', 'apps/web/tests/status-panel.e2e.ts'])
    expect(selected).not.toContain('apps/web/tests/ui-other-badge.e2e.ts')
  })

  it('never selects a WebKit spec, even when its own file changed or its package changed', () => {
    expect(selectWebLane(inventory(), ['apps/web/tests/engine-matrix.e2e.ts'], PACKAGES, false).specs).not.toContain('apps/web/tests/engine-matrix.e2e.ts')
    expect(selectWebLane(inventory(), ['apps/web/tests/plain-load.e2e.ts'], PACKAGES, false).specs).toContain('apps/web/tests/plain-load.e2e.ts')
  })

  it('runs a selection at the cap, and declines one above it with the count, instead of running part of it', () => {
    const atCap = selectWebLane(capped(WEB_SPEC_CAP), ['packages/client/ui-cap/src/a.ts'], PACKAGES, false)
    expect(atCap.specs).toHaveLength(WEB_SPEC_CAP)
    const above = selectWebLane(capped(WEB_SPEC_CAP + 1), ['packages/client/ui-cap/src/a.ts'], PACKAGES, false)
    expect(above.specs).toEqual([])
    expect(above.declined).toContain(`${String(WEB_SPEC_CAP + 1)} web e2e specs reach the change, above the cap of ${String(WEB_SPEC_CAP)}`)
  })

  it('runs the whole small inventory for a run that names no change, and declines a large one', () => {
    const small = selectWebLane(inventory(), [], PACKAGES, true)
    expect(small.declined).toBeUndefined()
    expect(small.specs).not.toContain('apps/web/tests/engine-matrix.e2e.ts')
    const large = selectWebLane(capped(WEB_SPEC_CAP + 1), [], PACKAGES, true)
    expect(large.specs).toEqual([])
    expect(large.declined).toContain('name a change with --changed or a target')
  })

  it('does not treat an empty change set as a run that names nothing', () => {
    expect(selectWebLane(inventory(), [], PACKAGES, false)).toMatchObject({ reached: false, specs: [] })
  })

  it('declines a run that names no change while the inventory is empty', () => {
    expect(selectWebLane([], [], PACKAGES, true).declined).toContain('no web e2e spec in the inventory')
  })
})

describe('the web lane command and environment', () => {
  it('is a changed-tier check that declares no inputs, so it always runs when a change reaches it', () => {
    const check = catalog(treeOf([]), HOST).find(candidate => candidate.id === WEB_CHECK_ID)
    expect(check).toMatchObject({ group: 'tests', tiers: ['changed'], needs: [], command: ['node_modules/.bin/tsx', WEB_LANE_MODULE] })
    expect(check?.inputs).toBeUndefined()
  })

  it('runs the selected specs as the lane command\'s arguments, and no other spec', () => {
    expect(planFor(['packages/client/ui-status/src/panel.ts'], inventory())?.command).toEqual(['node_modules/.bin/tsx', WEB_LANE_MODULE, 'apps/web/tests/status-panel.e2e.ts'])
    expect(planFor(['packages/client/ui-status/src/panel.ts'], inventory())?.command).not.toContain('apps/web/tests/engine-matrix.e2e.ts')
  })

  it('builds the official client first, then runs the specs under upstream\'s web configuration with WebKit left out', () => {
    const [build, tests] = webLaneSteps(['apps/web/tests/status-panel.e2e.ts'])
    expect(build).toEqual(['pnpm', 'run', '--silent', 'build:artifacts'])
    expect(build).toEqual(WEB_BUILD_COMMAND)
    expect(tests).toEqual(['node_modules/.bin/vitest', 'run', '--config', 'vitest.web.config.ts', 'apps/web/tests/status-panel.e2e.ts'])
    expect(tests?.join(' ')).not.toContain('engine-matrix')
  })

  it('runs both steps with the official profile, the replay mode and no DeepSeek key, whatever the parent set', () => {
    const child = laneEnvironment({ PATH: '/bin', DEEPSEEK_API_KEY: 'key', DSH_BUILD_CLIENT_PROFILE: 'local', DSH_SNAPSHOT: 'record' })
    expect(child).toMatchObject({ PATH: '/bin', DSH_BUILD_CLIENT_PROFILE: 'official', DSH_SNAPSHOT: 'replay' })
    expect(child).not.toHaveProperty('DEEPSEEK_API_KEY')
    expect(laneEnvironment({})).toMatchObject({ DSH_BUILD_CLIENT_PROFILE: 'official', DSH_SNAPSHOT: 'replay' })
  })

  it('refuses a path that is not an inventory spec, a missing one, and a spec that runs WebKit, and accepts a Chromium spec', () => {
    const root = plant(SPECS)
    expect(refusal(root, 'apps/web/tests/status-panel.e2e.ts')).toBeUndefined()
    expect(refusal(root, 'apps/web/tests/engine-matrix.e2e.ts')).toContain('runs WebKit')
    expect(refusal(root, 'apps/web/tests/absent.e2e.ts')).toContain('does not exist')
    expect(refusal(root, 'packages/core/session/src/index.ts')).toContain('is not a')
    expect(refusal(root, 'apps/web/tests/scaffold.ts')).toContain('is not a')
  })
})

describe('the web lane budget', () => {
  it('gives the lane memory, exclusivity and a wall-clock budget in budgets.json', () => {
    const entry = BUDGETS.checks[WEB_CHECK_ID]
    expect(entry).toMatchObject({ exclusive: true })
    expect(entry?.memoryGiB).toBeGreaterThan(0)
    expect(entry?.seconds).toBeGreaterThan(0)
  })

  it('refuses to catalogue the lane without a budget entry, and the same catalogue with one', () => {
    const without = { ...BUDGETS, checks: Object.fromEntries(Object.entries(BUDGETS.checks).filter(([id]) => id !== WEB_CHECK_ID)) }
    expect(() => catalog(treeOf([]), { ...HOST, budgets: without })).toThrow(`budgets.json gives ${WEB_CHECK_ID} no memory`)
    expect(catalog(treeOf([]), HOST).find(candidate => candidate.id === WEB_CHECK_ID)?.budget).toBe(BUDGETS.checks[WEB_CHECK_ID])
  })
})
