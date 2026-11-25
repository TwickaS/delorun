/**
 * Forgetting the plugin a profile no longer installs: the load copy under
 * `changes/profiles/<profile>/active/<plugin>` goes, and what Changes recorded about the plugin stays
 * ([paths](./paths.ts)).
 *
 * `delorun plugin` calls it once a removal has succeeded, so a person who installs a plugin, tries it and removes it is
 * left with no copy of its files on disk. The load copy is what the profile would load next, not history: undo reads
 * the content store by digest ([store](./store.ts)), so a change recorded while the plugin was installed can still be
 * undone, and installing the plugin again gives it its approved content back.
 *
 * @module @delorun/changes/forget
 */
import { existsSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { locked } from './action-support.ts'
import type { ChangesContext } from './actions.ts'
import { activeDirectory } from './paths.ts'
import { readActiveRecord, writeActiveRecord } from './records.ts'

/**
 * Forget a plugin the profile no longer installs: remove its load copy,
 * `changes/profiles/<profile>/active/<plugin>`, and the entry `active.json` holds for it. The change log, the agent's
 * log, the approved record and the content store are left as they are, so undoing a change made while the plugin was
 * installed still works. The caller decides that the plugin is gone; nothing here reads the profile's links.
 * @param ctx - the profile.
 * @param plugin - the package name, which the profile no longer depends on.
 * @returns whether there was a load copy or an `active.json` entry to remove.
 * @throws {ChangesError} `NOT_LINKED` when the name is not a package name, before anything is read: a name that is not
 *   one could name a path outside `active/`.
 * @throws {ChangesError} `RECORD_UNREADABLE` when `active.json` is not one Delorun wrote.
 */
export async function forgetPlugin(ctx: ChangesContext, plugin: string): Promise<boolean> {
  const directory = activeDirectory(ctx.home, ctx.profile, plugin)
  return locked(ctx, async () => {
    const record = await readActiveRecord(ctx.home, ctx.profile)
    const recorded = Object.hasOwn(record.plugins, plugin)
    const copied = existsSync(directory)
    if (!recorded && !copied) return false
    await rm(directory, { recursive: true, force: true })
    if (recorded) {
      const plugins = { ...record.plugins }
      delete plugins[plugin]
      await writeActiveRecord(ctx.home, ctx.profile, { schema: record.schema, plugins })
    }
    return true
  })
}
