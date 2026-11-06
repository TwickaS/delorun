/**
 * The CLI profile `delorun` runs (contract C1, "Profiles"): `default`, or the
 * name `--profile` or `DELO_PROFILE` selects under upstream's profile-name
 * rules. The desktop app's `desktop` profile is refused, so `delorun` never
 * runs, initialises or changes it.
 *
 * @module @delo/cli/profile
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { resolveProfileDir } from '@deepseek-ai/dsh-app-boot'
import { CLI_PROFILE, DELO_PROFILE_ENV, DESKTOP_PROFILE } from '@delo/contract-home-layout'
import { CliError, EXIT } from './exit.ts'

/**
 * Select the CLI profile.
 * @param flag - the `--profile` value, which wins over the environment.
 * @param env - the environment, read for `DELO_PROFILE`; blank counts as unset.
 * @returns the profile name.
 * @throws {CliError} with the usage code for the desktop app's profile or a name upstream's rules refuse.
 */
export function selectProfile(flag: string | undefined, env: Readonly<Record<string, string | undefined>>): string {
  const fromEnv = env[DELO_PROFILE_ENV]
  const name = flag ?? (fromEnv !== undefined && fromEnv.trim().length > 0 ? fromEnv : CLI_PROFILE)
  const source = flag === undefined ? DELO_PROFILE_ENV : '--profile'
  if (name.toLowerCase() === DESKTOP_PROFILE) {
    throw new CliError(EXIT.usage, `delorun: ${source} names "${name}", the desktop app's own profile, which only the desktop app runs or changes; choose another profile name`)
  }
  try {
    // Upstream's rules: not empty, no path separator, not `.`, `..` or `node_modules`.
    resolveProfileDir(name, '/')
  } catch {
    throw new CliError(EXIT.usage, `delorun: ${source} names ${JSON.stringify(name)}, which is not a valid profile name`)
  }
  return name
}

/**
 * The directory of a CLI profile under the home.
 * @param home - the Delo home.
 * @param profile - a name {@link selectProfile} returned.
 * @returns `<home>/profiles/<profile>`.
 */
export function profileDirectory(home: string, profile: string): string {
  return resolveProfileDir(profile, home)
}

/**
 * Whether the home holds the CLI profile, which setup creates in upstream's profile layout.
 * @param home - the Delo home.
 * @param profile - the CLI profile's name.
 * @returns true when the profile's `package.json` exists.
 */
export function hasCliProfile(home: string, profile: string): boolean {
  return existsSync(join(profileDirectory(home, profile), 'package.json'))
}
