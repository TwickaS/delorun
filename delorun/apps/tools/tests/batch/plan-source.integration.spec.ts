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
 * A tree with two Delorun packages, one with its own workspace, a directory without a manifest, and two upstream packages.
 * @param ledger - whether to write a ledger with a `security` entry.
 * @returns its root.
 */
function makeTree(ledger: boolean): string {
  const root = tempDir('delorun-batch-tree-')
  const files: Record<string, string> = {
    'delorun/apps/a/package.json': JSON.stringify({ name: '@delorun/a', dependencies: { '@delorun/b': 'workspace:*', '@deepseek-ai/dsh-core': 'workspace:*' }, scripts: { build: 'tsc' }, exports: './lib/index.js' }),
    'delorun/apps/a/tsconfig.json': '{}',
    'delorun/apps/a/tests/run.docker.spec.ts': '',
    'delorun/apps/own/package.json': JSON.stringify({ name: '@delorun/own' }),
    'delorun/apps/own/pnpm-workspace.yaml': '',
    'delorun/apps/own/tsconfig.json': '{}',
    'delorun/apps/loose/README.md': '',
    'delorun/packages/b/package.json': JSON.stringify({ name: '@delorun/b', devDependencies: { vitest: '1' } }),
    'delorun/packages/b/tsconfig.json': '{}',
    'delorun/packages/b/tsconfig.build.json': '{}',
    'packages/core/core/package.json': JSON.stringify({ name: '@deepseek-ai/dsh-core', devDependencies: { '@deepseek-ai/dsh-test': 'workspace:*' } }),
    'packages/core/core/tests/a.spec.ts': '',
    'packages/core/core/tests/notes.md': '',
    'packages/core/loose/README.md': '',
    'apps/cli/package.json': JSON.stringify({ name: '@deepseek-ai/dsh-cli', dependencies: { '@deepseek-ai/dsh-core': 'workspace:*' }, peerDependencies: { react: '1' } }),
  }
  if (ledger) {
    files['delorun/upstream-patches.json'] = JSON.stringify({
      upstream: { repository: 'r', ref: 'v', commit: 'a'.repeat(40) },
      forkOwned: ['delorun/'],
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
      { name: '@delorun/a', dir: 'delorun/apps/a', forkDependencies: ['@delorun/b'], upstreamDependencies: ['@deepseek-ai/dsh-core'], ownWorkspace: false, dockerSpecs: true, buildOutputs: ['lib/index.js'] },
      { name: '@delorun/own', dir: 'delorun/apps/own', forkDependencies: [], upstreamDependencies: [], ownWorkspace: true, dockerSpecs: false, buildOutputs: [] },
      { name: '@delorun/b', dir: 'delorun/packages/b', forkDependencies: [], upstreamDependencies: [], ownWorkspace: false, dockerSpecs: false, buildOutputs: [] },
    ])
    expect(tree.programs.map(program => program.config)).toEqual(['delorun/apps/a/tsconfig.json', 'delorun/packages/b/tsconfig.build.json', 'delorun/packages/b/tsconfig.json'])
    expect(tree.upstream).toEqual([
      { name: '@deepseek-ai/dsh-cli', dir: 'apps/cli', dependencies: ['@deepseek-ai/dsh-core'], runtimeDependencies: ['@deepseek-ai/dsh-core'], specs: 0 },
      { name: '@deepseek-ai/dsh-core', dir: 'packages/core/core', dependencies: ['@deepseek-ai/dsh-test'], runtimeDependencies: [], specs: 1, security: true },
    ])
    expect(tree.webSpecs).toEqual([])
  })

  it('reads a tree without a ledger or package directories', () => {
    expect(readTree(makeTree(false)).upstream.some(pkg => pkg.security === true)).toBe(false)
    expect(readTree(tempDir('delorun-batch-empty-'))).toEqual({ packages: [], programs: [], upstream: [], webSpecs: [], journey: false })
  })
})

describe('planSourceOf', () => {
  it('selects the merge-tier checks of a lane\'s paths, with the build checks they wait for', () => {
    const source = readPlanSource(makeTree(true))
    const selected = source.select(['delorun/packages/b/src/b.ts'])
    const ids = selected.map(check => check.id)
    expect(ids).toEqual(expect.arrayContaining(['gates:dco', 'tests:fork', 'tests:docker', 'build:artifacts', 'build:delorun', 'typecheck:delorun:a', 'typecheck:delorun:b']))
    expect(selected.find(check => check.id === 'tests:fork')?.scope).toEqual(['delorun/apps/a/', 'delorun/packages/b/'])
    expect(source.select(['README.md']).map(check => check.id)).not.toContain('tests:fork')
    expect(source.packageOf('delorun/apps/a/src/x.ts')).toBe('delorun/apps/a')
    expect(source.packageOf('packages/core/core/src/x.ts')).toBe('packages/core/core')
    expect(source.packageOf('README.md')).toBeUndefined()
  })

  it('leaves the Delorun build out of a tree whose packages declare none', () => {
    const tree = readTree(makeTree(false))
    const source = planSourceOf({ ...tree, packages: tree.packages.map(({ buildOutputs: _, ...pkg }) => pkg) }, { tiers: {}, checks: { boundary: { memoryGiB: 1 }, gates: { memoryGiB: 1 }, whitespace: { memoryGiB: 1 }, docs: { memoryGiB: 1 }, typecheck: { memoryGiB: 1 }, generate: { memoryGiB: 1 }, 'docs-site': { memoryGiB: 1 }, tests: { memoryGiB: 1 }, parity: { memoryGiB: 1 }, benchmark: { memoryGiB: 1 } } })
    expect(source.select(['delorun/apps/a/src/a.ts']).map(check => check.id)).not.toContain('build:delorun')
  })
})
