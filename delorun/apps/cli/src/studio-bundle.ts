/**
 * The studio bundle in a CLI profile that setup created before Delorun shipped it. Every new CLI profile lists
 * `@delorun/bundle-studio` after `@delorun/bundle-local` ({@link DELORUN_PROFILE_BUNDLES}); a profile set up earlier lists
 * `@delorun/bundle-local` alone and so kept the stock look. `delorun start` adds the studio bundle to such a profile with
 * the same operation setup uses ({@link linkDelorunBundles}), once: a profile that lists it, and one that does not list
 * `@delorun/bundle-local` (not a profile Delorun's setup made), is left as it is. The person turns the Delorun look off in
 * Settings → General → Look, which writes the profile's own patch and survives this step.
 *
 * @module @delorun/cli/studio-bundle
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DELORUN_PROFILE_BUNDLES, LOCAL_BUNDLE, STUDIO_BUNDLE } from '@delorun/bundle-local/profile'
import { linkDelorunBundles, type BundleLinking, type LinkReport } from './delorun-bundles.ts'
import { profileDirectory } from './profile.ts'

/**
 * One field of a parsed JSON value.
 * @param value - the value.
 * @param key - the field's name.
 * @returns the field's value, or `undefined` when the value is not an object.
 */
function field(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null ? Reflect.get(value, key) : undefined
}

/**
 * The bundle list a CLI profile's `package.json` names.
 * @param home - the Delorun home.
 * @param profile - the CLI profile.
 * @returns the list, or `undefined` when the manifest cannot be read or names no list of strings.
 */
export function profileBundles(home: string, profile: string): readonly string[] | undefined {
  let manifest: unknown
  try {
    manifest = JSON.parse(readFileSync(join(profileDirectory(home, profile), 'package.json'), 'utf8'))
  } catch {
    // ENOENT or a syntax error: upstream's profile loader reports the manifest itself when the start goes on.
    return undefined
  }
  const bundles = field(field(field(manifest, 'dsh'), 'profile'), 'bundles')
  return Array.isArray(bundles) && bundles.every((name): name is string => typeof name === 'string') ? bundles : undefined
}

/**
 * Whether a CLI profile's bundle list is one setup wrote before the studio bundle existed.
 * @param bundles - the profile's bundle list.
 * @returns true when it names `@delorun/bundle-local` and not `@delorun/bundle-studio`.
 */
export function lacksStudioBundle(bundles: readonly string[]): boolean {
  return bundles.includes(LOCAL_BUNDLE) && !bundles.includes(STUDIO_BUNDLE)
}

/**
 * Add the studio bundle to a CLI profile that setup created before it existed.
 * @param home - the Delorun home.
 * @param profile - the CLI profile.
 * @param linking - upstream's resolution and plugin operation, made only when the profile needs the bundle.
 * @param report - the log that receives the plugin operation's output, and the writer of the one progress line.
 * @returns true when the bundle was added; false when the profile already lists it or is not one Delorun's setup made.
 * @throws {CliError} when the bundle cannot be added, as {@link linkDelorunBundles} throws.
 */
export async function addStudioBundle(
  home: string, profile: string, linking: () => Promise<BundleLinking>, report: LinkReport,
): Promise<boolean> {
  const bundles = profileBundles(home, profile)
  if (bundles === undefined || !lacksStudioBundle(bundles)) return false
  await linkDelorunBundles(home, profile, DELORUN_PROFILE_BUNDLES.filter(name => name === STUDIO_BUNDLE), await linking(), report)
  return true
}
