/**
 * Launcher and store compatibility (contract C1): the store's layout number from `store.json`, the runtime's launch
 * protocol number, and launch protocol 1's entry file, arguments and environment. A launcher runs `current` only when
 * it supports both numbers, and otherwise stops with `RUNTIME_INCOMPATIBLE`, writing nothing.
 *
 * Launch protocol 1 runs the runtime's own Node executable (`node/bin/node`, or `node/node.exe` on Windows) with the
 * `delorun` entry file `app/node_modules/@delo/cli/src/bin.js` and the launcher's arguments, and sets `DSH_HOME` and
 * `DELO_HOME` to the home and `DELO_PROFILE` to the profile; the closure layout is `@delo/release`'s
 * (`delo/apps/release/README.md`, "Runtime closures").
 *
 * @module @delo/runtime-store/launch
 */
import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { join } from 'node:path'
import { DELO_HOME_ENV, DELO_PROFILE_ENV, DSH_HOME_ENV, LAUNCH_PROTOCOL, STORE_LAYOUT, type RuntimeVersion } from '@delo/contract-home-layout'
import { type ReleaseManifest, type RuntimeFileList, type RuntimePlatform } from '@delo/contract-release-manifest'
import { RuntimeStoreError, type RuntimeRemedy } from './errors.ts'
import type { StorePaths } from './paths.ts'

/** The largest `store.json` read. */
const LAYOUT_RECORD_MAX_BYTES = 4096

/** What a launcher supports. */
export interface LauncherSupport {
  /** The store layout numbers it reads. */
  readonly storeLayouts: readonly number[]
  /** The launch protocol numbers it can start. */
  readonly launchProtocols: readonly number[]
}

/** What this package's launcher code supports: C1's store layout 1 and launch protocol 1. */
export const SUPPORTED: LauncherSupport = { storeLayouts: [STORE_LAYOUT], launchProtocols: [LAUNCH_PROTOCOL] }

/** A process to start from an installed runtime. */
export interface LaunchCommand {
  /** The runtime's Node executable. */
  readonly command: string
  /** The entry file, then the launcher's arguments. */
  readonly args: readonly string[]
  /** The variables the launch protocol sets; the caller adds them to the inherited environment, replacing any inherited value. */
  readonly env: Readonly<Record<string, string>>
}

/**
 * The paths of launch protocol 1 inside an installation, relative and `/`-separated as the file list names them.
 * @param platform - the runtime's platform.
 * @returns the Node executable and the entry file.
 */
export function launchFiles(platform: RuntimePlatform): { readonly node: string, readonly entry: string } {
  return { node: platform === 'win32-x64' ? 'node/node.exe' : 'node/bin/node', entry: 'app/node_modules/@delo/cli/src/bin.js' }
}

/**
 * The launch protocol number of a verified runtime. C2's manifest schema `delo.release-manifest/1` has no launch
 * protocol field, so every runtime such a manifest describes uses launch protocol 1; a manifest that carries the
 * number needs a new schema major version, which the verifier refuses until this reads it.
 * @param _manifest - the verified manifest.
 * @returns the launch protocol number.
 */
export function launchProtocolOf(_manifest: ReleaseManifest): number {
  return LAUNCH_PROTOCOL
}

/**
 * The remedy for a number the launcher does not support: an update of the runtime when the runtime is older than
 * everything the launcher supports, otherwise an update of the launcher.
 * @param found - the store's or runtime's number.
 * @param supported - the launcher's numbers.
 * @returns the remedy.
 */
function remedyFor(found: number, supported: readonly number[]): RuntimeRemedy {
  return supported.every(value => found < value) ? 'update' : 'launcher-update'
}

/**
 * Read the store's layout number.
 * @param paths - the store's paths.
 * @returns the layout number.
 * @throws {RuntimeStoreError} `NO_ACTIVE_RUNTIME` when `store.json` is missing or not a layout record.
 */
