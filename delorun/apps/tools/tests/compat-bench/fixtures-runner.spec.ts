import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { FIXTURES, UNSATISFIABLE_RANGE, writeFixtures } from '../../src/compat-bench/fixtures.ts'
import { folderName, packageNameOf } from '../../src/compat-bench/runner.ts'
import { imageTag, PREVIOUS_RELEASE_TAG, planImage, upstreamVersion } from '../../src/compat-bench/images.ts'

describe('the fixture plugins', () => {
  const root = mkdtempSync(join(tmpdir(), 'bench-fixtures-'))
  const written = writeFixtures(root)
  const manifest = (name: string): { engines?: Record<string, string>, name: string } => JSON.parse(readFileSync(join(written.get(name) ?? '', 'package.json'), 'utf8')) as { engines?: Record<string, string>, name: string }

  it('writes the five fixtures', () => {
    expect([...written.keys()]).toEqual(FIXTURES.map(fixture => fixture.name))
  })

  it('has one fixture for each engines case of A567 and L150', () => {
    expect(Object.keys(manifest('bench-fixture-engines-delorun').engines ?? {})).toEqual(['delorun'])
    expect(Object.keys(manifest('bench-fixture-engines-dsh').engines ?? {})).toEqual(['dsh'])
    expect(Object.keys(manifest('bench-fixture-engines-both').engines ?? {}).sort()).toEqual(['delorun', 'dsh'])
    expect(manifest('bench-fixture-engines-both').engines?.dsh).toBe(UNSATISFIABLE_RANGE)
  })

  it('makes the broken fixture throw while loading and the others load', async () => {
    const load = async (name: string): Promise<{ apply: () => void }> => await import(join(written.get(name) ?? '', 'lib', 'index.js')) as { apply: () => void }
    expect((await load('bench-fixture-minimal')).apply()).toBeUndefined()
    await expect(load('bench-fixture-broken').then(module => { module.apply() })).rejects.toThrow('fixture failure on purpose')
  })

  it('writes a studio half in the client module loader format', () => {
    const client = readFileSync(join(written.get('bench-fixture-minimal') ?? '', 'lib', 'client.js'), 'utf8')
    expect(client).toContain('window.__ModuleLoader__.load({ id: "bench-fixture-minimal"')
    expect(client).toContain("settings.section")
  })
})

describe('naming', () => {
  it('reads a package name from each kind of source', () => {
    expect(packageNameOf({ kind: 'npm', spec: 'dsh-context' })).toBe('dsh-context')
    expect(packageNameOf({ kind: 'npm', spec: 'dsh-context@1.2.3' })).toBe('dsh-context')
    expect(packageNameOf({ kind: 'npm', spec: '@michengai/dsh-archive-manager@2.0.0' })).toBe('@michengai/dsh-archive-manager')
    expect(packageNameOf({ kind: 'npm', spec: '@michengai/dsh-archive-manager' })).toBe('@michengai/dsh-archive-manager')
    expect(packageNameOf({ kind: 'git', spec: 'https://example.invalid/team/some-plugin.git#v1' })).toBe('some-plugin')
  })

  it('makes a folder name from a scoped name', () => {
    expect(folderName('@scope/name')).toBe('scope__name')
    expect(folderName('plain')).toBe('plain')
  })
})

describe('image plans', () => {
  const repository = join(import.meta.dirname, '../../../../..')

  it('tags the candidate by commit, the previous release by tag and stock by the DSH version', () => {
    expect(imageTag('delorun', 'a'.repeat(40))).toBe(`delorun-bench:${'a'.repeat(12)}`)
    expect(imageTag('delorun-prev', PREVIOUS_RELEASE_TAG)).toBe('delorun-bench-prev:v0.1.0-preview.2.7')
    expect(imageTag('stock', '0.2.2-rc.3')).toBe('dsh-stock:0.2.2-rc.3')
  })

  it('reads the stock version from the repository\'s ledger, not from a constant', () => {
    const version = upstreamVersion(repository, 'HEAD')
    expect(version).toMatch(/^\d+\.\d+\.\d+/)
    expect(planImage({ repository, host: 'stock' })).toMatchObject({ tag: `dsh-stock:${version}`, target: 'stock', args: { DSH_VERSION: version } })
    const delorun = planImage({ repository, host: 'delorun' })
    expect(delorun.target).toBe('delorun')
    expect(delorun.args.PLAYWRIGHT_VERSION).toMatch(/^\d+\.\d+\.\d+$/)
    expect(planImage({ repository, host: 'delorun-prev' }).tag).toBe('delorun-bench-prev:v0.1.0-preview.2.7')
  })
})
