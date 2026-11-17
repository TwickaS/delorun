/**
 * Plugin packs a profile links but the home lacks, fetched before a start boots the Host. A pack's files live in
 * `<home>/packs/<release>/<pack>/package` (the plugin manager links that folder into the profile), so a profile that
 * links a pack folder of the running release which is missing (an imported setup, a failed carry) would otherwise fail
 * to load that plugin. The step fetches it through the verified pack install, and refuses the start with the remedy
 * when it cannot: a missing pack is never skipped silently.
 *
 * @module @delorun/cli/profile-packs
 */
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, relative, sep, resolve } from 'node:path'
import { DELORUN_HOME_ENTRIES } from '@delorun/contract-home-layout'
import { hostPacksEnvironment } from '@delorun/plugin-packs/environment'
import { acquirePacks, fetchPack, installFetchedPack, readStoredPacks } from '@delorun/runtime-store'
import { CliError, EXIT } from './exit.ts'
import { profileDirectory } from './profile.ts'
import type { PreStartContext } from './pre-start.ts'

/**
 * The packs the profile links from the running release's pack folder whose folder is missing.
 * @param home - the Delorun home.
 * @param profile - the profile's name.
 * @param version - the running release.
 * @returns the pack folder names (`@scope__name` for a scoped package), sorted.
 */
export async function missingProfilePacks(home: string, profile: string, version: string): Promise<string[]> {
  const manifest = await readFile(join(profileDirectory(home, profile), 'package.json'), 'utf8').then(text => JSON.parse(text) as { dependencies?: Record<string, unknown> }, () => undefined)
  const release = join(home, DELORUN_HOME_ENTRIES.packs, version)
  const missing = new Set<string>()
  for (const spec of Object.values(manifest?.dependencies ?? {})) {
    if (typeof spec !== 'string' || !spec.startsWith('link:')) continue
    const path = resolve(spec.slice('link:'.length))
    const inside = relative(release, path)
    if (inside === '' || inside.startsWith('..') || inside.startsWith(sep)) continue
    if (!existsSync(path)) missing.add(inside.split(sep)[0]!)
  }
  return [...missing].sort()
}

/** Fetch and install packs of the running release. */
export type FetchProfilePacks = (context: PreStartContext, folders: readonly string[]) => Promise<void>

/**
 * The pre-start step: fetch each missing pack the profile links.
 * @param fetchPacks - fetches and installs them.
 * @returns the step's `run`.
 */
export function profilePacksStep(fetchPacks: FetchProfilePacks): (context: PreStartContext) => Promise<void> {
  return async (context) => {
    if (context.storedRuntime === undefined) return
    const folders = await missingProfilePacks(context.home, context.profile, context.storedRuntime.version)
    if (folders.length === 0) return
    context.output.stdout(`Fetching ${String(folders.length)} plugin ${folders.length === 1 ? 'pack' : 'packs'} this profile uses: ${folders.map(folder => folder.replace('__', '/')).join(', ')}\n`)
    try {
      await fetchPacks(context, folders)
    } catch (error) {
      throw new CliError(EXIT.failed, `delorun: a plugin pack this profile uses is missing and could not be fetched: ${error instanceof Error ? error.message : String(error)}\nConnect to the internet and start again, or run \`delorun recover packs\`, or turn the plugin off in Plugins.`)
    }
  }
}

/**
 * Fetch and install packs through the running installation's verified release and channel.
 * @param context - the start.
 * @param folders - the pack folder names.
 * @returns when every pack is installed.
 * @throws when the process has no installation to take packs from, a pack is not in the release's packs file, or a fetch or install refuses.
 */
export const fetchPacksFromRelease: FetchProfilePacks = async (context, folders) => {
  const environment = await hostPacksEnvironment(process.env)
  if ('unsupported' in environment) throw new Error(environment.unsupported)
  const release = await environment.release()
  const packs = await readStoredPacks(release) ?? await acquirePacks(release, environment.files)
  if (packs === undefined) throw new Error(`release ${release.version} publishes no plugin packs`)
  for (const folder of folders) {
    const entry = packs.packs.find(each => each.name.replaceAll('/', '__') === folder)
    if (entry === undefined) throw new Error(`release ${release.version} publishes no plugin pack ${folder.replace('__', '/')}`)
    await installFetchedPack(release, await fetchPack(release, entry.name, environment.files))
    context.output.stdout(`Fetched ${entry.name}\n`)
  }
}
