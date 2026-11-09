/**
 * Composition of a Delo CLI profile, read through upstream's real `dsh --profile <name> --dump-config`: every row
 * names the bundle that wrote it, and the composition differs from upstream's web profile only in {@link LOCAL_ROWS}.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import yaml from 'js-yaml'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'
import { loadProfileDirectory } from '@deepseek-ai/dsh-app-boot'
import { READ_EXEMPTIONS } from '@delo/contract-home-layout'
import { DELO_PROFILE_BUNDLES, LOCAL_BUNDLE, LOCAL_ROWS, UPSTREAM_TEMPLATE } from '../src/profile.ts'
// Relative: this package does not depend on the registry, and a test must not add a dependency.
import { PARITY_SWITCHES } from '../../contract-parity-composition/src/index.ts'
import { createTestHome, DELO_PROFILE, INSTALL_ANCHOR, PACKAGE_DIR, REPO, type TestHome } from './profiles.ts'

/** The consent and guard rows this bundle mounts, with the row id each entry carries. */
const MOUNTED_PLUGINS = [
  { id: 'delo-instruction-consent', name: '@delo/plugin-instruction-consent' },
  { id: 'delo-mcp-consent', name: '@delo/plugin-mcp-consent' },
  { id: 'delo-permission-defaults', name: '@delo/plugin-permission-defaults' },
  { id: 'delo-schedule-consent', name: '@delo/plugin-schedule-consent' },
  { id: 'delo-fetch-guard', name: '@delo/plugin-fetch-guard' },
] as const

/** One composed row and the `# ==` label the dump printed above it. */
interface DumpedRow {
  readonly label: string
  readonly row: { readonly id?: string } & Record<string, unknown>
}

/** A dump split into its rows, with the text it printed before the first label and on stderr. */
interface Dump {
  readonly rows: readonly DumpedRow[]
  readonly preamble: string
  readonly stderr: string
}

let home: TestHome

/**
 * Run upstream's CLI from source and split its dump at each `# ==` label.
 * @param profile - the profile name under the temporary home.
 * @returns the labelled rows, the text before the first label and the process's stderr.
 */
