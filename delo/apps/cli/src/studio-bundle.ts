/**
 * The studio bundle in a CLI profile that setup created before Delo shipped it. Every new CLI profile lists
 * `@delo/bundle-studio` after `@delo/bundle-local` ({@link DELO_PROFILE_BUNDLES}); a profile set up earlier lists
 * `@delo/bundle-local` alone and so kept the stock look. `delorun start` adds the studio bundle to such a profile with
 * the same operation setup uses ({@link linkDeloBundles}), once: a profile that lists it, and one that does not list
 * `@delo/bundle-local` (not a profile Delo's setup made), is left as it is. The person turns the Delo look off in
 * Settings → Appearance, which writes the profile's own patch and survives this step.
 *
 * @module @delo/cli/studio-bundle
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DELO_PROFILE_BUNDLES, LOCAL_BUNDLE, STUDIO_BUNDLE } from '@delo/bundle-local/profile'
import { linkDeloBundles, type BundleLinking } from './delo-bundles.ts'
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
 * @param home - the Delo home.
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
 * @returns true when it names `@delo/bundle-local` and not `@delo/bundle-studio`.
 */
export function lacksStudioBundle(bundles: readonly string[]): boolean {
  return bundles.includes(LOCAL_BUNDLE) && !bundles.includes(STUDIO_BUNDLE)
}

/**
 * Add the studio bundle to a CLI profile that setup created before it existed.
 * @param home - the Delo home.
 * @param profile - the CLI profile.
 * @param linking - upstream's resolution and plugin operation, made only when the profile needs the bundle.
 * @param onOutput - receives the plugin operation's output.
 * @returns true when the bundle was added; false when the profile already lists it or is not one Delo's setup made.
 * @throws {CliError} when the bundle cannot be added, as {@link linkDeloBundles} throws.
 */
export async function addStudioBundle(
  home: string, profile: string, linking: () => Promise<BundleLinking>,
  onOutput: (text: string, stream: 'stdout' | 'stderr') => void,
): Promise<boolean> {
  const bundles = profileBundles(home, profile)
  if (bundles === undefined || !lacksStudioBundle(bundles)) return false
  await linkDeloBundles(home, profile, DELO_PROFILE_BUNDLES.filter(name => name === STUDIO_BUNDLE), await linking(), onOutput)
  return true
}
