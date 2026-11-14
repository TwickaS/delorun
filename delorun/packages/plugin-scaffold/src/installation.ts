/**
 * What a scaffold reads from the running installation: whether a package name is one the installation ships,
 * and the version of `@deepseek-ai/cordis` it runs. A profile resolves a bundle from the installation before the
 * profile (upstream's `resolveBundleDir`), and a plugin's imports of a package the installation's runtime resolution
 * carries reach the installation's copy, so a plugin that takes a shipped package's name is never the code that loads.
 *
 * @module @delorun/plugin-scaffold/installation
 */
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { createRuntimeResolution } from '@deepseek-ai/dsh-app-boot'
import semver from 'semver'
import { ScaffoldError } from './error.ts'

/** The running installation, named by the `package.json` of its `@deepseek-ai/dsh` package, as upstream's launcher names it. */
export interface Installation {
  /** The absolute path of the installation's `@deepseek-ai/dsh` `package.json`, upstream's `INSTALL_ANCHOR`. */
  readonly anchor: string
}

/**
 * The installation this `delorun` runs on: the `@deepseek-ai/dsh` it resolves, whose `package.json` is the anchor
 * upstream's profile launcher resolves bundles and plugins from.
 * @returns the installation.
 */
export function runningInstallation(): Installation {
  return { anchor: createRequire(import.meta.url).resolve('@deepseek-ai/dsh/package.json') }
}

/** The scopes of the packages Delorun ships, upstream's and Delorun's own, which a person's plugin may not take. */
export const RESERVED_SCOPES = ['@deepseek-ai/', '@delorun/'] as const

/**
 * Whether Node's lookup from an anchor finds a package, the first lookup of upstream's `resolveBundleDir`.
 * @param anchor - a file whose directory starts the lookup.
 * @param name - the package name.
 * @returns true when a lookup path holds the package's `package.json`.
 */
export function resolvesFrom(anchor: string, name: string): boolean {
  return packageDirFrom(anchor, name) !== undefined
}

/**
 * The directory Node's lookup from the anchor finds a package in, the first lookup of upstream's `resolveBundleDir`.
 * @param anchor - a file whose directory starts the lookup.
 * @param name - the package name.
 * @returns the package's directory, or `undefined` when no lookup path holds its `package.json`.
 */
function packageDirFrom(anchor: string, name: string): string | undefined {
  // resolve.paths returns null only for a builtin module name, which the caller has refused.
  for (const searchPath of createRequire(anchor).resolve.paths(name) ?? []) {
    const candidate = join(searchPath, name)
    if (existsSync(join(candidate, 'package.json'))) return candidate
  }
  return undefined
}

/**
 * Whether the installation ships a package of this name: Node's lookup from the installation anchor finds it, or the
 * installation's runtime resolution, the packages every profile receives from the installation, carries it.
 * @param installation - the installation.
 * @param name - a valid package name.
 * @returns true when a plugin of this name would be shadowed by the installation's package.
 */
export async function installationShips(installation: Installation, name: string): Promise<boolean> {
  if (packageDirFrom(installation.anchor, name) !== undefined) return true
  const resolution = await createRuntimeResolution({ installAnchor: installation.anchor })
  return resolution.entries.some(entry => entry.name === name)
}

/**
 * The version of `@deepseek-ai/cordis` the installation runs, which a plugin declares as its peer.
 * @param installation - the installation.
 * @returns the version.
 * @throws {ScaffoldError} of kind `failed` when the installation carries no readable `@deepseek-ai/cordis`.
 */
export function installedCordisVersion(installation: Installation): string {
  const directory = packageDirFrom(installation.anchor, '@deepseek-ai/cordis')
  let version: unknown
  try {
    if (directory === undefined) throw new Error('it is not installed')
    version = (JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')) as { readonly version?: unknown }).version
  } catch (error) {
    throw new ScaffoldError('failed', `the installation's @deepseek-ai/cordis cannot be read (${error instanceof Error ? error.message : String(error)}); reinstall Delorun`)
  }
  if (typeof version !== 'string' || semver.valid(version) === null) {
    throw new ScaffoldError('failed', `the installation's @deepseek-ai/cordis declares ${JSON.stringify(version)}, which is not a semantic version; reinstall Delorun`)
  }
  return version
}
