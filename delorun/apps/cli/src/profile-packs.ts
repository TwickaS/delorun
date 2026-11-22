/**
 * Plugin packs a profile links but the home lacks, fetched before a start boots the Host. A pack's files live in
 * `<home>/packs/<release>/<pack>/package`, which the plugin manager links into the profile through `<home>/packs/current`, so a profile that
 * links a pack through that link whose folder is missing (an imported setup, a failed carry) would otherwise fail
 * to load that plugin. The step fetches it through the verified pack install; when it cannot, it prints one line with the
 * reason and `delorun recover packs`, and the start carries on without those plugins. A damaged pack is a different
 * case: the runtime store's start check refuses it.
 *
 * @module @delorun/cli/profile-packs
 */
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, relative, sep, resolve } from 'node:path'
import { DELORUN_HOME_ENTRIES } from '@delorun/contract-home-layout'
import { hostPacksEnvironment } from '@delorun/plugin-packs/environment'
import { createRenderer } from '@delorun/install'
import { acquirePacks, fetchPack, installFetchedPack, packDownloadSize, readStoredPacks } from '@delorun/runtime-store'
import { profileDirectory } from './profile.ts'
import type { PreStartContext } from './pre-start.ts'

/**
 * The packs the profile links from the running release's pack folder whose folder is missing.
 * @param home - the Delorun home.
 * @param profile - the profile's name.
 * @returns the pack folder names (`@scope__name` for a scoped package), sorted.
 */
export async function missingProfilePacks(home: string, profile: string): Promise<string[]> {
  const manifest = await readFile(join(profileDirectory(home, profile), 'package.json'), 'utf8').then(text => JSON.parse(text) as { dependencies?: Record<string, unknown> }, () => undefined)
  const release = join(home, DELORUN_HOME_ENTRIES.packs, 'current')
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
    const folders = await missingProfilePacks(context.home, context.profile)
    if (folders.length === 0) return
    context.output.stdout(`Fetching ${String(folders.length)} plugin ${folders.length === 1 ? 'pack' : 'packs'} this profile uses: ${folders.map(folder => folder.replace('__', '/')).join(', ')}\n`)
    try {
      await fetchPacks(context, folders)
    } catch (error) {
      // The start carries on: the rows of the missing packs do not load, and Plugins and the downloads panel offer Retry.
      context.output.stderr(`delorun: could not fetch the plugin ${folders.length === 1 ? 'pack' : 'packs'} ${folders.map(folder => folder.replace('__', '/')).join(', ')} (${error instanceof Error ? error.message : String(error)}); starting without ${folders.length === 1 ? 'it' : 'them'}. Run \`delorun recover packs\` or retry in Plugins.\n`)
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
  const display = createRenderer(text => { context.output.stdout(text) }, process.stdout, process.env)
  try {
    for (const folder of folders) {
      const entry = packs.packs.find(each => each.name.replaceAll('/', '__') === folder)
      if (entry === undefined) throw new Error(`release ${release.version} publishes no plugin pack ${folder.replace('__', '/')}`)
      const total = packDownloadSize(entry, release.paths.platform)
      display.handle({ step: 'pack-downloading', name: entry.name, bytes: total })
      const fetched = await fetchPack(release, entry.name, environment.files, { onBytes: (received) => { display.handle({ step: 'pack-bytes', name: entry.name, received, total }) } })
      display.handle({ step: 'pack-installing', name: entry.name, bytes: total })
      await installFetchedPack(release, fetched)
      display.handle({ step: 'pack-installed', name: entry.name })
    }
  } catch (error) {
    display.fail()
    throw error
  }
  display.close()
}
