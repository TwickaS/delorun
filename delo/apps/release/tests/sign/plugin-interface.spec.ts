/**
 * The plugin-facing interface inventory: its drift check against the checkout, which keeps every context service a
 * Delo package declares listed exactly once with its source and side and every listed entry still offered by its
 * source, and the reader and source checks the patch rule shares with it.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { PluginInterfaceEntry } from '@delo/contract-plugin-versions'
import { declaredContextMembers, describeEntry, PLUGIN_INTERFACE_PATH, readPluginInterface, readsManifestField, sourceOffers } from '../../src/sign/plugin-interface.ts'
import { REPO } from '../support.ts'

/**
 * Every `.ts` and `.tsx` file under a directory, as repository-relative `/`-separated paths.
 * @param directory - the absolute directory.
 * @returns the paths.
 */
function sources(directory: string): string[] {
  return readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile() && /\.tsx?$/u.test(entry.name) && !entry.name.endsWith('.d.ts'))
    .map(entry => relative(REPO, join(entry.parentPath, entry.name)).split(sep).join('/'))
}

/** Every context service a Delo package's `src` declares, with its source and the side its path implies. */
function declaredServices(): Array<{ name: string, source: string, side: 'host' | 'browser' }> {
  const packages = join(REPO, 'delo', 'packages')
  const declared: Array<{ name: string, source: string, side: 'host' | 'browser' }> = []
  for (const name of readdirSync(packages)) {
    let files: string[]
    try {
      files = sources(join(packages, name, 'src'))
    } catch (_absent) {
      // A package without a src directory declares nothing.
      continue
    }
    for (const source of files) {
      for (const member of declaredContextMembers(source, readFileSync(join(REPO, source), 'utf8'))) {
        declared.push({ name: member, source, side: source.split('/').includes('client') ? 'browser' : 'host' })
      }
    }
  }
  return declared
}

/** The drift check reads every Delo source file, which a loaded host slows. */
const SOURCE_SCAN_TIMEOUT = { timeout: 60_000 }

describe('the plugin-facing interface inventory', SOURCE_SCAN_TIMEOUT, () => {
  const inventory = readPluginInterface(readFileSync(join(REPO, PLUGIN_INTERFACE_PATH)))
  const listed = [...inventory.covered, ...inventory.internal]

  it('lists every context service a Delo package declares exactly once, with its source and side', () => {
    const declared = declaredServices()
    expect(declared.length).toBeGreaterThan(0)
    for (const service of declared) {
      const entries = listed.filter(entry => entry.kind === 'service' && entry.name === service.name)
      expect(entries, `${service.name} in ${service.source}`).toEqual([{ kind: 'service', ...service }])
    }
    const services = listed.filter(entry => entry.kind === 'service')
    expect(services.length).toBe(declared.length)
  })

  it('lists only entries their sources still offer, and the Delo version requirement as a covered manifest field', () => {
    for (const entry of listed) {
      expect(sourceOffers(entry, readFileSync(join(REPO, entry.source), 'utf8')), describeEntry(entry)).toBe(true)
    }
    expect(inventory.covered).toContainEqual({ kind: 'manifest-field', name: 'engines.delo', source: 'packages/boot/app-boot/src/plugin-compatibility.ts' })
    expect(inventory.covered.filter(entry => entry.kind === 'service').map(entry => entry.name).sort()).toEqual(['deloChatStates', 'deloOnboarding', 'deloStudio', 'deloWorkspaces'])
  })
})

describe('reading the inventory and its sources', () => {
  it('refuses an inventory of another schema, with an unknown field, a source outside the repository or a duplicate key', () => {
    const valid = { schema: 'delo.plugin-interface/1', covered: [], internal: [] }
    const read = (value: object | string): () => unknown => () => readPluginInterface(Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)))
    expect(read(valid)()).toEqual(valid)
    expect(read({ ...valid, schema: 'delo.plugin-interface/2' })).toThrow('not a delo.plugin-interface/1 inventory')
    expect(read({ ...valid, extra: true })).toThrow('not a delo.plugin-interface/1 inventory')
    expect(read({ ...valid, covered: [{ kind: 'service', name: 'x', side: 'host', source: '../outside.ts' }] })).toThrow('a repository-relative .ts or .tsx path')
    expect(read({ ...valid, covered: [{ kind: 'manifest-field', name: 'engines', source: 'a.ts' }] })).toThrow('not a delo.plugin-interface/1 inventory')
    expect(read('{"schema":"delo.plugin-interface/1","covered":[],"internal":[],"internal":[]}')).toThrow()
  })

  it('finds the Context members of the cordis module augmentation only', () => {
    const text = [
      'declare module \'@deepseek-ai/cordis\' {',
      '  interface Context {',
      '    deloOne: unknown',
      '    \'deloTwo\': unknown',
      '    [key: string]: unknown',
      '    [Symbol.iterator]: unknown',
      '    deloThree(): void',
      '  }',
      '  interface Events { deloEvent: unknown }',
      '  type Context2 = unknown',
      '}',
      'declare module \'@deepseek-ai/other\' { interface Context { deloOther: unknown } }',
      'declare module \'@deepseek-ai/cordis\'',
      'declare namespace Context { const deloNamespace: unknown }',
      'interface Context { deloLocal: unknown }',
    ].join('\n')
    expect(declaredContextMembers('index.ts', text)).toEqual(['deloOne', 'deloTwo', 'deloThree'])
    expect(declaredContextMembers('view.tsx', 'declare module \'@deepseek-ai/cordis\' { interface Context { deloView: unknown } }\nexport const view = <div />\n')).toEqual(['deloView'])
  })

  it('finds a manifest field read through a property access, and not in a comment, a string or another chain', () => {
    expect(readsManifestField('a.ts', 'const range = engines.delo', 'engines.delo')).toBe(true)
    expect(readsManifestField('a.ts', 'const range = manifest.engines.delo\nconst other = engines.dsh', 'engines.delo')).toBe(true)
    expect(readsManifestField('a.ts', '// engines.delo\nconst text = "engines.delo"', 'engines.delo')).toBe(false)
    expect(readsManifestField('a.ts', 'const range = load().delo\nconst other = engines.dsh', 'engines.delo')).toBe(false)
    expect(readsManifestField('a.ts', 'const range = load().engines.delo', 'engines.delo')).toBe(true)
  })

  it('names each kind of entry, and checks each against its source', () => {
    const service: PluginInterfaceEntry = { kind: 'service', name: 'deloOne', side: 'host', source: 'a.ts' }
    const field: PluginInterfaceEntry = { kind: 'manifest-field', name: 'engines.delo', source: 'b.ts' }
    expect(describeEntry(service)).toBe('service deloOne (host, in a.ts)')
    expect(describeEntry(field)).toBe('manifest field engines.delo (read in b.ts)')
    expect(sourceOffers(service, 'declare module \'@deepseek-ai/cordis\' { interface Context { deloOne: unknown } }')).toBe(true)
    expect(sourceOffers(service, 'export const deloOne = 1')).toBe(false)
    expect(sourceOffers(field, 'export const range = engines.delo')).toBe(true)
  })
})
