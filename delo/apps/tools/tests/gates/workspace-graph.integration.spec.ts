import { describe, expect, it } from 'vitest'
import type { StatePackage } from '../../src/checks/gates/package-states.ts'
import { dependencyCycles, graphErrors, TOOLING_PACKAGES, toolingErrors } from '../../src/checks/gates/workspace-graph.ts'
import { gatePath, REPO, runTsx, scratchRepo } from './support.ts'

/** A package fixture with production and development dependencies. */
function pkg(name: string, dependencies: string[] = [], devDependencies: string[] = []): StatePackage {
  return { name, dir: `delo/packages/${name}`, state: 'shipped', unreached: undefined, dependencies, devDependencies }
}

const manifest = (name: string, extra: Record<string, unknown> = {}): string => JSON.stringify({ name, delo: { state: 'shipped' }, ...extra })

describe('gates:workspace-graph rules', () => {
  it('finds no cycle in an acyclic graph with shared dependencies', () => {
    expect(dependencyCycles([pkg('a', ['b', 'c']), pkg('b', ['c']), pkg('c', ['external'])])).toEqual([])
  })

  it('finds a cycle that runs through a development dependency, once', () => {
    const packages = [pkg('@delo/release', ['@delo/runtime-closure']), pkg('@delo/runtime-closure', ['@delo/cli']), pkg('@delo/cli', [], ['@delo/release'])]
    expect(dependencyCycles(packages)).toEqual([['@delo/release', '@delo/runtime-closure', '@delo/cli', '@delo/release']])
  })

  it('finds a package that depends on itself', () => {
    expect(dependencyCycles([pkg('a', [], ['a'])])).toEqual([['a', 'a']])
  })

  it('refuses tooling the deploy root reaches over production dependencies, naming the path', () => {
    const packages = [pkg('root', ['cli']), pkg('cli', ['@delo/release']), pkg('@delo/release', ['@delo/tools']), pkg('@delo/tools')]
    expect(toolingErrors(packages, 'root')).toEqual([
      'the runtime closure carries @delo/release, through root -> cli -> @delo/release; a shipped package depends on release or developer tooling',
      'the runtime closure carries @delo/tools, through root -> cli -> @delo/release -> @delo/tools; a shipped package depends on release or developer tooling',
    ])
  })

  it('lets a shipped package keep tooling as a development dependency', () => {
    expect(toolingErrors([pkg('root', ['cli']), pkg('cli', [], [...TOOLING_PACKAGES]), pkg('@delo/release'), pkg('@delo/tools')], 'root')).toEqual([])
  })

  it('refuses a deploy root that is no package', () => {
    expect(toolingErrors([pkg('cli')], '@delo/missing')).toEqual([
      'delo/apps/release/closure.json names deploy root @delo/missing, which is no package under delo/packages or delo/apps',
    ])
  })

  it('passes on the real tree', () => {
    expect(graphErrors(REPO)).toEqual([])
  })

  it('exits 1 naming the cycle on a violation and 0 on a clean tree, from the command line', (test) => {
    const recipe = JSON.stringify({ deployRoot: '@delo/root' })
    const bad = scratchRepo(test)
    bad.write({
      'delo/apps/release/closure.json': recipe,
      'delo/apps/release/package.json': manifest('@delo/release', { dependencies: { '@delo/root': 'workspace:*' } }),
      'delo/apps/root/package.json': manifest('@delo/root', { devDependencies: { '@delo/release': 'workspace:*' } }),
    })
    const failed = runTsx(bad.root, gatePath('workspace-graph'))
    expect(failed.status).toBe(1)
    expect(failed.output).toMatch(/dependency cycle (@delo\/root -> @delo\/release -> @delo\/root|@delo\/release -> @delo\/root -> @delo\/release);/u)

    const good = scratchRepo(test)
    good.write({ 'delo/apps/release/closure.json': recipe, 'delo/apps/root/package.json': manifest('@delo/root') })
    const passed = runTsx(good.root, gatePath('workspace-graph'))
    expect(passed.status).toBe(0)
    expect(passed.output).toContain('no dependency cycle')
  }, 60_000)
})
