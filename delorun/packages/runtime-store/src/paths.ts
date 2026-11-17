/**
 * The names under `runtimes/` (contract C1, "The runtime store"): version directories, their release files, the
 * pointer files and their temporary siblings, and the staging directory outside the store.
 *
 * @module @delorun/runtime-store/paths
 */
import { join } from 'node:path'
import { brandString } from '@deepseek-ai/dsh-brand'
import {
  DELORUN_HOME_ENTRIES,
  RUNTIME_VERSION_MAX_LENGTH,
  RUNTIME_VERSION_PATTERN,
  STORE_ENTRIES,
  type RuntimeVersion,
} from '@delorun/contract-home-layout'
import type { RuntimePlatform } from '@delorun/contract-release-manifest'

const VERSION = new RegExp(RUNTIME_VERSION_PATTERN, 'u')

/**
 * A runtime version name, when the text is one: C1's pattern, at most 64 characters.
 * @param text - the text.
 * @returns the version, or `undefined`.
 */
export function parseRuntimeVersion(text: string): RuntimeVersion | undefined {
  return text.length <= RUNTIME_VERSION_MAX_LENGTH && VERSION.test(text) ? brandString<RuntimeVersion>(text) : undefined
}

/** The two pointer files. */
export type PointerName = typeof STORE_ENTRIES.current | typeof STORE_ENTRIES.previous

/** A pointer's temporary sibling: `<pointer>.tmp-<16 hex>`. */
export const POINTER_TEMP = /^(current|previous)\.tmp-[0-9a-f]{16}$/u

/** The directory of the installations' identity records, under the home's `trust/`. */
const IDENTITY_RECORDS = 'runtime-files'

/** An identity record's name, with the version it names: `delorun-<version>-<platform>.json` or its temporary sibling. */
const IDENTITY_RECORD = /^delorun-(.+?)-(?:linux-x64|linux-arm64|darwin-x64|darwin-arm64|win32-x64)\.json(?:\.tmp-[0-9a-f]{16})?$/u

/**
 * The version an identity record, or its temporary sibling, belongs to.
 * @param name - an entry name under `trust/runtime-files/`.
 * @returns the version, or `undefined` when the name is not a record's.
 */
export function identityRecordVersion(name: string): RuntimeVersion | undefined {
  const match = IDENTITY_RECORD.exec(name)
  return match === null ? undefined : parseRuntimeVersion(match[1]!)
}

/** The release files kept beside an installation, with the version each names. */
const RELEASE_FILE = /^delorun-(.+?)(?:\.manifest\.json|\.manifest\.log\.json|\.packs\.json|\.packs\.log\.json|-(?:linux-x64|linux-arm64|darwin-x64|darwin-arm64|win32-x64)\.files\.json)$/u

/**
 * The version a release file beside an installation belongs to.
 * @param name - an entry name under `runtimes/`.
 * @returns the version, or `undefined` when the name is not a release file.
 */
export function releaseFileVersion(name: string): RuntimeVersion | undefined {
  const match = RELEASE_FILE.exec(name)
  return match === null ? undefined : parseRuntimeVersion(match[1]!)
}

/** The paths of one home's runtime store. */
export class StorePaths {
  /** `<home>/runtimes`. */
  readonly root: string
  /** `<home>/staging`, outside the store on the same filesystem. */
  readonly staging: string
  /** `runtimes/store.json`. */
  readonly layout: string
  /** `runtimes/store.lock`. */
  readonly lock: string
  /** `<home>/packs`, the unpacked plugin packs by release. */
  readonly packs: string
  /** `trust/runtime-files`, the installations' identity records, outside every read exemption of confined commands. */
  readonly identityRecords: string

  /** The resolved Delorun home. */
  readonly home: string
  /** The platform whose file list each installation keeps. */
  readonly platform: RuntimePlatform

  /**
   * @param home - the resolved Delorun home.
   * @param platform - the platform whose file list each installation keeps.
   */
  constructor(home: string, platform: RuntimePlatform) {
    this.home = home
    this.platform = platform
    this.root = join(home, DELORUN_HOME_ENTRIES.runtimes)
    this.staging = join(home, DELORUN_HOME_ENTRIES.staging)
    this.packs = join(home, DELORUN_HOME_ENTRIES.packs)
    this.layout = join(this.root, STORE_ENTRIES.layout)
    this.lock = join(this.root, STORE_ENTRIES.lock)
    this.identityRecords = join(home, DELORUN_HOME_ENTRIES.trust, IDENTITY_RECORDS)
  }

  /**
   * A pack's directory for one release.
   * @param version - the release version.
   * @param name - the pack's package name.
   * @returns `packs/<version>/<name>`, with `/` in a scoped name written `__`.
   */
  pack(version: RuntimeVersion, name: string): string {
    return join(this.packs, version, name.replaceAll('/', '__'))
  }

  /**
   * The `app/node_modules` of an installation: what provides a pack's peers.
   * @param version - the installed version.
   * @returns `runtimes/<version>/app/node_modules`.
   */
  runtimeNodeModules(version: RuntimeVersion): string {
    return join(this.root, version, 'app', 'node_modules')
  }

  /**
   * An installed pack's identity record, outside the pack so a confined command that can write the pack cannot
   * rewrite what the pack is checked against.
   * @param version - the release version.
   * @param name - the pack's package name.
   * @returns `trust/runtime-files/packs/<version>/<name>.json`, with `/` in a scoped name written `__`.
   */
  packRecord(version: RuntimeVersion, name: string): string {
    return join(this.identityRecords, 'packs', version, `${name.replaceAll('/', '__')}.json`)
  }

  /**
   * A pointer file.
   * @param name - `current` or `previous`.
   * @returns its path.
   */
  pointer(name: PointerName): string {
    return join(this.root, name)
  }

  /**
   * An installation's directory.
   * @param version - the version.
   * @returns `runtimes/<version>`.
   */
  version(version: RuntimeVersion): string {
    return join(this.root, version)
  }

  /**
   * The release files kept beside an installation.
   * @param version - the version.
   * @returns the manifest, this platform's file list and the release-log bundle, and the packs file and its bundle.
   */
  releaseFiles(version: RuntimeVersion): { readonly manifest: string, readonly files: string, readonly bundle: string, readonly packs: string, readonly packsBundle: string } {
    return {
      packs: join(this.root, `delorun-${version}.packs.json`),
      packsBundle: join(this.root, `delorun-${version}.packs.log.json`),
      manifest: join(this.root, `delorun-${version}.manifest.json`),
      files: join(this.root, `delorun-${version}-${this.platform}.files.json`),
      bundle: join(this.root, `delorun-${version}.manifest.log.json`),
    }
  }

  /**
   * An installation's identity record.
   * @param version - the version.
   * @returns `trust/runtime-files/delorun-<version>-<platform>.json`.
   */
  identityRecord(version: RuntimeVersion): string {
    return join(this.identityRecords, `delorun-${version}-${this.platform}.json`)
  }
}
