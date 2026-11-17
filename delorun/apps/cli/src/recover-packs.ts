/**
 * `delorun recover packs`: hash every installed plugin pack of the running release against its signed file list and
 * fetch again any that no longer matches, from the release channel the home was installed from. A pack that cannot be
 * fetched stays removed, so the next start does not load a changed one.
 *
 * @module @delorun/cli/recover-packs
 */
import { packFilesFor } from '@delorun/plugin-packs/environment'
import { checkPacksBundle } from '@delorun/release-verify'
import { repairPacks, RuntimeStore } from '@delorun/runtime-store'
import { EXIT } from './exit.ts'
import type { CommandContext, CommandResult } from './command.ts'
import { SILENT } from './recover.ts'
import { runtimePlatformOf } from './update/channel.ts'
import { launcherAnchor } from './update/trusted-root.ts'

/**
 * Re-verify and, where needed, re-fetch the running release's packs.
 * @param home - the resolved Delorun home.
 * @param context - the environment and output.
 * @returns the exit code: 0 when every pack is intact or was repaired.
 */
export async function recoverPacks(home: string, context: CommandContext): Promise<CommandResult> {
  const store = new RuntimeStore({ home, platform: runtimePlatformOf(process.platform, process.arch), logger: SILENT })
  const { current } = await store.pointers()
  const anchor = launcherAnchor(home, context.env)
  try {
    const result = await repairPacks({ paths: store.paths, root: anchor.root, filesFor: version => packFilesFor(home, version), checkLog: checkPacksBundle }, current)
    for (const name of result.intact) context.stdout(`${name}: intact\n`)
    for (const name of result.repaired) context.stdout(`${name}: changed, fetched again\n`)
    if (result.intact.length + result.repaired.length === 0) context.stdout('No plugin packs are installed.\n')
    return EXIT.ok
  } catch (error) {
    context.stderr(`delorun recover: a plugin pack could not be repaired: ${error instanceof Error ? error.message : String(error)}\n`)
    return EXIT.failed
  }
}
