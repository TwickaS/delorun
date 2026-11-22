/** Where the app's home runs: upstream's bundled Host, or a Delorun home inside a WSL2 distribution. */

import { z } from 'zod'
import { DesktopSettingsFile } from './settings-file.ts'

/** Environment variable that selects the home source for a preview build: `bundled`, or `wsl:<distribution>[:<profile>]`. */
export const HOME_SOURCE_ENV = 'DELORUN_DESKTOP_HOME'

/** Profile a WSL home source uses when none is named. */
export const DEFAULT_HOME_PROFILE = 'default'

/** The chosen home. `bundled` is upstream's Host started by the app; `wsl` is a home that `delorun` runs in a distribution. */
export type HomeSource =
  | { readonly kind: 'bundled' }
  | { readonly kind: 'wsl'; readonly distro: string; readonly profile: string }

/** A home source that is written wrongly in the environment variable or the settings file. */
export class HomeSourceError extends Error {}

const PROFILE_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u

/** The characters of a WSL distribution name the app passes to `wsl.exe -d`: no quote, space, shell character or option form. */
const DISTRO_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u

/**
 * Whether a distribution name can be passed to `wsl.exe -d` safely: letters, digits, dot, underscore and hyphen, at most
 * 64 characters, starting with a letter or a digit. The app also requires an exact match with a name `wsl.exe -l -q` lists
 * before it runs anything in the distribution.
 * @param name - Distribution name.
 * @returns true when the name is usable.
 */
export function isUsableDistroName(name: string): boolean {
  return DISTRO_NAME.test(name)
}

/**
 * Check a WSL home source's fields.
 * @param distro - Distribution name.
 * @param profile - Delorun profile name.
 * @returns the validated source.
 * @throws {HomeSourceError} when either field is unusable.
 */
function wslSource(distro: string, profile: string): HomeSource {
  if (!isUsableDistroName(distro)) throw new HomeSourceError('The WSL distribution name is not usable.')
  if (!PROFILE_NAME.test(profile)) throw new HomeSourceError('The Delorun profile name is not usable.')
  return { kind: 'wsl', distro, profile }
}

/**
 * Read the environment variable's value.
 * @param value - `bundled`, `wsl:<distribution>` or `wsl:<distribution>:<profile>`; empty means the variable is not set.
 * @returns the source, or `undefined` when the variable is not set.
 * @throws {HomeSourceError} when the value is written wrongly.
 */
export function parseHomeSource(value: string | undefined): HomeSource | undefined {
  if (value === undefined || value === '') return undefined
  if (value === 'bundled') return { kind: 'bundled' }
  const parts = value.split(':')
  if (parts[0] !== 'wsl' || parts.length < 2 || parts.length > 3) {
    throw new HomeSourceError(`${HOME_SOURCE_ENV} must be "bundled" or "wsl:<distribution>[:<profile>]".`)
  }
  return wslSource(parts[1] as string, parts[2] ?? DEFAULT_HOME_PROFILE)
}

const settingSchema = z.union([
  z.object({ kind: z.literal('bundled') }),
  z.object({ kind: z.literal('wsl'), distro: z.string(), profile: z.string().optional() }),
])

/**
 * Read the preview setting `homeSource` from the shell's settings file (`{ "homeSource": { "kind": "wsl", "distro": "Ubuntu" } }`).
 * A missing file or field selects nothing; a file that cannot be read is not guessed at.
 * @param userData - Electron userData folder.
 * @returns the source, or `undefined` when none is set.
 * @throws {HomeSourceError} when the field is present but written wrongly.
 */
export async function readHomeSourceSetting(userData: string): Promise<HomeSource | undefined> {
  const read = await new DesktopSettingsFile(userData).read()
  if (read.kind !== 'ready') return undefined
  const raw: unknown = read.document.homeSource
  if (raw === undefined) return undefined
  const parsed = settingSchema.safeParse(raw)
  if (!parsed.success) throw new HomeSourceError('The homeSource setting is not written as { "kind": "bundled" } or { "kind": "wsl", "distro": "…" }.')
  return parsed.data.kind === 'bundled' ? { kind: 'bundled' } : wslSource(parsed.data.distro, parsed.data.profile ?? DEFAULT_HOME_PROFILE)
}

/**
 * Choose the home: the environment variable first, then the setting, then upstream's bundled Host.
 * @param env - Process environment.
 * @param userData - Electron userData folder.
 * @returns the chosen source.
 * @throws {HomeSourceError} when the variable or the setting is written wrongly.
 */
export async function resolveHomeSource(env: NodeJS.ProcessEnv, userData: string): Promise<HomeSource> {
  return parseHomeSource(env[HOME_SOURCE_ENV]) ?? await readHomeSourceSetting(userData) ?? { kind: 'bundled' }
}
