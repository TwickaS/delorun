/**
 * What putting the profile back as one history version held it changes: the dependencies, the bundle selection, the
 * pnpm build decisions and the version exemptions, compared file by file with the profile as it is now. The comparison
 * reads file text only; it installs, writes and runs nothing.
 */
import { PROFILE_COMPATIBILITY_FILENAME } from '@deepseek-ai/dsh-app-boot'
import { parse } from 'yaml'
import type {
  ProfileBuildChange, ProfileBuildDecision, ProfileExemptionChange, ProfilePluginChange, ProfileVersionChanges,
} from './types.ts'

/** The value pnpm writes for a build script that still needs a decision. */
const UNDECIDED_BUILD = 'set this to true or false'

/** The managed files' text by name relative to the profile directory; an absent file reads as undefined. */
export type ProfileFiles = ReadonlyMap<string, string | undefined>

/** A file's parsed value, or `unreadable` when its text cannot be parsed. */
type Parsed<T> = { readonly ok: true; readonly value: T } | { readonly ok: false }

function parsedJson(text: string | undefined): Parsed<unknown> {
  if (text === undefined) return { ok: true, value: undefined }
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (_error) {
    // A file that is not JSON is reported as unreadable; the comparison lists no change from it.
    return { ok: false }
  }
  return { ok: true, value }
}

function parsedYaml(text: string | undefined): Parsed<unknown> {
  if (text === undefined) return { ok: true, value: undefined }
  let value: unknown
  try {
    value = parse(text)
  } catch (_error) {
    // A file that is not YAML is reported as unreadable; the comparison lists no change from it.
    return { ok: false }
  }
  return { ok: true, value }
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function dependencies(manifest: unknown): Record<string, string> {
  return Object.fromEntries(Object.entries(record(record(manifest)['dependencies']))
    .flatMap(([name, spec]) => typeof spec === 'string' ? [[name, spec]] : []))
}

function bundleSelection(manifest: unknown): string[] {
  const bundles = record(record(record(manifest)['dsh'])['profile'])['bundles']
  return Array.isArray(bundles) ? bundles.filter((name): name is string => typeof name === 'string') : []
}

function buildDecisions(workspace: unknown): Record<string, ProfileBuildDecision> {
  return Object.fromEntries(Object.entries(record(record(workspace)['allowBuilds'])).flatMap(([name, value]): Array<[string, ProfileBuildDecision]> =>
    value === true ? [[name, 'allowed']]
      : value === false ? [[name, 'denied']]
        : value === UNDECIDED_BUILD ? [[name, 'pending']] : []))
}

/** Each grant a compatibility file holds, keyed by its package and runtime versions. */
function grants(compatibility: unknown): Map<string, Omit<ProfileExemptionChange, 'change'>> {
  return new Map(Object.entries(record(compatibility)).flatMap(([packageVersion, versions]) =>
    (Array.isArray(versions) ? versions : [])
      .filter((runtimeVersion): runtimeVersion is string => typeof runtimeVersion === 'string')
      .map(runtimeVersion => [`${packageVersion}\u0000${runtimeVersion}`, { packageVersion, runtimeVersion }] as const)))
}

/**
 * Compare the profile's files now with the files a version holds.
 * @param current - the managed files as they are now.
 * @param restored - the managed files as the version holds them.
 * @returns the changes the version would make, with the files that could not be parsed named in `unreadable`.
 */
export function profileVersionChanges(current: ProfileFiles, restored: ProfileFiles): ProfileVersionChanges {
  const unreadable: string[] = []
  const read = <T>(name: string, parser: (text: string | undefined) => Parsed<T>): [T | undefined, T | undefined] | undefined => {
    const now = parser(current.get(name))
    const then = parser(restored.get(name))
    if (now.ok && then.ok) return [now.value, then.value]
    unreadable.push(name)
    return undefined
  }

  const plugins: ProfilePluginChange[] = []
  const bundles: Array<{ name: string; selected: boolean }> = []
  const manifests = read('package.json', parsedJson)
  if (manifests !== undefined) {
    const [now, then] = [dependencies(manifests[0]), dependencies(manifests[1])]
    for (const [name, to] of Object.entries(then)) {
      const from = now[name]
      if (from === undefined) plugins.push({ name, change: 'added', to })
      else if (from !== to) plugins.push({ name, change: 'version', from, to })
    }
    for (const [name, from] of Object.entries(now)) if (!Object.hasOwn(then, name)) plugins.push({ name, change: 'removed', from })
    // Names are unique, so no two compare equal.
    plugins.sort((a, b) => (a.name < b.name ? -1 : 1))
    const [selectedNow, selectedThen] = [new Set(bundleSelection(manifests[0])), new Set(bundleSelection(manifests[1]))]
    for (const name of [...new Set([...selectedNow, ...selectedThen])].sort()) {
      if (selectedNow.has(name) !== selectedThen.has(name)) bundles.push({ name, selected: selectedThen.has(name) })
    }
  }

  const builds: ProfileBuildChange[] = []
  const workspaces = read('pnpm-workspace.yaml', parsedYaml)
  if (workspaces !== undefined) {
    const [now, then] = [buildDecisions(workspaces[0]), buildDecisions(workspaces[1])]
    for (const name of [...new Set([...Object.keys(now), ...Object.keys(then)])].sort()) {
      const [from, to] = [now[name], then[name]]
      if (from !== to) builds.push({ name, ...from === undefined ? {} : { from }, ...to === undefined ? {} : { to } })
    }
  }

  const exemptions: ProfileExemptionChange[] = []
  const compatibility = read(PROFILE_COMPATIBILITY_FILENAME, parsedJson)
  if (compatibility !== undefined) {
    const [now, then] = [grants(compatibility[0]), grants(compatibility[1])]
    const only = (held: typeof now, other: typeof now) => [...held].filter(([key]) => !other.has(key)).map(([, grant]) => grant)
    exemptions.push(...only(then, now).map(grant => ({ ...grant, change: 'added' as const })))
    exemptions.push(...only(now, then).map(grant => ({ ...grant, change: 'removed' as const })))
  }

  const patchChanged = current.get('cordis.patch.yml') !== restored.get('cordis.patch.yml')
  // The home patch's copy is not one of the files this comparison reads; the caller that tracks it says whether it differs.
  return { plugins, bundles, builds, exemptions, patchChanged, homePatchChanged: false, unreadable }
}

/**
 * The packages a version brings back, which the plugin audit reads before they run: each dependency it adds or puts
 * at another spec, and each bundle it selects.
 * @param changes - the version's changes.
 * @returns package names, each once.
 */
export function broughtBack(changes: ProfileVersionChanges): string[] {
  return [...new Set([
    ...changes.plugins.filter(plugin => plugin.change !== 'removed').map(plugin => plugin.name),
    ...changes.bundles.filter(bundle => bundle.selected).map(bundle => bundle.name),
  ])]
}
