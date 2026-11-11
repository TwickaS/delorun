/**
 * The batch's selection over a small tree read from disk: the packages, programs and upstream packages the runner would
 * read, and the merge-tier checks a lane's paths select, the build checks included.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { planSourceOf, readPlanSource } from '../../src/batch/plan-source.ts'
import { readTree } from '../../src/checks/tree.ts'
import { cleanUp, tempDir } from './fixtures.ts'

afterEach(cleanUp)

/**
 * A tree with two Delo packages, one with its own workspace, a directory without a manifest, and two upstream packages.
 * @param ledger - whether to write a ledger with a `security` entry.
 * @returns its root.
 */
function makeTree(ledger: boolean): string {
  const root = tempDir('delo-batch-tree-')
  const files: Record<string, string> = {
    'delo/apps/a/package.json': JSON.stringify({ name: '@delo/a', dependencies: { '@delo/b': 'workspace:*', '@deepseek-ai/dsh-core': 'workspace:*' }, scripts: { build: 'tsc' }, exports: './lib/index.js' }),
    'delo/apps/a/tsconfig.json': '{}',
    'delo/apps/a/tests/run.docker.spec.ts': '',
    'delo/apps/own/package.json': JSON.stringify({ name: '@delo/own' }),
    'delo/apps/own/pnpm-workspace.yaml': '',
    'delo/apps/own/tsconfig.json': '{}',
    'delo/apps/loose/README.md': '',
    'delo/packages/b/package.json': JSON.stringify({ name: '@delo/b', devDependencies: { vitest: '1' } }),
    'delo/packages/b/tsconfig.json': '{}',
    'delo/packages/b/tsconfig.build.json': '{}',
    'packages/core/core/package.json': JSON.stringify({ name: '@deepseek-ai/dsh-core', devDependencies: { '@deepseek-ai/dsh-test': 'workspace:*' } }),
    'packages/core/core/tests/a.spec.ts': '',
    'packages/core/core/tests/notes.md': '',
    'packages/core/loose/README.md': '',
    'apps/cli/package.json': JSON.stringify({ name: '@deepseek-ai/dsh-cli', dependencies: { '@deepseek-ai/dsh-core': 'workspace:*' }, peerDependencies: { react: '1' } }),
  }
  if (ledger) {
    files['delo/upstream-patches.json'] = JSON.stringify({
      upstream: { repository: 'r', ref: 'v', commit: 'a'.repeat(40) },
      forkOwned: ['delo/'],
      patches: [{ path: 'packages/core/core/src/index.ts', class: 'security', reason: 'r' }],
      retired: [],
    })
  }
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), text)
  }
  return root
}

describe('readTree', () => {
  it('reads the packages, programs and upstream packages the runner reads', () => {
    const tree = readTree(makeTree(true))
    expect(tree.packages).toEqual([
      { name: '@delo/a', dir: 'delo/apps/a', forkDependencies: ['@delo/b'], upstreamDependencies: ['@deepseek-ai/dsh-core'], ownWorkspace: false, dockerSpecs: true, buildOutputs: ['lib/index.js'] },
      { name: '@delo/own', dir: 'delo/apps/own', forkDependencies: [], upstreamDependencies: [], ownWorkspace: true, dockerSpecs: false, buildOutputs: [] },
      { name: '@delo/b', dir: 'delo/packages/b', forkDependencies: [], upstreamDependencies: [], ownWorkspace: false, dockerSpecs: false, buildOutputs: [] },
    ])
    expect(tree.programs.map(program => program.config)).toEqual(['delo/apps/a/tsconfig.json', 'delo/packages/b/tsconfig.build.json', 'delo/packages/b/tsconfig.json'])
    expect(tree.upstream).toEqual([
      { name: '@deepseek-ai/dsh-cli', dir: 'apps/cli', dependencies: ['@deepseek-ai/dsh-core'], runtimeDependencies: ['@deepseek-ai/dsh-core'], specs: 0 },
      { name: '@deepseek-ai/dsh-core', dir: 'packages/core/core', dependencies: ['@deepseek-ai/dsh-test'], runtimeDependencies: [], specs: 1, security: true },
    ])
    expect(tree.webSpecs).toEqual([])
  })

  it('reads a tree without a ledger or package directories', () => {
    expect(readTree(makeTree(false)).upstream.some(pkg => pkg.security === true)).toBe(false)
    expect(readTree(tempDir('delo-batch-empty-'))).toEqual({ packages: [], programs: [], upstream: [], webSpecs: [], journey: false })
  })
})

describe('planSourceOf', () => {
  it('selects the merge-tier checks of a lane\'s paths, with the build checks they wait for', () => {
    const source = readPlanSource(makeTree(true))
    const selected = source.select(['delo/packages/b/src/b.ts'])
    const ids = selected.map(check => check.id)
    expect(ids).toEqual(expect.arrayContaining(['gates:dco', 'tests:fork', 'tests:docker', 'build:artifacts', 'build:delo', 'typecheck:delo:a', 'typecheck:delo:b']))
    expect(selected.find(check => check.id === 'tests:fork')?.scope).toEqual(['delo/apps/a/', 'delo/packages/b/'])
    expect(source.select(['README.md']).map(check => check.id)).not.toContain('tests:fork')
    expect(source.packageOf('delo/apps/a/src/x.ts')).toBe('delo/apps/a')
    expect(source.packageOf('packages/core/core/src/x.ts')).toBe('packages/core/core')
    expect(source.packageOf('README.md')).toBeUndefined()
  })

  it('leaves the Delo build out of a tree whose packages declare none', () => {
    const tree = readTree(makeTree(false))
    const source = planSourceOf({ ...tree, packages: tree.packages.map(({ buildOutputs: _, ...pkg }) => pkg) }, { tiers: {}, checks: { boundary: { memoryGiB: 1 }, gates: { memoryGiB: 1 }, whitespace: { memoryGiB: 1 }, docs: { memoryGiB: 1 }, typecheck: { memoryGiB: 1 }, generate: { memoryGiB: 1 }, 'docs-site': { memoryGiB: 1 }, tests: { memoryGiB: 1 }, parity: { memoryGiB: 1 }, benchmark: { memoryGiB: 1 } } })
    expect(source.select(['delo/apps/a/src/a.ts']).map(check => check.id)).not.toContain('build:delo')
  })
})
