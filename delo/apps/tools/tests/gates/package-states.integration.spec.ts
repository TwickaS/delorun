import { describe, expect, it } from 'vitest'
import {
  PACKAGE_STATES,
  readWorkspace,
  reachable,
  ROOT_DIRS,
  stateErrors,
  summaryLines,
  type StatePackage,
} from '../../src/checks/gates/package-states.ts'
import { gatePath, REPO, runTsx, scratchRepo } from './support.ts'

/** A package fixture whose directory is `delo/packages/<name>`. */
function pkg(name: string, state: StatePackage['state'], dependencies: string[] = [], unreached?: string): StatePackage {
  return { name, dir: `delo/packages/${name}`, state, unreached, dependencies, devDependencies: [] }
}

const ROOTS = ['delo/packages/root']

/** A healthy graph: root -> leaf, a parked package nobody uses, and an unreached package nobody uses. */
function healthy(): StatePackage[] {
  return [pkg('root', 'shipped', ['leaf', 'external']), pkg('leaf', 'experimental'), pkg('idle', 'shipped', [], 'lane'), pkg('old', 'parked', ['leaf'])]
}

const manifest = (name: string, delo: unknown, extra: Record<string, unknown> = {}): string => JSON.stringify({ name, delo, ...extra })

describe('gates:package-states rules', () => {
  it('passes a graph whose states agree with what the roots reach', () => {
    expect(stateErrors(healthy(), ROOTS)).toEqual([])
    expect([...reachable(healthy(), ROOTS)].sort()).toEqual(['leaf', 'root'])
  })

  it('refuses a shipped package that nothing reaches', () => {
    expect(stateErrors([...healthy(), pkg('orphan', 'shipped')], ROOTS)).toEqual([
      'orphan: is shipped but no root reaches it; wire it, or mark it unreached with the lane that wires it, or park it',
    ])
  })

  it('refuses an unreached package that a root reaches', () => {
    const packages = [pkg('root', 'shipped', ['wired']), pkg('wired', 'experimental', [], 'studio')]
    expect(stateErrors(packages, ROOTS)).toEqual([
      'wired: is marked unreached "studio" but a root reaches it; remove the marker in the change that wires it',
    ])
  })

  it('refuses the unreached marker on a parked package', () => {
    expect(stateErrors([pkg('root', 'shipped'), pkg('old', 'parked', [], 'lane')], ROOTS)).toEqual([
      'old: is parked and marked unreached "lane"; only a shipped or experimental package carries the marker',
    ])
  })

  it('refuses a parked package that a root reaches, and names the shipped dependant', () => {
    const packages = [pkg('root', 'shipped', ['old']), pkg('old', 'parked')]
    expect(stateErrors(packages, ROOTS)).toEqual([
      'root: shipped package depends on parked old',
      'old: is parked but a root reaches it',
    ])
  })

  it('refuses a shipped package, even an unreached one, that depends on a parked one', () => {
    const packages = [pkg('root', 'shipped'), pkg('idle', 'shipped', ['old'], 'lane'), pkg('old', 'parked')]
    expect(stateErrors(packages, ROOTS)).toEqual(['idle: shipped package depends on parked old'])
  })

  it('lets a parked package depend on a parked one', () => {
    expect(stateErrors([pkg('root', 'shipped'), pkg('a', 'parked', ['b']), pkg('b', 'parked')], ROOTS)).toEqual([])
  })

  it('refuses a package with a missing or invalid "delo" field, naming it', () => {
    expect(stateErrors([pkg('root', 'shipped'), pkg('bare', undefined)], ROOTS)).toEqual([
      'bare: delo/packages/bare/package.json has no valid "delo" field; expected {"state": "shipped" | "experimental" | "parked", "unreached"?: "<lane>"}',
    ])
  })
})

describe('gates:package-states workspace', () => {
  it('reads states, markers and all three dependency sections, and lists directories without a manifest', (test) => {
    const repo = scratchRepo(test)
    repo.write({
      'delo/apps/cli/package.json': manifest('@delo/cli', { state: 'shipped' }, {
        dependencies: { '@delo/a': '1' },
        peerDependencies: { '@delo/b': '1' },
        optionalDependencies: { '@delo/c': '1' },
      }),
      'delo/packages/a/package.json': manifest('@delo/a', { state: 'experimental', unreached: 'lane', connections: ['agent:codex'] }),
      'delo/packages/b/package.json': manifest('@delo/b', { state: 'shipped', extra: 1 }),
      'delo/packages/c/package.json': manifest('@delo/c', undefined),
      'delo/packages/spike/notes.md': 'x',
      'delo/packages/README.txt': 'not a directory',
    })
    const workspace = readWorkspace(repo.root)
    expect(workspace.withoutManifest).toEqual(['delo/packages/spike'])
    expect(workspace.packages.map(({ name, state, unreached, dependencies }) => ({ name, state, unreached, dependencies }))).toEqual([
      { name: '@delo/a', state: 'experimental', unreached: 'lane', dependencies: [] },
      { name: '@delo/b', state: undefined, unreached: undefined, dependencies: [] },
      { name: '@delo/c', state: undefined, unreached: undefined, dependencies: [] },
      { name: '@delo/cli', state: 'shipped', unreached: undefined, dependencies: ['@delo/a', '@delo/b', '@delo/c'] },
    ])
    expect(summaryLines(workspace)).toEqual([
      'gates:package-states: shipped (1): @delo/cli',
      'gates:package-states: experimental (1): @delo/a',
      'gates:package-states: parked (0): ',
      'gates:package-states: unreached @delo/a: lane lane',
      'gates:package-states: delo/packages/spike: no package.json, not a package',
    ])
  })

  it('reads a tree with neither workspace directory as empty', (test) => {
    expect(readWorkspace(scratchRepo(test).root)).toEqual({ packages: [], withoutManifest: [] })
  })

  it('lists the three states', () => {
    expect(PACKAGE_STATES).toEqual(['shipped', 'experimental', 'parked'])
  })

  it('passes on the real tree', () => {
    const workspace = readWorkspace(REPO)
    expect(stateErrors(workspace.packages, ROOT_DIRS)).toEqual([])
  })

  it('exits 1 naming the package on a violation and 0 on a clean tree, from the command line', (test) => {
    const bad = scratchRepo(test)
    bad.write({ 'delo/apps/cli/package.json': manifest('@delo/cli', { state: 'shipped' }), 'delo/packages/x/package.json': manifest('@delo/x', { state: 'shipped' }) })
    const failed = runTsx(bad.root, gatePath('package-states'))
    expect(failed.status).toBe(1)
    expect(failed.output).toContain('@delo/x: is shipped but no root reaches it')

    const good = scratchRepo(test)
    good.write({ 'delo/apps/cli/package.json': manifest('@delo/cli', { state: 'shipped' }) })
    const passed = runTsx(good.root, gatePath('package-states'))
    expect(passed.status).toBe(0)
    expect(passed.output).toContain('shipped (1): @delo/cli')
  }, 60_000)
})
