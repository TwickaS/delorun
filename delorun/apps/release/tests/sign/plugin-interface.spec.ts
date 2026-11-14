/**
 * The plugin-facing interface inventory: its drift check against the checkout, which keeps every context service and
 * event a Delorun package or app declares listed exactly once with its source and side and every listed entry still
 * offered by its source, and the reader and source checks the patch rule shares with it.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { PluginInterfaceEntry } from '@delorun/contract-plugin-versions'
import { CORDIS_INTERFACES, declaredCordisMembers, describeEntry, PLUGIN_INTERFACE_PATH, readPluginInterface, readsManifestField, sourceOffers } from '../../src/sign/plugin-interface.ts'
import { REPO } from '../support.ts'

/** The roots whose `src` trees the drift check reads: every Delorun package and every Delorun app. */
const SOURCE_ROOTS = [join(REPO, 'delorun', 'packages'), join(REPO, 'delorun', 'apps')]

/**
 * Every `.ts`, `.tsx` and `.d.ts` file under a directory, as repository-relative `/`-separated paths.
 * @param directory - the absolute directory.
 * @returns the paths.
 */
function sources(directory: string): string[] {
  return readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile() && /\.tsx?$/u.test(entry.name))
    .map(entry => relative(REPO, join(entry.parentPath, entry.name)).split(sep).join('/'))
}

/** A service or an event a Delorun source declares. */
type Declared = Extract<PluginInterfaceEntry, { kind: 'service' | 'event' }>

/** Every context service and event a Delorun package's or app's `src` declares, with its source and the side its path implies. */
function declaredEntries(): Declared[] {
  const declared: Declared[] = []
  for (const root of SOURCE_ROOTS) {
    for (const name of readdirSync(root)) {
      let files: string[]
      try {
        files = sources(join(root, name, 'src'))
      } catch (_absent) {
        // A package or app without a src directory declares nothing.
        continue
      }
      for (const source of files) {
        const text = readFileSync(join(REPO, source), 'utf8')
        const side = source.split('/').includes('client') ? 'browser' : 'host'
        for (const kind of ['service', 'event'] as const) {
          for (const member of declaredCordisMembers(source, text, CORDIS_INTERFACES[kind])) declared.push({ kind, name: member, side, source })
        }
      }
    }
  }
  return declared
}

/** The drift check reads every Delorun source file, which a loaded host slows. */
const SOURCE_SCAN_TIMEOUT = { timeout: 60_000 }

describe('the plugin-facing interface inventory', SOURCE_SCAN_TIMEOUT, () => {
  const inventory = readPluginInterface(readFileSync(join(REPO, PLUGIN_INTERFACE_PATH)))
  const listed = [...inventory.covered, ...inventory.internal]

  it('lists every context service and event a Delorun package or app declares exactly once, with its source and side', () => {
    const declared = declaredEntries()
    expect(declared.filter(entry => entry.kind === 'service').length).toBeGreaterThan(0)
    for (const entry of declared) {
      const entries = listed.filter(other => other.kind === entry.kind && other.name === entry.name)
      expect(entries, `${entry.kind} ${entry.name} in ${entry.source}`).toEqual([entry])
    }
    expect(listed.filter(entry => entry.kind !== 'manifest-field').length).toBe(declared.length)
  })

  it('lists only entries their sources still offer, and the Delorun version requirement as a covered manifest field', () => {
    for (const entry of listed) {
      expect(sourceOffers(entry, readFileSync(join(REPO, entry.source), 'utf8')), describeEntry(entry)).toBe(true)
    }
    expect(inventory.covered).toContainEqual({ kind: 'manifest-field', name: 'engines.delorun', source: 'packages/boot/app-boot/src/plugin-compatibility.ts' })
    expect(inventory.covered.filter(entry => entry.kind === 'service').map(entry => entry.name).sort()).toEqual(['delorunChatStates', 'delorunOnboarding', 'delorunStudio', 'delorunWorkspaces'])
    expect(inventory.covered.filter(entry => entry.kind === 'event')).toEqual([])
  })
})