export async function readStoreLayout(paths: StorePaths): Promise<number> {
  let text: string
  try {
    const handle = await open(paths.layout, constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW | constants.O_NONBLOCK))
    try {
      const stats = await handle.stat()
      if (!stats.isFile() || stats.size > LAYOUT_RECORD_MAX_BYTES) throw new Error('not a regular file within 4 KiB')
      text = await handle.readFile('utf8')
    } finally {
      await handle.close()
    }
  } catch (error) {
    throw new RuntimeStoreError('NO_ACTIVE_RUNTIME', paths.layout, `${paths.layout} cannot be read (${(error as Error).message}), so the store holds no usable runtime`, ['reinstall'], { cause: error })
  }
  let record: unknown
  try {
    record = JSON.parse(text)
  } catch {
    // Not JSON; refused below.
    record = undefined
  }
  const layout = typeof record === 'object' && record !== null ? (record as { readonly layout?: unknown }).layout : undefined
  if (typeof layout !== 'number' || !Number.isSafeInteger(layout) || layout < 1) {
    throw new RuntimeStoreError('NO_ACTIVE_RUNTIME', paths.layout, `${paths.layout} is not a store layout record`, ['reinstall'])
  }
  return layout
}

/**
 * Refuse a store layout the launcher does not read.
 * @param paths - the store's paths.
 * @param layout - the store's layout number.
 * @param launcher - what the launcher supports.
 * @throws {RuntimeStoreError} `RUNTIME_INCOMPATIBLE` naming both numbers.
 */
export function requireLayout(paths: StorePaths, layout: number, launcher: LauncherSupport): void {
  if (launcher.storeLayouts.includes(layout)) return
  throw new RuntimeStoreError('RUNTIME_INCOMPATIBLE', paths.layout, `the runtime store has layout ${String(layout)}, and this launcher reads layouts ${launcher.storeLayouts.join(', ')}`, [remedyFor(layout, launcher.storeLayouts)])
}

/**
 * Refuse a runtime whose launch protocol the launcher does not start, or that lacks the protocol's files.
 * @param paths - the store's paths.
 * @param version - the runtime.
 * @param manifest - its verified manifest.
 * @param files - its verified file list.
 * @param launcher - what the launcher supports.
 * @throws {RuntimeStoreError} `RUNTIME_INCOMPATIBLE` naming both numbers, or the missing file.
 */
export function requireProtocol(paths: StorePaths, version: RuntimeVersion, manifest: ReleaseManifest, files: RuntimeFileList, launcher: LauncherSupport): void {
  const protocol = launchProtocolOf(manifest)
  if (!launcher.launchProtocols.includes(protocol)) {
    throw new RuntimeStoreError('RUNTIME_INCOMPATIBLE', paths.version(version), `runtime ${version} uses launch protocol ${String(protocol)}, and this launcher starts protocols ${launcher.launchProtocols.join(', ')}`, [remedyFor(protocol, launcher.launchProtocols)])
  }
  const listed = new Set(files.files.map(file => file.path))
  for (const path of Object.values(launchFiles(paths.platform))) {
    if (!listed.has(path)) throw new RuntimeStoreError('RUNTIME_INCOMPATIBLE', paths.version(version), `runtime ${version} has no ${path}, which launch protocol ${String(protocol)} starts`, ['reinstall'])
  }
}

/**
 * The command that starts an installed runtime by launch protocol 1. It checks nothing; the start check
 * (`RuntimeStore.prepareLaunch` or `checkRuntime`) runs before it.
 * @param paths - the store's paths.
 * @param version - the installed version.
 * @param profile - the CLI profile.
 * @param args - the launcher's arguments for `delorun`.
 * @returns the command.
 */
export function launchCommand(paths: StorePaths, version: RuntimeVersion, profile: string, args: readonly string[]): LaunchCommand {
  const files = launchFiles(paths.platform)
  const directory = paths.version(version)
  return {
    command: join(directory, ...files.node.split('/')),
    args: [join(directory, ...files.entry.split('/')), ...args],
    env: { [DSH_HOME_ENV]: paths.home, [DELO_HOME_ENV]: paths.home, [DELO_PROFILE_ENV]: profile },
  }
}
