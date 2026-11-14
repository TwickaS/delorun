import { describe, expect, it } from 'vitest'
import type { StatePackage } from '../../src/checks/gates/package-states.ts'
import { dependencyCycles, graphErrors, TOOLING_PACKAGES, toolingErrors } from '../../src/checks/gates/workspace-graph.ts'
import { gatePath, REPO, runTsx, scratchRepo } from './support.ts'

/** A package fixture with production and development dependencies. */
function pkg(name: string, dependencies: string[] = [], devDependencies: string[] = []): StatePackage {
  return { name, dir: `delorun/packages/${name}`, state: 'shipped', unreached: undefined, dependencies, devDependencies }
}

const manifest = (name: string, extra: Record<string, unknown> = {}): string => JSON.stringify({ name, delorun: { state: 'shipped' }, ...extra })

describe('gates:workspace-graph rules', () => {
  it('finds no cycle in an acyclic graph with shared dependencies', () => {
    expect(dependencyCycles([pkg('a', ['b', 'c']), pkg('b', ['c']), pkg('c', ['external'])])).toEqual([])
  })

  it('finds a cycle that runs through a development dependency, once', () => {
    const packages = [pkg('@delorun/release', ['@delorun/runtime-closure']), pkg('@delorun/runtime-closure', ['@delorun/cli']), pkg('@delorun/cli', [], ['@delorun/release'])]
    expect(dependencyCycles(packages)).toEqual([['@delorun/release', '@delorun/runtime-closure', '@delorun/cli', '@delorun/release']])
  })

  it('finds a package that depends on itself', () => {
    expect(dependencyCycles([pkg('a', [], ['a'])])).toEqual([['a', 'a']])
  })

  it('refuses tooling the deploy root reaches over production dependencies, naming the path', () => {
    const packages = [pkg('root', ['cli']), pkg('cli', ['@delorun/release']), pkg('@delorun/release', ['@delorun/tools']), pkg('@delorun/tools')]
    expect(toolingErrors(packages, 'root')).toEqual([
      'the runtime closure carries @delorun/release, through root -> cli -> @delorun/release; a shipped package depends on release or developer tooling',
      'the runtime closure carries @delorun/tools, through root -> cli -> @delorun/release -> @delorun/tools; a shipped package depends on release or developer tooling',
    ])
  })

  it('lets a shipped package keep tooling as a development dependency', () => {
    expect(toolingErrors([pkg('root', ['cli']), pkg('cli', [], [...TOOLING_PACKAGES]), pkg('@delorun/release'), pkg('@delorun/tools')], 'root')).toEqual([])
  })

  it('refuses a deploy root that is no package', () => {
    expect(toolingErrors([pkg('cli')], '@delorun/missing')).toEqual([
      'delorun/apps/release/closure.json names deploy root @delorun/missing, which is no package under delorun/packages or delorun/apps',
    ])
  })

  it('passes on the real tree', () => {
    expect(graphErrors(REPO)).toEqual([])
  })

  it('exits 1 naming the cycle on a violation and 0 on a clean tree, from the command line', (test) => {
    const recipe = JSON.stringify({ deployRoot: '@delorun/root' })
    const bad = scratchRepo(test)
    bad.write({
      'delorun/apps/release/closure.json': recipe,
      'delorun/apps/release/package.json': manifest('@delorun/release', { dependencies: { '@delorun/root': 'workspace:*' } }),
      'delorun/apps/root/package.json': manifest('@delorun/root', { devDependencies: { '@delorun/release': 'workspace:*' } }),
    })
    const failed = runTsx(bad.root, gatePath('workspace-graph'))
    expect(failed.status).toBe(1)
    expect(failed.output).toMatch(/dependency cycle (@delorun\/root -> @delorun\/release -> @delorun\/root|@delorun\/release -> @delorun\/root -> @delorun\/release);/u)

    const good = scratchRepo(test)
    good.write({ 'delorun/apps/release/closure.json': recipe, 'delorun/apps/root/package.json': manifest('@delorun/root') })
    const passed = runTsx(good.root, gatePath('workspace-graph'))
    expect(passed.status).toBe(0)
    expect(passed.output).toContain('no dependency cycle')
  }, 60_000)
})
