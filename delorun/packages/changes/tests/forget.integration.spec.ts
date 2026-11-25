/**
 * Forgetting the plugin a profile no longer installs (`delorun/packages/changes/src/forget.ts`): the load copy and the
 * `active.json` entry go, every record of what the plugin changed stays, so a change made while it was installed can
 * still be undone, and a plugin the profile still depends on keeps its copy.
 */
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { parseDocument } from 'yaml'
import { applyChange, listChanges, undoChange, type ChangesContext } from '../src/actions.ts'
import { forgetPlugin } from '../src/forget.ts'
import { activeDirectory, changesDirectory } from '../src/paths.ts'
import { readActiveRecord, readApproved, readChangeLog } from '../src/records.ts'
import { holdsVersion, readVersion } from '../src/store.ts'
import type { PluginChange } from '../src/types.ts'
import { fixture, folder, linkAs, migrated, NOW, PROFILE, start, terminal, type Fixture } from './profile-fixture.ts'
import { rejection } from './support.ts'

// Each case writes real git histories and scans folders; under a loaded host that takes longer than vitest's default.
vi.setConfig({ testTimeout: 60_000 })

/**
 * @param fx - the fixture.
 * @returns the context every case here runs with.
 */
function contextOf(fx: Fixture): ChangesContext {
  return { home: fx.home, profile: PROFILE, profileDir: fx.profileDir, now: () => NOW, lockWaitMs: 5_000 }
}

/**
 * Remove a dependency as `dsh plugin remove` leaves it: out of the manifest and the lockfile's importer, and its link out
 * of `node_modules`.
 * @param fx - the fixture.
 * @param name - the package name.
 */
function uninstallAs(fx: Fixture, name: string): void {
  const manifestPath = join(fx.profileDir, 'package.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { dependencies: Record<string, string> }
  delete manifest.dependencies[name]
  writeFileSync(manifestPath, `${JSON.stringify(manifest, undefined, 2)}\n`)
  const lockPath = join(fx.profileDir, 'pnpm-lock.yaml')
  const lock = parseDocument(readFileSync(lockPath, 'utf8'))
  lock.deleteIn(['importers', '.', 'dependencies', name])
  writeFileSync(lockPath, lock.toString())
  rmSync(join(fx.profileDir, 'node_modules', name), { force: true })
}

/**
 * @param source - the plugin folder.
 * @param body - the new text of its `index.js`.
 */
function edit(source: string, body: string): void {
  writeFileSync(join(source, 'index.js'), body)
}

/**
 * @param ctx - the context.
 * @returns the only change waiting for review.
 */
async function onlyPending(ctx: ChangesContext): Promise<PluginChange> {
  const { pending } = await listChanges(ctx)
  expect(pending).toHaveLength(1)
  return pending[0]!
}

describe('forgetting a removed plugin', () => {
  it('removes its load copy and its active entry, and keeps the store, the log and the approval', async () => {
    const { fx, approved } = await migrated()
    const ctx = contextOf(fx)
    const directory = activeDirectory(fx.home, PROFILE, 'plug')
    expect(readFileSync(join(directory, 'index.js'), 'utf8')).toBe('export default "one"\n')
    uninstallAs(fx, 'plug')

    expect(await forgetPlugin(ctx, 'plug')).toBe(true)
    expect(existsSync(directory)).toBe(false)
    expect((await readActiveRecord(fx.home, PROFILE)).plugins).toEqual({})
    // History: the change log entry, the approved record and the content the store keeps for undo.
    expect((await readChangeLog(fx.home, PROFILE)).entries).toMatchObject([{ kind: 'plugin-install', subject: { plugin: 'plug' }, state: 'applied' }])
    expect((await readApproved(fx.profileDir)).plugins.plug?.version).toBe(approved)
    expect((await readVersion(fx.home, approved)).entries.some(entry => entry.type === 'file' && entry.path === 'index.js')).toBe(true)
    // Nothing is left to forget twice.
    expect(await forgetPlugin(ctx, 'plug')).toBe(false)
  })

  it('leaves the copy of a plugin the profile still depends on alone', async () => {
    const { fx, approved } = await migrated()
    const ctx = contextOf(fx)
    linkAs(fx, 'other', folder(fx, 'other'))
    await start(fx)
    const other = activeDirectory(fx.home, PROFILE, 'other')
    expect(existsSync(other)).toBe(true)
    uninstallAs(fx, 'plug')

    expect(await forgetPlugin(ctx, 'plug')).toBe(true)
    expect(existsSync(other)).toBe(true)
    expect((await readActiveRecord(fx.home, PROFILE)).plugins.plug).toBeUndefined()
    expect(await holdsVersion(fx.home, other, approved)).toBe(false)
  })

  it('keeps undo working for a change made while the plugin was installed', async () => {
    const { fx, source, approved } = await migrated()
    const ctx = contextOf(fx)
    edit(source, 'export default "two"\n')
    const change = await onlyPending(ctx)
    await applyChange(ctx, change.id, terminal(), { reload: async () => undefined })
    const directory = activeDirectory(fx.home, PROFILE, 'plug')
    expect(readFileSync(join(directory, 'index.js'), 'utf8')).toBe('export default "two"\n')
    uninstallAs(fx, 'plug')
    expect(await forgetPlugin(ctx, 'plug')).toBe(true)
    expect(existsSync(directory)).toBe(false)

    const undone = await undoChange(ctx, change.id, terminal(), { reload: async () => undefined })
    expect(undone.entry.state).toBe('undone')
    expect(readFileSync(join(directory, 'index.js'), 'utf8')).toBe('export default "one"\n')
    expect(await holdsVersion(fx.home, directory, approved)).toBe(true)
    expect(await holdsVersion(fx.home, directory, change.to)).toBe(false)
  })

  it('refuses a name that is not a package name, and removes nothing', async () => {
    const { fx, approved } = await migrated()
    const ctx = contextOf(fx)
    await rejection(forgetPlugin(ctx, '../plug'), 'NOT_LINKED')
    expect(existsSync(activeDirectory(fx.home, PROFILE, 'plug'))).toBe(true)
    expect((await readActiveRecord(fx.home, PROFILE)).plugins.plug?.version).toBe(approved)
    expect((await readChangeLog(fx.home, PROFILE)).entries).toHaveLength(1)
  })

  it('answers false without creating a changes directory for a profile that has none', async () => {
    const fx = fixture({ protection: 'off' })
    expect(await forgetPlugin(contextOf(fx), 'plug')).toBe(false)
    expect(existsSync(changesDirectory(fx.home))).toBe(false)
  })
})
