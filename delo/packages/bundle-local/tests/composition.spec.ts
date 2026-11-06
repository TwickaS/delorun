/**
 * Composition of a Delo CLI profile, read through upstream's real `dsh --profile <name> --dump-config`: every row
 * names the bundle that wrote it, and the composition differs from upstream's web profile only in {@link LOCAL_ROWS}.
 */
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import yaml from 'js-yaml'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'
import { composeEntries, initProfile, loadProfileDirectory } from '@deepseek-ai/dsh-app-boot'
import { DELO_PROFILE_BUNDLES, LOCAL_BUNDLE, LOCAL_ROWS, UPSTREAM_TEMPLATE } from '../src/profile.ts'

const REPO = fileURLToPath(new URL('../../../../', import.meta.url))
const PACKAGE_DIR = fileURLToPath(new URL('..', import.meta.url))
const INSTALL_ANCHOR = join(REPO, 'apps/cli/package.json')
const DELO_PROFILE = 'default'

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

let home: string

/**
 * Run upstream's CLI from source and split its dump at each `# ==` label.
 * @param profile - the profile name under the temporary home.
 * @returns the labelled rows, the text before the first label and the process's stderr.
 */
function dumpConfig(profile: string): Dump {
  const result = spawnSync(process.execPath, ['--import', 'tsx/esm', join(REPO, 'apps/cli/src/bin.ts'), '--profile', profile, '--dump-config'], {
    cwd: REPO, env: { ...process.env, DSH_HOME: home }, encoding: 'utf8',
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

const text = (row: DumpedRow['row']): string => yaml.dump(row, { schema: entryListSchema, noRefs: true })

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), 'delo-bundle-local-'))
  const dir = join(home, 'profiles', DELO_PROFILE)
  initProfile(dir, DELO_PROFILE_BUNDLES)
  // `dsh plugin add` leaves a profile-installed bundle linked under the profile's node_modules.
  const link = join(dir, 'node_modules', LOCAL_BUNDLE)
  mkdirSync(dirname(link), { recursive: true })
  symlinkSync(PACKAGE_DIR, link, 'junction')
})

afterAll(() => { rmSync(home, { recursive: true, force: true }) })

describe('a Delo CLI profile', () => {
  it('lists upstream\'s web template followed by this bundle', () => {
    expect(DELO_PROFILE_BUNDLES).toEqual(['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', LOCAL_BUNDLE])
    expect(UPSTREAM_TEMPLATE).toBe('web')
  })

  it('loads every bundle of the list, this one included, and skips none', () => {
    const profile = loadProfileDirectory('dsh', join(home, 'profiles', DELO_PROFILE), INSTALL_ANCHOR)
    expect(profile.skippedBundles).toEqual([])
    expect(profile.layers.map(layer => layer.packageName)).toEqual(DELO_PROFILE_BUNDLES)
  })

  it('--dump-config lists every row with its writer and none without one', () => {
    const dump = dumpConfig(DELO_PROFILE)
    expect(dump.stderr).toBe('')
    expect(dump.preamble).toBe('')
    const profile = loadProfileDirectory('dsh', join(home, 'profiles', DELO_PROFILE), INSTALL_ANCHOR)
    expect(dump.rows).toHaveLength(composeEntries(profile.layers.map(layer => layer.patches)).length)
    for (const { label, row } of dump.rows) {
      for (const writer of writers(label)) expect(DELO_PROFILE_BUNDLES, `${row.id ?? '(no id)'} under "${label}"`).toContain(writer)
    }
    const local = dump.rows.filter(({ label }) => writers(label).includes(LOCAL_BUNDLE)).map(({ row }) => row.id)
    expect(local).toEqual(LOCAL_ROWS.map(row => row.id))
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
})
