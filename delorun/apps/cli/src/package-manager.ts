/**
 * The pnpm that upstream's package operations run: `delorun plugin`, the profile operations of setup, and the plugin
 * manager of the home process. A runtime closure carries pinned pnpm at `<runtime>/pnpm`, beside its Node at
 * `<runtime>/node`, so an installed Delorun runs that pnpm with its own Node and never depends on a pnpm on the person's
 * `PATH`. A source checkout carries no closure, so its operations run the `pnpm` on `PATH`, as `dsh plugin` does.
 *
 * @module @delorun/cli/package-manager
 */
import { existsSync, realpathSync } from 'node:fs'
import { delimiter, dirname, join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ProfilePnpmInvocation } from '@deepseek-ai/dsh-app-boot'
import { launchFiles } from '@delorun/runtime-store'
import { CliError, EXIT } from './exit.ts'

/** The closure-relative path of pnpm's entry file, inside the `pnpm` package the release build stages. */
export const CLOSURE_PNPM_ENTRY = 'pnpm/bin/pnpm.cjs'

/** Where the running `delorun` comes from, as {@link packageManagerFor} reads it. */
export interface PackageManagerSource {
  /** The `delorun` entry file this process loaded. */
  readonly entry: string
  /** The Node executable running this process: the closure's own under launch protocol 1. */
  readonly execPath: string
  /** The inherited `PATH`. */
  readonly path: string | undefined
}

/**
 * The runtime closure an entry file belongs to.
 * @param entry - the `delorun` entry file.
 * @returns the closure's root, or `undefined` when the file does not lie at launch protocol 1's entry path of one.
 */
export function closureRootOf(entry: string): string | undefined {
  // The entry path is the same on every platform; only the Node executable's differs.
  const suffix = launchFiles('linux-x64').entry.split('/').join(sep)
  return entry.endsWith(`${sep}${suffix}`) ? entry.slice(0, -suffix.length - 1) : undefined
}

/**
 * The pnpm invocation for upstream's package operations.
 * @param source - the running entry file, Node executable and `PATH`.
 * @returns the closure's pnpm run by this Node, with this Node's directory first on `PATH` for the scripts pnpm
 * starts; `undefined` outside a closure, where upstream runs `pnpm` from `PATH`.
 * @throws {CliError} `EXIT.failed` when the closure lacks its pnpm.
 */
export function packageManagerFor(source: PackageManagerSource): ProfilePnpmInvocation | undefined {
  const root = closureRootOf(source.entry)
  if (root === undefined) return undefined
  const pnpm = join(root, ...CLOSURE_PNPM_ENTRY.split('/'))
  if (!existsSync(pnpm)) throw new CliError(EXIT.failed, `delorun: this installation of Delorun lacks its pnpm (${pnpm}), which plugin operations run; reinstall Delorun`)
  return {
    command: source.execPath,
    args: [pnpm],
    env: { PATH: source.path === undefined || source.path === '' ? dirname(source.execPath) : `${dirname(source.execPath)}${delimiter}${source.path}` },
  }
}

/**
 * Whether this process runs from a runtime closure.
 * @returns true when this package's entry file lies at launch protocol 1's entry path of a closure.
 */
export function runsFromClosure(): boolean {
  return closureRootOf(thisEntry()) !== undefined
}

/**
 * The directory that holds this Delorun's own packages: `<runtime>/app` when `delorun` runs from a runtime closure, the
 * source checkout's root otherwise. A Delorun package that resolves outside it is not this installation's.
 * @returns the directory, real path.
 */
export function delorunPackagesRoot(): string {
  const root = closureRootOf(thisEntry())
  return realpathSync(root === undefined ? fileURLToPath(new URL('../../../../', import.meta.url)) : join(root, 'app'))
}

/** @returns the `delorun` entry file of this package. */
function thisEntry(): string {
  return fileURLToPath(new URL('./bin.js', import.meta.url))
}

/**
 * The pnpm invocation for this process.
 * @returns {@link packageManagerFor} of this package's entry file, `process.execPath` and `PATH`.
 * @throws {CliError} `EXIT.failed` when the closure lacks its pnpm.
 */
export function shippedPackageManager(): ProfilePnpmInvocation | undefined {
  return packageManagerFor({ entry: thisEntry(), execPath: process.execPath, path: process.env.PATH })
}
