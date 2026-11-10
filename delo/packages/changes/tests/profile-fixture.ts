/**
 * A Delo home with one profile, plugin folders, and `link:` dependencies recorded as pnpm records them, for the specs of
 * what a start loads and of the invariants it keeps.
 *
 * @module @delo/changes/tests/profile-fixture
 */
import { mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { parse, parseDocument } from 'yaml'
import { openHistory } from '@delo/profile-safety'
import { enforceApprovedContent, type StartChanges } from '../src/enforce.ts'
import { activeDirectory } from '../src/paths.ts'
import { attestTerminal, markShownAtUpgrade, readApproved, type AtComputer } from '../src/records.ts'
import type { ContentVersion } from '../src/types.ts'
import { temporaryDirectory, writeFiles } from './support.ts'

/** The clock every fixture start reads. */
export const NOW = new Date('2026-11-10T10:00:00.000Z')

/** The fixture's profile. */
export const PROFILE = 'default'

/**
 * @returns a proof that the person is at a terminal.
 */
export function terminal(): AtComputer {
  return attestTerminal({ stdin: { isTTY: true }, stdout: { isTTY: true } })
}

export interface Fixture {
  readonly root: string
  readonly home: string
  readonly profileDir: string
}

/**
 * A Delo home with the profile `default`, whose manifest and lockfile list no dependency yet.
 * @returns the fixture.
 */
export function fixture(): Fixture {
  const root = temporaryDirectory()
  const home = join(root, '.delo')
  mkdirSync(home, { mode: 0o700 })
  const profileDir = join(home, 'profiles', PROFILE)
  writeFiles(profileDir, {
    'package.json': `${JSON.stringify({ name: 'dsh-profile-default', private: true, dependencies: { 'left-pad': '^1.3.0' }, dsh: { profile: { bundles: [] } } }, undefined, 2)}\n`,
    'pnpm-lock.yaml': "lockfileVersion: '9.0'\n\nimporters:\n\n  .:\n    dependencies:\n      left-pad:\n        specifier: ^1.3.0\n        version: 1.3.0\n",
  })
  return { root, home, profileDir }
}

/**
 * A plugin folder.
 * @param fx - the fixture.
 * @param name - the folder's name under the fixture root.
 * @param body - the text of its `index.js`.
 * @returns the folder.
 */
export function folder(fx: Fixture, name: string, body = 'export default "one"\n'): string {
  const path = join(fx.root, name)
  writeFiles(path, { 'package.json': `{"name":"${name}","version":"1.0.0"}\n`, 'index.js': body })
  return path
}

/**
 * Record a `link:` dependency the way `delorun plugin add link:<folder>` leaves it: the manifest's spec, the lockfile's
 * importer entry and the relative link under `node_modules`.
 * @param fx - the fixture.
 * @param name - the package name.
 * @param target - what the link names.
 */
export function linkAs(fx: Fixture, name: string, target: string): void {
  const manifestPath = join(fx.profileDir, 'package.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { dependencies: Record<string, string> }
  manifest.dependencies[name] = `link:${target}`
  writeFileSync(manifestPath, `${JSON.stringify(manifest, undefined, 2)}\n`)
  const lockPath = join(fx.profileDir, 'pnpm-lock.yaml')
  const lock = parseDocument(readFileSync(lockPath, 'utf8'))
  lock.setIn(['importers', '.', 'dependencies', name], lock.createNode({ specifier: `link:${target}`, version: `link:${relative(fx.profileDir, target)}` }))
  writeFileSync(lockPath, lock.toString())
  const link = join(fx.profileDir, 'node_modules', name)
  mkdirSync(dirname(link), { recursive: true })
  rmSync(link, { force: true })
  symlinkSync(relative(dirname(link), target), link)
}

/**
 * Run the start's enforcement as a start at a terminal does: what it names as approved at upgrade is recorded as shown.
 * @param fx - the fixture.
 * @returns what the start prints.
 */
export async function start(fx: Fixture): Promise<StartChanges> {
  const changes = await enforceApprovedContent({ home: fx.home, profile: PROFILE, profileDir: fx.profileDir, now: () => NOW })
  await markShownAtUpgrade({ home: fx.home, profile: PROFILE, profileDir: fx.profileDir, lockWaitMs: 1000 }, changes.approvedAtUpgrade.map(({ plugin }) => plugin), NOW.toISOString())
  return changes
}

/**
 * Where the profile's three records of a dependency point.
 * @param fx - the fixture.
 * @param name - the package name.
 * @returns the manifest's spec, the lockfile's specifier and version resolved, and the link's real target.
 */
export function recorded(fx: Fixture, name: string): { spec: string, specifier: string, version: string, link: string } {
  const manifest = JSON.parse(readFileSync(join(fx.profileDir, 'package.json'), 'utf8')) as { dependencies: Record<string, string> }
  const lock = parse(readFileSync(join(fx.profileDir, 'pnpm-lock.yaml'), 'utf8')) as { importers: { '.': { dependencies: Record<string, { specifier: string, version: string }> } } }
  const entry = lock.importers['.'].dependencies[name]!
  return {
    spec: manifest.dependencies[name]!,
    specifier: entry.specifier,
    version: join(fx.profileDir, entry.version.slice('link:'.length)),
    link: realpathSync(join(fx.profileDir, 'node_modules', name)),
  }
}

/**
 * @param fx - the fixture.
 * @param name - the package name.
 * @returns the profile's three records all naming the plugin's active directory.
 */
export function namingActive(fx: Fixture, name: string): { spec: string, specifier: string, version: string, link: string } {
  const active = activeDirectory(fx.home, PROFILE, name)
  return { spec: `link:${active}`, specifier: `link:${active}`, version: active, link: active }
}

/**
 * @param fx - the fixture.
 * @returns the profile history's subjects, newest first.
 */
export async function history(fx: Fixture): Promise<string[]> {
  return (await openHistory({ profileDir: fx.profileDir }).list(50)).map(version => version.summary)
}

/**
 * @param fx - the fixture.
 * @param name - the package name.
 * @returns the plugin's approved version.
 */
export async function approvedVersion(fx: Fixture, name: string): Promise<ContentVersion> {
  const approval = (await readApproved(fx.profileDir)).plugins[name]
  if (approval === undefined) throw new Error(`${name} has no approved version`)
  return approval.version
}

/**
 * Migrate a fixture with one plugin linked from a folder, `plug`.
 * @returns the fixture, the folder and the approved version.
 */
export async function migrated(): Promise<{ fx: Fixture, source: string, approved: ContentVersion }> {
  const fx = fixture()
  const source = folder(fx, 'plug')
  linkAs(fx, 'plug', source)
  await start(fx)
  return { fx, source, approved: await approvedVersion(fx, 'plug') }
}
