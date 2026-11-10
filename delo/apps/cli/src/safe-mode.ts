/**
 * The start half of safe mode: when `delorun recover safe-mode` left its marker under the home's run directory, the
 * home process boots the profile without its third-party bundles and without the person's rows for them. The profile's
 * files are not read differently and not written at all — the filtered layers and one overlay patch are values this
 * start passes to upstream's profile runner — so the next ordinary start loads the whole profile again.
 *
 * @module @delo/cli/safe-mode
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DELO_PROFILE_BUNDLES } from '@delo/bundle-local/profile'
import type { ResolvedProfileRuntime } from '@deepseek-ai/dsh/profile-boot'
import { readInventory, readSafeMode, startInSafeMode, type SafeModeMarker } from '@delo/profile-safety'

/** The overlay filename, inside the profile's run directory. */
export const SAFE_MODE_PATCH_FILENAME = 'safe-mode.patch.yml'

/** What a safe-mode start boots instead of the whole profile. */
export interface SafeModeStart {
  /** The marker that asked for this start. */
  readonly marker: SafeModeMarker
  /** The profile with the third-party layers left out. */
  readonly resolvedProfile: ResolvedProfileRuntime
  /** The overlay files this start adds after the profile's own patch; empty when no row is left out. */
  readonly patchFiles: readonly string[]
  /** The bundles left out. */
  readonly skipped: readonly string[]
  /** The rows the overlay disables: the person's rows for the plugins of the bundles left out. */
  readonly skippedRows: readonly string[]
}

/**
 * The profile a safe-mode start boots.
 * @param options - the home, the profile's name and the profile upstream's loader returned.
 * @returns the filtered profile and its overlay, or undefined when the home is not in safe mode.
 * @throws {ProfileSafetyError} `SAFE_MODE_UNREADABLE` when the marker exists but is not one Delo wrote.
 */
export function safeModeStart(options: {
  readonly home: string
  readonly profile: string
  readonly resolvedProfile: ResolvedProfileRuntime
}): SafeModeStart | undefined {
  const marker = readSafeMode(options.home, options.profile)
  if (marker === undefined) return undefined
  const inventory = readInventory({ profileDir: join(options.home, 'profiles', options.profile), homeDir: options.home })
  const plan = startInSafeMode({ inventory, installationBundles: DELO_PROFILE_BUNDLES })
  const layers = options.resolvedProfile.profile.layers.filter(layer => plan.bundles.includes(layer.packageName))
  // A start with no row to disable leaves no overlay behind from an earlier one.
  if (plan.skippedRows.length === 0) rmSync(overlayPath(options.home, options.profile), { force: true })
  const patchFiles = plan.skippedRows.length === 0 ? [] : [writeOverlay(options.home, options.profile, plan.skippedRows)]
  return {
    marker,
    resolvedProfile: { ...options.resolvedProfile, profile: { ...options.resolvedProfile.profile, layers } },
    patchFiles,
    skipped: plan.skipped,
    skippedRows: plan.skippedRows,
  }
}

/**
 * The overlay's path, whether or not this start writes it.
 * @param home - the Delo home.
 * @param profile - the profile's name.
 * @returns the path under the profile's run directory.
 */
export function overlayPath(home: string, profile: string): string {
  return join(home, 'run', profile, SAFE_MODE_PATCH_FILENAME)
}

/**
 * Remove a safe-mode overlay a start left behind, which ending safe mode does.
 * @param home - the Delo home.
 * @param profile - the profile's name.
 */
export function removeSafeModeOverlay(home: string, profile: string): void {
  rmSync(overlayPath(home, profile), { force: true })
}

/**
 * Write the overlay that disables the person's rows for third-party plugins.
 * @param home - the Delo home.
 * @param profile - the profile's name.
 * @param skippedRows - the row ids to disable.
 * @returns the overlay's absolute path, under the profile's run directory.
 */
function writeOverlay(home: string, profile: string, skippedRows: readonly string[]): string {
  const path = overlayPath(home, profile)
  mkdirSync(join(home, 'run', profile), { recursive: true, mode: 0o700 })
  // A patch list is YAML; a JSON flow sequence is one, so the ids need no quoting rules of their own.
  writeFileSync(path, JSON.stringify(skippedRows.map(id => ({ id, disabled: true })), undefined, 2) + '\n', { mode: 0o600 })
  return path
}

/**
 * The line a safe-mode start prints before it boots.
 * @param start - what the start left out.
 * @returns the line, in the person's words.
 */
export function safeModeNotice(start: SafeModeStart): string {
  const left = start.skipped.length === 0 ? 'no third-party bundle' : start.skipped.join(', ')
  return `Delo starts in safe mode: it leaves out ${left}. Your rows and settings are still in the profile; run \`delorun recover exit-safe-mode\` to load everything again.\n`
}
