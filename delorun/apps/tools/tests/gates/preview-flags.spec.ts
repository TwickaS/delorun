/**
 * The preview-flags gate: a package's listed flags and its plugin's declarations are the same set. Each test's comment
 * names the rule whose removal makes it fail.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, onTestFinished } from 'vitest'
import { previewFlagViolations } from '../../src/checks/gates/preview-flags.ts'

/** One package of a scratch tree: its manifest fields and its source files. */
interface Scratch { readonly name?: string, readonly listed?: readonly string[], readonly files?: Readonly<Record<string, string>> }

/** A scratch repository holding the packages given, by directory name. */
function tree(packages: Readonly<Record<string, Scratch>>): string {
  const root = mkdtempSync(join(tmpdir(), 'delorun-preview-flags-gate-'))
  onTestFinished(() => { rmSync(root, { recursive: true, force: true }) })
  for (const [dir, pkg] of Object.entries(packages)) {
    const base = join(root, 'delorun', 'packages', dir)
    mkdirSync(base, { recursive: true })
    writeFileSync(join(base, 'package.json'), JSON.stringify({ name: pkg.name ?? `@test/${dir}`, delorun: { state: 'shipped', ...pkg.listed === undefined ? {} : { previewFlags: pkg.listed } } }))
    for (const [file, text] of Object.entries(pkg.files ?? {})) {
      mkdirSync(dirname(join(base, file)), { recursive: true })
      writeFileSync(join(base, file), text)
    }
  }
  return root
}

const declares = (...flags: readonly (readonly [id: string, owner: string])[]): string =>
  `export const PREVIEW_FLAGS = ${JSON.stringify(flags.map(([id, owner]) => ({ id, owner, kind: 'boolean' })))}\n`

describe('gates:preview-flags', () => {
  it('passes a package whose list is what it declares, and packages with no flags', async () => {
    expect(await previewFlagViolations(tree({
      'plugin-a': { listed: ['a.one', 'a.two'], files: { 'src/preview-flags.ts': declares(['a.two', '@test/plugin-a'], ['a.one', '@test/plugin-a']) } },
      'plugin-b': {},
      'no-manifest': { files: {} },
    }))).toEqual([])
  })

  it('refuses a flag that is declared and not listed, and one that is listed and not declared', async () => {
    // Pins rule 2: without it `delorun preview` and the plugin disagree about which flags exist.
    expect(await previewFlagViolations(tree({
      'plugin-a': { listed: ['a.one'], files: { 'src/preview-flags.ts': declares(['a.one', '@test/plugin-a'], ['a.two', '@test/plugin-a']) } },
      'plugin-b': { listed: ['b.one', 'b.gone'], files: { 'src/preview-flags.ts': declares(['b.one', '@test/plugin-b']) } },
    }))).toEqual([
      'delorun/packages/plugin-a: a.two is declared in src/preview-flags.ts and not listed under delorun.previewFlags in package.json',
      'delorun/packages/plugin-b: b.gone is listed under delorun.previewFlags in package.json and not declared in src/preview-flags.ts',
    ])
  })

  it('refuses a list with no declarations module, and a module that exports no declarations', async () => {
    // Pins rule 1: without it a list nobody declares passes.
    expect(await previewFlagViolations(tree({
      'plugin-a': { listed: ['a.one'] },
      'plugin-b': { listed: ['b.one'], files: { 'src/preview-flags.ts': 'export const FLAGS = []\n' } },
    }))).toEqual([
      'delorun/packages/plugin-a: package.json lists a.one under delorun.previewFlags, and src/preview-flags.ts does not exist to declare them',
      'delorun/packages/plugin-b: src/preview-flags.ts does not export PREVIEW_FLAGS as a list of flag declarations',
    ])
  })

  it('refuses a declaration whose owner is another package', async () => {
    // Pins rule 3: the Host refuses a declaration whose owner is not the package that lists it.
    expect(await previewFlagViolations(tree({ 'plugin-a': { listed: ['a.one'], files: { 'src/preview-flags.ts': declares(['a.one', '@test/other']) } } })))
      .toEqual(['delorun/packages/plugin-a: a.one names @test/other as its owner, and the package is @test/plugin-a'])
  })

  it('refuses a source that declares a flag in a package with no declarations module', async () => {
    // Pins rule 4: without it a flag declared inline is in no list.
    expect(await previewFlagViolations(tree({
      'plugin-a': { files: { 'src/index.ts': 'ctx.effect(() => ctx.previewFlags.declare(FLAG))\n' } },
      'preview-flags': { name: '@delorun/preview-flags', files: { 'src/registry.ts': '// ctx.previewFlags.declare(flag)\n' } },
    }))).toEqual(['delorun/packages/plugin-a: src/index.ts declares a preview flag, and the package has no src/preview-flags.ts that exports PREVIEW_FLAGS'])
  })

  it('refuses a Host source that reads a flag unless the list of readers names it', async () => {
    // Pins rule 5: a Host read is where a flag could start to change what a model reads.
    const root = tree({
      'plugin-a': { files: { 'src/index.ts': 'if (ctx.previewFlags.isOn(FLAG)) addTool()\n', 'src/other.ts': 'gate.isOn()\n' } },
      'preview-flags': { name: '@delorun/preview-flags', files: { 'src/registry.ts': 'const previewFlags = { isOn(id) { return flags.isOn(id) } }\n' } },
    })
    expect(await previewFlagViolations(root)).toEqual(['delorun/packages/plugin-a: src/index.ts reads a preview flag on the Host; a flag changes studio UI only, so name the file in HOST_READERS with the reason the read cannot reach a model'])
    expect(await previewFlagViolations(root, { 'plugin-a/src/index.ts': 'draws a Settings row only' })).toEqual([])
  })

  it('passes this repository', async () => {
    const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '..')
    expect(await previewFlagViolations(root)).toEqual([])
  })
})