describe('reading the inventory and its sources', () => {
  it('refuses an inventory of another schema, with an unknown field, a source outside the repository or a duplicate key', () => {
    const valid = { schema: 'delorun.plugin-interface/1', covered: [], internal: [] }
    const read = (value: object | string): () => unknown => () => readPluginInterface(Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)))
    expect(read(valid)()).toEqual(valid)
    expect(read({ ...valid, schema: 'delorun.plugin-interface/2' })).toThrow('not a delorun.plugin-interface/1 inventory')
    expect(read({ ...valid, extra: true })).toThrow('not a delorun.plugin-interface/1 inventory')
    expect(read({ ...valid, covered: [{ kind: 'service', name: 'x', side: 'host', source: '../outside.ts' }] })).toThrow('a repository-relative .ts or .tsx path')
    expect(read({ ...valid, covered: [{ kind: 'manifest-field', name: 'engines', source: 'a.ts' }] })).toThrow('not a delorun.plugin-interface/1 inventory')
    expect(readPluginInterface(Buffer.from(JSON.stringify({ ...valid, internal: [{ kind: 'event', name: 'delorun/update-ready', side: 'host', source: 'delorun/packages/a/src/events.d.ts' }] }))).internal).toHaveLength(1)
    expect(read({ ...valid, internal: [{ kind: 'event', name: 'delorun update', side: 'host', source: 'a.ts' }] })).toThrow('not a delorun.plugin-interface/1 inventory')
    expect(read({ ...valid, internal: [{ kind: 'event', name: 'delorun/update-ready', source: 'a.ts' }] })).toThrow('not a delorun.plugin-interface/1 inventory')
    expect(read('{"schema":"delorun.plugin-interface/1","covered":[],"internal":[],"internal":[]}')).toThrow()
  })

  it('finds the Context members of the cordis module augmentation only', () => {
    const text = [
      'declare module \'@deepseek-ai/cordis\' {',
      '  interface Context {',
      '    delorunOne: unknown',
      '    \'delorunTwo\': unknown',
      '    [key: string]: unknown',
      '    [Symbol.iterator]: unknown',
      '    delorunThree(): void',
      '  }',
      '  interface Events { delorunEvent: unknown }',
      '  type Context2 = unknown',
      '}',
      'declare module \'@deepseek-ai/other\' { interface Context { delorunOther: unknown } }',
      'declare module \'@deepseek-ai/cordis\'',
      'declare namespace Context { const delorunNamespace: unknown }',
      'interface Context { delorunLocal: unknown }',
    ].join('\n')
    expect(declaredCordisMembers('index.ts', text, 'Context')).toEqual(['delorunOne', 'delorunTwo', 'delorunThree'])
    expect(declaredCordisMembers('index.ts', text, 'Events')).toEqual(['delorunEvent'])
    expect(declaredCordisMembers('view.tsx', 'declare module \'@deepseek-ai/cordis\' { interface Context { delorunView: unknown } }\nexport const view = <div />\n', 'Context')).toEqual(['delorunView'])
  })

  it('finds the Events members of the cordis module augmentation, in a declaration file too', () => {
    const text = [
      'declare module \'@deepseek-ai/cordis\' {',
      '  interface Events {',
      '    \'delorun/update-ready\'(version: string): void',
      '    delorunPlain: (value: number) => void',
      '    [key: string]: unknown',
      '  }',
      '  interface Context { delorunService: unknown }',
      '}',
      'declare module \'@deepseek-ai/other\' { interface Events { \'delorun/other\': unknown } }',
      'interface Events { \'delorun/local\': unknown }',
    ].join('\n')
    expect(declaredCordisMembers('events.d.ts', text, 'Events')).toEqual(['delorun/update-ready', 'delorunPlain'])
    expect(declaredCordisMembers('events.d.ts', text, 'Context')).toEqual(['delorunService'])
  })

  it('finds a manifest field read through a property access, and not in a comment, a string or another chain', () => {
    expect(readsManifestField('a.ts', 'const range = engines.delorun', 'engines.delorun')).toBe(true)
    expect(readsManifestField('a.ts', 'const range = manifest.engines.delorun\nconst other = engines.dsh', 'engines.delorun')).toBe(true)
    expect(readsManifestField('a.ts', '// engines.delorun\nconst text = "engines.delorun"', 'engines.delorun')).toBe(false)
    expect(readsManifestField('a.ts', 'const range = load().delorun\nconst other = engines.dsh', 'engines.delorun')).toBe(false)
    expect(readsManifestField('a.ts', 'const range = load().engines.delorun', 'engines.delorun')).toBe(true)
  })

  it('names each kind of entry, and checks each against its source', () => {
    const service: PluginInterfaceEntry = { kind: 'service', name: 'delorunOne', side: 'host', source: 'a.ts' }
    const field: PluginInterfaceEntry = { kind: 'manifest-field', name: 'engines.delorun', source: 'b.ts' }
    const event: PluginInterfaceEntry = { kind: 'event', name: 'delorun/one', side: 'browser', source: 'client/c.d.ts' }
    expect(describeEntry(service)).toBe('service delorunOne (host, in a.ts)')
    expect(describeEntry(field)).toBe('manifest field engines.delorun (read in b.ts)')
    expect(describeEntry(event)).toBe('event delorun/one (browser, in client/c.d.ts)')
    expect(sourceOffers(service, 'declare module \'@deepseek-ai/cordis\' { interface Context { delorunOne: unknown } }')).toBe(true)
    expect(sourceOffers(service, 'export const delorunOne = 1')).toBe(false)
    expect(sourceOffers(event, 'declare module \'@deepseek-ai/cordis\' { interface Events { \'delorun/one\': () => void } }')).toBe(true)
    expect(sourceOffers(event, 'declare module \'@deepseek-ai/cordis\' { interface Context { \'delorun/one\': unknown } }')).toBe(false)
    expect(sourceOffers(field, 'export const range = engines.delorun')).toBe(true)
  })
})
