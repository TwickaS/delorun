/**
 * The refusal to start a CLI profile whose composition skipped a Delo bundle.
 * Upstream's profile loader skips a bundle it cannot resolve, read or accept
 * and starts with the remaining layers, so a Delo profile missing
 * `@delo/bundle-local` would run with upstream's defaults, which turn
 * DeepSeek session-log upload back on. `delorun` therefore stops instead.
 * A Delo bundle is any bundle in the `@delo/` scope; a skipped upstream bundle
 * is reported as upstream reports it and does not stop the start.
 *
 * @module @delo/cli/delo-bundles
 */
import type { Profile } from '@deepseek-ai/dsh-app-boot'
import { CliError, EXIT } from './exit.ts'

/** The npm scope of Delo's bundles. */
export const DELO_BUNDLE_SCOPE = '@delo/'

/**
 * The directory of a Delo bundle that this installation of `delorun` carries,
 * which a source checkout can link into the profile.
 * @param packageName - the bundle's package name.
 * @returns the package directory, or `undefined` when `delorun` cannot resolve it.
 */
function carriedBundleDirectory(packageName: string): string | undefined {
  try {
    return new URL('.', import.meta.resolve(`${packageName}/package.json`)).pathname
  } catch {
    // ERR_MODULE_NOT_FOUND or ERR_PACKAGE_PATH_NOT_EXPORTED: this installation does not carry it, so no link is offered.
    return undefined
  }
}

/**
 * Refuse a loaded profile when it skipped a Delo bundle.
 * @param profile - the profile as upstream's loader returned it.
 * @throws {CliError} with the failure code, naming each skipped Delo bundle, its reason and the command that fixes it.
 */
export function refuseSkippedDeloBundles(profile: Pick<Profile, 'name' | 'skippedBundles'>): void {
  const skipped = profile.skippedBundles.filter(bundle => bundle.packageName.startsWith(DELO_BUNDLE_SCOPE))
  if (skipped.length === 0) return
  const lines = skipped.map(({ packageName, reason }) => {
    const directory = carriedBundleDirectory(packageName)
    const fix = directory === undefined
      ? `reinstall Delo, or run: delorun plugin --profile ${profile.name} install`
      : `run: delorun plugin --profile ${profile.name} add link:${directory}`
    return `  ${packageName}: ${reason}\n  To fix it, ${fix}`
  })
  throw new CliError(EXIT.failed, [
    `delorun: the CLI profile ${profile.name} could not load Delo's ${skipped.length === 1 ? 'bundle' : 'bundles'}, so Delo did not start:`,
    ...lines,
    'Without them the profile would start with DeepSeek Harness\'s own defaults, which upload session logs to DeepSeek.',
  ].join('\n'))
}
