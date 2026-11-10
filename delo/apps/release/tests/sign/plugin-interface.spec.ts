/**
 * The plugin-facing interface inventory: its drift check against the checkout, which keeps every context service and
 * event a Delo package or app declares listed exactly once with its source and side and every listed entry still
 * offered by its source, and the reader and source checks the patch rule shares with it.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { PluginInterfaceEntry } from '@delo/contract-plugin-versions'
import { CORDIS_INTERFACES, declaredCordisMembers, describeEntry, PLUGIN_INTERFACE_PATH, readPluginInterface, readsManifestField, sourceOffers } from '../../src/sign/plugin-interface.ts'
import { REPO } from '../support.ts'

/** The roots whose `src` trees the drift check reads: every Delo package and every Delo app. */
const SOURCE_ROOTS = [join(REPO, 'delo', 'packages'), join(REPO, 'delo', 'apps')]

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

/** A service or an event a Delo source declares. */
type Declared = Extract<PluginInterfaceEntry, { kind: 'service' | 'event' }>

/** Every context service and event a Delo package's or app's `src` declares, with its source and the side its path implies. */
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

/** The drift check reads every Delo source file, which a loaded host slows. */
const SOURCE_SCAN_TIMEOUT = { timeout: 60_000 }

describe('the plugin-facing interface inventory', SOURCE_SCAN_TIMEOUT, () => {
  const inventory = readPluginInterface(readFileSync(join(REPO, PLUGIN_INTERFACE_PATH)))
  const listed = [...inventory.covered, ...inventory.internal]

  it('lists every context service and event a Delo package or app declares exactly once, with its source and side', () => {
    const declared = declaredEntries()
    expect(declared.filter(entry => entry.kind === 'service').length).toBeGreaterThan(0)
    for (const entry of declared) {
      const entries = listed.filter(other => other.kind === entry.kind && other.name === entry.name)
      expect(entries, `${entry.kind} ${entry.name} in ${entry.source}`).toEqual([entry])
    }
    expect(listed.filter(entry => entry.kind !== 'manifest-field').length).toBe(declared.length)
  })

  it('lists only entries their sources still offer, and the Delo version requirement as a covered manifest field', () => {
    for (const entry of listed) {
      expect(sourceOffers(entry, readFileSync(join(REPO, entry.source), 'utf8')), describeEntry(entry)).toBe(true)
    }
    expect(inventory.covered).toContainEqual({ kind: 'manifest-field', name: 'engines.delo', source: 'packages/boot/app-boot/src/plugin-compatibility.ts' })
    expect(inventory.covered.filter(entry => entry.kind === 'service').map(entry => entry.name).sort()).toEqual(['deloChatStates', 'deloOnboarding', 'deloStudio', 'deloWorkspaces'])
    expect(inventory.covered.filter(entry => entry.kind === 'event')).toEqual([])
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
    expect(readPluginInterface(Buffer.from(JSON.stringify({ ...valid, internal: [{ kind: 'event', name: 'delo/update-ready', side: 'host', source: 'delo/packages/a/src/events.d.ts' }] }))).internal).toHaveLength(1)
    expect(read({ ...valid, internal: [{ kind: 'event', name: 'delo update', side: 'host', source: 'a.ts' }] })).toThrow('not a delo.plugin-interface/1 inventory')
    expect(read({ ...valid, internal: [{ kind: 'event', name: 'delo/update-ready', source: 'a.ts' }] })).toThrow('not a delo.plugin-interface/1 inventory')
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
    expect(declaredCordisMembers('index.ts', text, 'Context')).toEqual(['deloOne', 'deloTwo', 'deloThree'])
    expect(declaredCordisMembers('index.ts', text, 'Events')).toEqual(['deloEvent'])
    expect(declaredCordisMembers('view.tsx', 'declare module \'@deepseek-ai/cordis\' { interface Context { deloView: unknown } }\nexport const view = <div />\n', 'Context')).toEqual(['deloView'])
  })

  it('finds the Events members of the cordis module augmentation, in a declaration file too', () => {
    const text = [
      'declare module \'@deepseek-ai/cordis\' {',
      '  interface Events {',
      '    \'delo/update-ready\'(version: string): void',
      '    deloPlain: (value: number) => void',
      '    [key: string]: unknown',
      '  }',
      '  interface Context { deloService: unknown }',
      '}',
      'declare module \'@deepseek-ai/other\' { interface Events { \'delo/other\': unknown } }',
      'interface Events { \'delo/local\': unknown }',
    ].join('\n')
    expect(declaredCordisMembers('events.d.ts', text, 'Events')).toEqual(['delo/update-ready', 'deloPlain'])
    expect(declaredCordisMembers('events.d.ts', text, 'Context')).toEqual(['deloService'])
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
    const event: PluginInterfaceEntry = { kind: 'event', name: 'delo/one', side: 'browser', source: 'client/c.d.ts' }
    expect(describeEntry(service)).toBe('service deloOne (host, in a.ts)')
    expect(describeEntry(field)).toBe('manifest field engines.delo (read in b.ts)')
    expect(describeEntry(event)).toBe('event delo/one (browser, in client/c.d.ts)')
    expect(sourceOffers(service, 'declare module \'@deepseek-ai/cordis\' { interface Context { deloOne: unknown } }')).toBe(true)
    expect(sourceOffers(service, 'export const deloOne = 1')).toBe(false)
    expect(sourceOffers(event, 'declare module \'@deepseek-ai/cordis\' { interface Events { \'delo/one\': () => void } }')).toBe(true)
    expect(sourceOffers(event, 'declare module \'@deepseek-ai/cordis\' { interface Context { \'delo/one\': unknown } }')).toBe(false)
    expect(sourceOffers(field, 'export const range = engines.delo')).toBe(true)
  })
})