function dumpConfig(profile: string): Dump {
  const result = spawnSync(process.execPath, ['--import', 'tsx/esm', join(REPO, 'apps/cli/src/bin.ts'), '--profile', profile, '--dump-config'], {
    cwd: REPO, env: { ...process.env, DSH_HOME: home.dir }, encoding: 'utf8',
  })
  if (result.status !== 0) throw new Error(`dsh --profile ${profile} --dump-config exited ${String(result.status)}: ${result.stderr}`)
  const [preamble = '', ...sections] = result.stdout.split(/^# == /m)
  const rows = sections.flatMap((section) => {
    const newline = section.indexOf('\n')
    const label = section.slice(0, newline)
    const entries = yaml.load(section.slice(newline + 1), { schema: entryListSchema }) as DumpedRow['row'][]
    return entries.map(row => ({ label, row }))
  })
  return { rows, preamble, stderr: result.stderr }
}

/**
 * The bundles a dump label names: the row's origin and every layer that patched it.
 * @param label - a `# ==` label, such as `@deepseek-ai/dsh-base, patched by @deepseek-ai/dsh-web-app`.
 * @returns the writers, origin first.
 */
function writers(label: string): string[] {
  const [origin = '', patched] = label.split(', patched by ')
  return [origin, ...patched === undefined ? [] : patched.split(', ')]
}

const text = (row: object): string => yaml.dump(row, { schema: entryListSchema, noRefs: true })

type Row = ReturnType<TestHome['rows']>[number]

/** This bundle's own patch file, parsed with its `!!js` values kept: each entry is an id patch or an `insert`. */
function declaredPatches(): Record<string, unknown>[] {
  return yaml.load(readFileSync(join(PACKAGE_DIR, 'cordis.patch.yml'), 'utf8'), { schema: entryListSchema }) as Record<string, unknown>[]
}

/**
 * The fields the bundle declares for one row: an inserted row as inserted, a patched row as its patches leave it
 * (a later patch of the same id replaces an earlier one's whole `config`).
 * @param id - a {@link LOCAL_ROWS} id.
 * @returns the declared fields, `id` included, or `undefined` when the bundle declares no such row.
 */
function declaredRow(id: string): Record<string, unknown> | undefined {
  const patches = declaredPatches()
  const inserted = patches.flatMap(patch => Array.isArray(patch['insert']) ? patch['insert'] as Record<string, unknown>[] : []).find(entry => entry['id'] === id)
  if (inserted !== undefined) return inserted
  return patches.filter(patch => patch['id'] === id).reduce<Record<string, unknown> | undefined>((all, patch) => ({ ...all, ...patch }), undefined)
}

/** A built registry entry. */
type BuiltSwitch = Extract<(typeof PARITY_SWITCHES)[number], { state: 'built' }>

/**
 * The value an enabled top-level row of the default composition gives a switch's Config key. The plugin's schema
 * default is not read: that needs the plugin loaded, which a composition read without a Host does not do.
 * @param rows - the composed rows of the default profile.
 * @param entry - a built registry entry.
 * @returns the configured value, or `undefined` when no enabled top-level row mounts the module with that key set.
 */
function configuredValue(rows: readonly Row[], entry: BuiltSwitch): unknown {
  return rows.find(candidate => candidate.name === entry.field.module && candidate.disabled !== true)?.config?.[entry.field.key]
}

/**
 * Switches whose registry default (true) the default composition does not reach, with why. Each case must fail until
 * its cause is fixed, so a fix turns `it.fails` red and this entry is removed.
 */
const UNREACHED_DEFAULTS: Readonly<Record<string, string>> = {
  studio_additions: '@delo/plugin-main-chat\'s Config default is false, no row mounts it, and its registrant @delo/bundle-studio does not exist',
  preset_inspect: 'the module is mounted only inside the agent presets\' plugin lists, which no patch reaches, and the plugin default is false',
  doctor: 'no row of the default composition mounts the module, and the plugin default is false',
  plugin_manager_read_exemption: 'the top-level tool-plugin-manager row is disabled and sets no key',
  profile_history: 'the top-level tool-plugin-manager row is disabled and sets no key',
  container_denial_marker: 'the sandbox-policy row sets no containerDenialMarker, and the plugin default is false',
  sandbox_protected_reads: 'the patched top-level tool-fs-search row is disabled; the presets carry their own tool-fs-search rows without protectedReads',
}

beforeAll(() => { home = createTestHome() })

afterAll(() => { home.remove() })

describe('a Delo CLI profile', () => {
  it('lists upstream\'s web template followed by this bundle', () => {
    expect(DELO_PROFILE_BUNDLES).toEqual(['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', LOCAL_BUNDLE])
    expect(UPSTREAM_TEMPLATE).toBe('web')
  })

  it('loads every bundle of the list, this one included, and skips none', () => {
    const profile = loadProfileDirectory('dsh', join(home.dir, 'profiles', DELO_PROFILE), INSTALL_ANCHOR)
    expect(profile.skippedBundles).toEqual([])
    expect(profile.layers.map(layer => layer.packageName)).toEqual(DELO_PROFILE_BUNDLES)
  })

  it('--dump-config lists every row with its writer and none without one', () => {
    const dump = dumpConfig(DELO_PROFILE)
    expect(dump.stderr).toBe('')
    expect(dump.preamble).toBe('')
    expect(dump.rows).toHaveLength(home.rows(DELO_PROFILE).length)
    for (const { label, row } of dump.rows) {
      for (const writer of writers(label)) expect(DELO_PROFILE_BUNDLES, `${row.id ?? '(no id)'} under "${label}"`).toContain(writer)
    }
    const local = dump.rows.filter(({ label }) => writers(label).includes(LOCAL_BUNDLE)).map(({ row }) => row.id)
    expect(local).toEqual(LOCAL_ROWS.map(row => row.id))
  })

  it('composes no enabled DeepSeek account row and no DeepSeek host beyond the model API', () => {
    const rows = home.rows(DELO_PROFILE)
    expect(rows.filter(row => row.id === 'deepseek-account' && row.disabled !== true)).toEqual([])
    const hosts = new Set<string>()
    for (const row of rows.filter(entry => entry.disabled !== true)) {
      for (const match of text(row).matchAll(/https?:\/\/([a-z0-9.-]*deepseek[a-z0-9.-]*)/gi)) hosts.add(`${String(row.id)} ${String(match[1])}`)
    }
    // api.deepseek.com is the model provider's API under the person's own key; no other DeepSeek origin is composed.
    expect([...hosts].filter(entry => !entry.endsWith(' api.deepseek.com'))).toEqual([])
  })

  it('composes no enabled feedback exporter, feedback surface or account surface', () => {
    const rows = home.rows(DELO_PROFILE)
    for (const id of ['session-telemetry-otel', 'command-feedback', 'ui-message-feedback', 'ui-settings-account']) {
      expect(rows.filter(row => row.id === id && row.disabled !== true), id).toEqual([])
    }
  })

  it('mounts each consent and guard plugin Delo delivers with its switch on', () => {
    const rows = home.rows(DELO_PROFILE)
    for (const row of MOUNTED_PLUGINS) {
      expect(rows.filter(entry => entry.id === row.id && entry.disabled !== true && entry.name === row.name && entry.config?.['enabled'] === true), row.id).toHaveLength(1)
    }
  })

  it('protects the Delo home on the sandbox row, so a confined command cannot read its secrets', () => {
    const sandbox = home.rows(DELO_PROFILE).find(row => row.id === 'sandbox')
    // `dshHomePath` is the harness home, which C1 sets to the Delo home for every runtime process.
    expect(sandbox?.config).toMatchObject({
      protectedHome: { __jsExpr: 'dshHomePath()' },
      protectedHomeReadable: [...READ_EXEMPTIONS],
    })
  })

  it('composes upstream\'s web profile except the listed rows', () => {
    const upstream = dumpConfig(UPSTREAM_TEMPLATE).rows.map(({ row }) => row)
    const delo = dumpConfig(DELO_PROFILE).rows.map(({ row }) => row)
    // A patch rewrites a row in place or appends one, so upstream's rows keep their positions.
    expect(delo.slice(0, upstream.length).map(row => row.id)).toEqual(upstream.map(row => row.id))
    const changed = upstream.flatMap((row, index) => text(row) === text(delo[index] ?? {}) ? [] : [row.id])
    const added = delo.slice(upstream.length).map(row => row.id)
    const listed = (kind: 'changed' | 'added'): (string | undefined)[] => LOCAL_ROWS.filter(row => row.kind === kind).map(row => row.id)
    expect(changed.sort()).toEqual(listed('changed').sort())
    expect(added.sort()).toEqual(listed('added').sort())
  })

  it('carries each listed row as the bundle declares it: changed rows with its field values, added rows enabled or disabled as written', () => {
    const rows = home.rows(DELO_PROFILE)
    for (const listed of LOCAL_ROWS) {
      const declared = declaredRow(listed.id)
      expect(declared, `${listed.id} is declared in cordis.patch.yml`).toBeDefined()
      const composed = rows.find(row => row.id === listed.id)
      expect(composed, `${listed.id} is composed`).toBeDefined()
      // A patch that does not write `disabled` leaves the upstream row's own state.
      if (listed.kind === 'added' || declared?.['disabled'] !== undefined) {
        expect(composed?.disabled === true, `${listed.id} disabled`).toBe(declared?.['disabled'] === true)
      }
      if (listed.kind === 'added') {
        expect(composed?.name, listed.id).toBe(declared?.['name'])
        expect(text({ config: composed?.config ?? null }), `${listed.id} config`).toBe(text({ config: declared?.['config'] ?? null }))
      } else if (declared?.['config'] !== undefined) {
        expect(text({ config: composed?.config }), `${listed.id} config`).toBe(text({ config: declared['config'] }))
      }
    }
  })

  it('resolves each consent and guard row to a plugin this bundle depends on and mounts it enabled', () => {
    const rows = home.rows(DELO_PROFILE)
    const dependencies = (JSON.parse(readFileSync(join(PACKAGE_DIR, 'package.json'), 'utf8')) as { dependencies: Record<string, string> }).dependencies
    for (const plugin of MOUNTED_PLUGINS) {
      expect(LOCAL_ROWS.map(row => row.id), plugin.id).toContain(plugin.id)
      expect(dependencies, plugin.id).toHaveProperty([plugin.name])
      // A bare `name` mounts only if it resolves from the profile; this reads the package the profile's link resolves, without booting a Host.
      const manifest = join(PACKAGE_DIR, 'node_modules', plugin.name, 'package.json')
      expect(existsSync(manifest), `${plugin.name} resolves from the bundle`).toBe(true)
      expect((JSON.parse(readFileSync(manifest, 'utf8')) as { name: string }).name).toBe(plugin.name)
      expect(rows.filter(row => row.name === plugin.name && row.disabled !== true), plugin.id).toHaveLength(1)
    }
  })

  describe('each built parity switch', () => {
    const built = PARITY_SWITCHES.filter((candidate): candidate is BuiltSwitch => candidate.state === 'built')
    for (const entry of built) {
      const reason = UNREACHED_DEFAULTS[entry.id]
      const run = reason === undefined ? it : it.fails
      run(`${entry.id} is configured to the registry's default in the default composition${reason === undefined ? '' : ` (known: ${reason})`}`, () => {
        expect(configuredValue(home.rows(DELO_PROFILE), entry)).toBe(entry.defaultValue)
      })
    }
  })
})
