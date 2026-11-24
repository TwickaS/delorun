/** Current-profile plugin and bundle management over shared dsh plugin operations. */
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { pathToFileURL } from 'node:url'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { Context } from '@deepseek-ai/cordis'
import type { EntryOptions } from '@deepseek-ai/cordis-plugin-loader'
import type { PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import z from '@deepseek-ai/schemastery'
import semver from 'semver'
import { TypertRemoteService, Remote, RemoteError, remoteErrorOf } from '@deepseek-ai/dsh-typert-protocol'
import { detailImageResponse, NPM_FILE_SOURCES } from '@deepseek-ai/dsh-plugin-detail'
import type { NpmFileSource } from '@deepseek-ai/dsh-plugin-detail/types'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import type {} from '@deepseek-ai/dsh-client-connection'
import { readBundleDocument, readBundleImage, type BundleDetailOptions } from './bundle-detail.ts'
import { pluginEntryId, readPluginInventory } from '@deepseek-ai/dsh-host-plugin-inventory'
import {
  readPluginMeta, readProfileManifest, resolveBundleDir, loadOverlayPatches, composeEntries,
  readProfilePatches, bundlePatchPaths, loadProfileDirectory,
  evaluatePluginCompatibility, readProfileCompatibility, readProfileVersionExemptions,
  setProfileVersionExemption, validatePluginVersionExemption,
  getDshRuntimeVersion, ResolutionRestartRequired,
  assertBundlePlatform, UnsupportedBundlePlatformError,
} from '@deepseek-ai/dsh-app-boot'
import { OPTIONAL_BUNDLES, OFFICIAL_ON_DEMAND_CATALOG, PROTECTED_PLUGINS } from '@deepseek-ai/dsh-official-bundles'
import type {} from '@deepseek-ai/dsh-hmr'
import type {} from '@deepseek-ai/dsh-config-editor'
import type { ProfileContext, ProfileLayer, ProfileManifest } from '@deepseek-ai/dsh-app-boot'
import { bundleManifest, readProfileRegistry, registryArguments, runProfilePnpm, saveManifest, viewProfilePackage, type ProfileBaseline } from './operations.ts'
import { classifyInstallFailure } from './install-failure.ts'
import { officialBundleInstallTarget } from './official-install-target.ts'
import { approvedFromTarget } from './approved-source.ts'
import { dependencySpec, InvalidInstallSpecError, parseInstallSpec, pinnedGitOrigin, type ParsedInstallSpec } from './install-spec.ts'
import { attributeFailure, normalizeRegistry, NPMMIRROR_REGISTRY, registryPlan } from './registry.ts'
import { flatten, writePluginEnabled } from './patch.ts'
import { parsedForRegistry, specPackageName } from './package-name.ts'
import { incompatiblePlugin, ManagementFailure } from './failure.ts'
import { approveBuilds, recordPendingBuilds } from './build-approval.ts'
import { checkGitConnection, checkGithubConnection, type GithubConnectionFailure } from './github-connection.ts'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import { acceptAudit, acceptedAudits } from './audit.ts'
import { PROFILE_FILES, ProfileHistory, VersionRefusedError, writeProfileVersion } from './history.ts'
import { broughtBack, profileVersionChanges } from './version-changes.ts'
import { chooseGitTransport } from './git-transport.ts'
import { newerVersions, VERSION_FIELDS, VERSION_LIST_FIELDS, versionFacts } from './versions.ts'
import type {
  BundleDetail, BundleInfo, BundleRowInfo, ChangeResult, InspectOptions, InstallBundleOptions, ListVersionsOptions, ManagementError,
  PackageResult, PluginChange, PluginEntryId, PluginInfo, PluginInstallCancellation, PluginInstallProgress, PluginInstallRequestId,
  PluginRegistries, PluginSpecInspection, PluginUpdateResult, PluginUpdateStep, PluginVersion, PluginVersionList, Registry,
  RegistryAttempt, UpdateBundleOptions, PluginAudit, PluginAuditResult, ProfileChangedBy, ProfileHistoryInfo, ProfileVersion,
  PackFolderCheck, ProfileVersionChanges, ProfileVersionId, ProfileVersionPreview,
  PluginOperation, PluginOperationId, ProfileHomePatch,
} from './types.ts'
export type * from './types.ts'
export { classifyInstallFailure, type InstallFailureFacts } from './install-failure.ts'
export { InvalidInstallSpecError, parseInstallSpec, pinnedGitOrigin, type ParsedInstallSpec } from './install-spec.ts'

/** The pnpm executable, registries, and limits for diagnostics, lookups and connection checks. */
export interface Config {
  /** The pnpm executable name or path; resolved through `PATH` like the `dsh plugin` command. */
  pnpmCommand?: string
  /** Maximum retained package-operation diagnostic bytes. */
  outputBytes?: number
  /** Maximum time to wait for another process's profile package operation. */
  lockWaitMs?: number
  /** Bound on one registry lookup an inspection runs, in milliseconds. */
  inspectTimeoutMs?: number
  /** Maximum duration of the GitHub repository connection check before installation, in milliseconds. */
  githubConnectionTimeoutMs?: number
  /** Maximum duration of each HTTP(S) and SSH access probe of a self-hosted Git repository before installation, in milliseconds. */
  gitTransportTimeoutMs?: number
  /** Maximum time one captured package run may print nothing before the manager terminates it, in milliseconds. */
  idleTimeoutMs?: number
  /** The registry lookups and installations ask first, as an http(s) URL; absent, the one pnpm's own configuration names. */
  registry?: string
  /**
   * Registries asked in turn, as http(s) URLs, while the one before is unreachable or holds no copy of the package.
   * A registry outside this set and `registry` is asked alone, and so is the one pnpm's own configuration names
   * unless that is npm's own registry or one of these.
   */
  fallbackRegistries?: string[]
  /** The git executable name or path the profile's history runs, resolved through `PATH`; without git there is no history. */
  gitCommand?: string
  /** Bound on one git run of the profile's history, in milliseconds. */
  historyTimeoutMs?: number
  /** How many of the newest versions above the installed one a version listing reads and returns. */
  versionListLimit?: number
  /** How many single-version registry lookups a version listing runs at once. */
  versionLookupConcurrency?: number
  /** Largest bundle detail document, and largest locale file read for one, in bytes. */
  detailMaxBytes?: number
  /** Largest image served beside a bundle detail document, in bytes. */
  detailImageMaxBytes?: number
  /** Deadline of one npm file CDN request for an offered bundle's detail document. */
  detailFetchTimeoutMs?: number
  /** npm file CDNs that offered bundles are read from, in order; a read's `npmFileSources` moves the CDNs it names first. */
  detailNpmFileSources?: NpmFileSource[]
  /**
   * Plugin module names the manager protects as it protects `PROTECTED_PLUGINS`, refusing with `management-required`
   * any change that would disable, reconfigure, replace or drop a row of one of them, or add one, in the composed
   * profile: a plugin toggle, a bundle selection or installation, an undo or a restore. A bundle with a row of one, or
   * a package that provides one, can be neither deselected nor removed, and no package that provides one is installed
   * or changed. These names add to `PROTECTED_PLUGINS` and cannot take any away; a refusal that names one of them
   * carries a `diagnostic` listing those names.
   */
  protectedPlugins?: string[]
  /** Entry ids whose configuration edits save no profile version, such as a plugin that writes its own progress on every step. */
  unversionedEntries?: string[]
}

/** The Fetch route serving images beside bundle detail documents. */
const DETAIL_FILE_PATH = '/api/plugin-manager/detail-file'

/** An http(s) URL, as pnpm's `--registry` takes it. */
const REGISTRY_URL = /^https?:\/\/\S+$/

/** The profile files an installation writes and a failed or cancelled one restores. */
const RESTORED_FILES = ['package.json', 'pnpm-lock.yaml'] as const

/** The lockfile, whose change means a restored version's dependency set must be installed again. */
const LOCKFILE = 'pnpm-lock.yaml'

/** The summary of a version that saves an edit made outside plugin management. */
const OUTSIDE_SUMMARY = 'Changed outside plugin management'

/** The manifest fields an inspection reads for a registry spec. */
const INSPECT_FIELDS = ['name', 'version', 'description', 'dsh'] as const

/** pnpm's colour escapes, which a JSON answer may be wrapped in. */
const ANSI_SEQUENCE = /\x1b\[[0-9;]*m/g

/** Preserve the exact observed diagnostic, including non-Error failures. */
function messageOf(error: unknown): string { return error instanceof Error ? error.message : String(error) }

/** An expected refusal keeps its code; anything else becomes an operation error carrying its exact diagnostic. */
function managementError(error: unknown): ManagementError {
  if (error instanceof UnsupportedBundlePlatformError) return { code: 'unsupported-platform' }
  if (!(error instanceof ManagementFailure)) return { code: 'operation-error', diagnostic: messageOf(error) }
  return { code: error.code, ...error.incompatible === undefined ? {} : { incompatible: error.incompatible },
    ...error.diagnostic === undefined ? {} : { diagnostic: error.diagnostic }, ...error.audit === undefined ? {} : { audit: error.audit } }
}

/** The caller stopped an installation; its files are restored before this is thrown. */
class InstallCancelledError extends Error {
  constructor() {
    super('Installation cancelled')
    this.name = 'InstallCancelledError'
  }
}

/** One installation the manager owns until its call settles. */
interface InstallControl {
  readonly abort: AbortController
  /** `applying` once pnpm has exited and the bundle is being selected and loaded, which cannot be stopped. */
  phase: 'installing' | 'applying'
  /** The active install's result, shared with clients recovering a lost response. */
  result: Promise<ChangeResult | null>
}

/** A manifest field that is a string, when the manifest carries one. */
function stringField(manifest: object, field: string): string | undefined {
  const value = (manifest as Record<string, unknown>)[field]
  return typeof value === 'string' ? value : undefined
}

/** The fields of the dsh installation's own manifest the manager reads. */
interface InstallationManifest {
  dependencies?: Record<string, string>
}

/** What a package manifest says about the package: identity, one-liner, and whether it is a bundle. */
function inspectionOf(kind: 'registry' | 'path', manifest: object, registry: Registry): Extract<PluginSpecInspection, { status: 'accepted' }> {
  const dsh = (manifest as { dsh?: unknown }).dsh
  const declared = typeof dsh === 'object' && dsh !== null ? dsh as { bundle?: unknown } : undefined
  const bundle = declared !== undefined && typeof declared.bundle === 'object' && declared.bundle !== null
  const name = stringField(manifest, 'name')
  const version = stringField(manifest, 'version')
  const description = stringField(manifest, 'description')
  return {
    status: 'accepted', kind, bundle, registry,
    ...name === undefined ? {} : { name },
    ...version === undefined ? {} : { version },
    ...description === undefined || description === '' ? {} : { description },
  }
}

function refused(problem: Extract<PluginSpecInspection, { status: 'refused' }>['problem'], reason: string): PluginSpecInspection {
  return { status: 'refused', problem, reason }
}

/**
 * An installed bundle an update can replace and its installed version: a registry copy with its parsed registry spec,
 * or a Git copy with the saved spec that installs it again and the repository directory it pins.
 */
type UpdateTarget<B> =
  | { kind: 'registry'; bundle: B; installed: string; parsed: Extract<ParsedInstallSpec, { kind: 'registry' }> }
  | { kind: 'git'; bundle: B; installed: string; source: string; origin: string }

/** What an update installs: the target spec, the registry asked first when one is named, and whether the save is exact. */
interface UpdatePlan {
  spec: string
  registry: Registry | undefined
  saveExact: boolean
}

/**
 * Why an update cannot replace a listed bundle, or what it replaces.
 * @param bundle The listed bundle, or undefined for a name the inventory does not list.
 * @param name The package name, for the refusal.
 * @returns The bundle, its installed version, and how it was installed; or the refusal's diagnostic.
 */
function updateRefusal<B extends Pick<BundleInfo, 'name' | 'installed' | 'availability' | 'official' | 'version' | 'source' | 'readOnlyReason'>>(
  bundle: B | undefined, name: string,
): UpdateTarget<B> | string {
  if (bundle === undefined || !bundle.installed || bundle.availability !== 'profile' || bundle.official || bundle.source === undefined) {
    return `${name} is not a third-party package installed in this profile`
  }
  // A management bundle cannot be removed, so it cannot be replaced either.
  if (bundle.readOnlyReason !== undefined) return `${bundle.name} carries plugin management and cannot be removed`
  const installed = bundle.version
  if (installed === undefined || semver.valid(installed) === null) return `${bundle.name} declares no semver version`
  // Only a pinned commit reinstalls the removed version when its replacement fails.
  const origin = pinnedGitOrigin(bundle.source)
  if (origin !== undefined) return { kind: 'git', bundle, installed, source: bundle.source, origin }
  const parsed = parsedForRegistry(bundle.source)
  // A protocol in the saved range, such as an `npm:` alias, names another package than the dependency.
  if (parsed.kind !== 'registry' || parsed.name !== bundle.name || parsed.range?.includes(':') === true) {
    return `${bundle.name} is installed neither from a registry under its own name nor from a Git commit`
  }
  return { kind: 'registry', bundle, installed, parsed }
}

/** What asking planned registries in turn answered: the parsed output and the registry that gave it, or the last refusal. */
type RegistryAnswer =
  | { status: 'answered'; answer: unknown; registry: Registry; attempts: RegistryAttempt[] }
  | { status: 'refused'; problem: NonNullable<RegistryAttempt['problem']>; reason: string; attempts: RegistryAttempt[] }

/**
 * Map items with at most `limit` calls in flight, stopping new calls once one answers `stop`.
 * @param items - the items, in order.
 * @param limit - the most calls in flight.
 * @param map - the call for one item.
 * @param stop - whether an answer ends the remaining calls.
 * @returns the answers of the calls that ran, in item order; items after a stop stay absent.
 */
async function mapConcurrent<T, R>(
  items: readonly T[], limit: number, map: (item: T) => Promise<R>, stop: (answer: R) => boolean,
): Promise<(R | undefined)[]> {
  const answers: (R | undefined)[] = items.map(() => undefined)
  let next = 0
  let stopped = false
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (!stopped && next < items.length) {
      const index = next++
      const answer = await map(items[index] as T)
      answers[index] = answer
      if (stop(answer)) stopped = true
    }
  }))
  return answers
}

/** The refusal `pnpm view --json` prints on stdout, `{ error: { code, message } }`, as one log line; empty for anything else. */
function printedError(printed: string): string {
  let parsed: unknown
  try { parsed = JSON.parse(printed || 'null') }
  catch { return '' /* not JSON: nothing pnpm printed as a refusal */ }
  const error = typeof parsed === 'object' && parsed !== null ? (parsed as { error?: unknown }).error : undefined
  if (typeof error !== 'object' || error === null) return ''
  const { code, message } = error as { code?: unknown; message?: unknown }
  return [code, message].filter((part): part is string => typeof part === 'string').join('  ')
}

/** What applying the saved profile reports into a change result. */
type Reload = Pick<ChangeResult, 'warnings' | 'restartReason'>

/** The bundles a profile manifest selects. */
function bundleSelection(manifest: ProfileManifest): readonly string[] {
  return manifest.dsh?.profile?.bundles ?? []
}

/** The diagnostic for a package the release publishes as a signed plugin pack and a registry or another source offers. */
/** Why a version that holds a pack from another source is not restored. */
const PACK_RESTORE = 'this version holds the plugin pack from a registry or another folder, not from its pack folder; remove the pack first, then add it again from Plugins.'

/** Why a pack is not installed into a Host an update has switched away from. */
const PACK_CHANGED = 'The files of this plugin pack are missing or differ from the release\'s signed list. Add it again from Plugins or the setup guide.'
const PACK_UPDATE_PENDING = 'Restart Delorun to finish the update before adding plugins: this Host runs the release before it.'

const PACK_ONLY = 'This plugin is a signed plugin pack of this release; add it from Plugins or the setup guide, which downloads it from the release.'

/**
 * The package a plugin module name is loaded from: its scope and name, without a subpath.
 * @param moduleName - a row's module name, such as `@delorun/bundle-local/update-gate`.
 * @returns the package name, such as `@delorun/bundle-local`.
 */
function packageOf(moduleName: string): string {
  const parts = moduleName.split('/')
  return parts.slice(0, moduleName.startsWith('@') ? 2 : 1).join('/')
}

/** Only registry package names are retained before installation resolves its target. */
function installOperationTarget(spec: string): string | null {
  let parsed: ParsedInstallSpec
  try { parsed = parseInstallSpec(spec) }
  catch (_error) { return null /* Invalid specs remain private; installation owns their refusal. */ }
  return parsed.kind === 'registry' ? parsed.name : null
}

/** Exemption facts use canonical package identity, never the raw request or installed version. */
function exemptionOperationIdentity(packageVersion: string, runtimeVersion: string): Pick<PluginOperation, 'target' | 'version'> {
  try { validatePluginVersionExemption(packageVersion, runtimeVersion) }
  catch (_error) { return { target: null } /* The operation still owns validation failure reporting. */ }
  const separator = packageVersion.lastIndexOf('@')
  return { target: installOperationTarget(packageVersion.slice(0, separator)),
    version: diagnosticVersion(packageVersion.slice(separator + 1)) }
}

/** Unusable file metadata must not discard the rest of an operation record. */
function diagnosticVersion(value: unknown): string | undefined {
  return typeof value === 'string' && value.length <= 128 ? value : undefined
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Persistent management of the current profile's composition and packages. */
    pluginManager: PluginManager
    /** The distribution's plugin audit, which the manager asks before it selects or enables a bundle; optional. */
    pluginAudit: PluginAudit
    /** The home patch's half of a profile version, which the manager mirrors before a version and writes back on a restore; optional. */
    profileHomePatch: ProfileHomePatch
  }
}

/** Manage profile files and apply their declared reload lifecycle. */
export class PluginManager extends TypertRemoteService {
  static inject = ['loader', 'profileContext']
  static Config: z<Config> = z.object({
    pnpmCommand: z.string().default('pnpm'),
    outputBytes: z.number().step(1).min(1).default(16384),
    lockWaitMs: z.number().step(1).min(0).default(120000),
    inspectTimeoutMs: z.number().step(1).min(1000).default(20000),
    githubConnectionTimeoutMs: z.number().step(1).min(1000).default(5000),
    gitTransportTimeoutMs: z.number().step(1).min(1000).default(5000),
    idleTimeoutMs: z.number().step(1).min(1000).default(600000),
    registry: z.string().pattern(REGISTRY_URL),
    fallbackRegistries: z.array(z.string().pattern(REGISTRY_URL)).default([NPMMIRROR_REGISTRY]),
    gitCommand: z.string().default('git'),
    historyTimeoutMs: z.number().step(1).min(1000).default(30000),
    versionListLimit: z.number().step(1).min(1).default(20),
    versionLookupConcurrency: z.number().step(1).min(1).default(4),
    detailMaxBytes: z.natural().min(1).default(1024 * 1024),
    detailImageMaxBytes: z.natural().min(1).default(5 * 1024 * 1024),
    detailFetchTimeoutMs: z.natural().min(1).max(MAX_TIMER_DELAY_MS).default(15000),
    detailNpmFileSources: z.array(z.union(NPM_FILE_SOURCES)).min(1).default([...NPM_FILE_SOURCES]),
    protectedPlugins: z.array(z.string().min(1)).default([]),
    unversionedEntries: z.array(z.string().min(1)).default([]),
  })
  /** `PROTECTED_PLUGINS` and the configured `protectedPlugins`. */
  private readonly protectedPlugins: ReadonlySet<string>
  /** The configured `unversionedEntries`. */
  private readonly unversionedEntries: ReadonlySet<string>
  /** Management bundles remain protected if their files become unreadable. */
  private readonly managementBundles = new Set<string>()
  /**
   * The registry each package was last installed from by this manager in this process. pnpm verifies lockfile tarball
   * URLs against its default registry unless they belong to a named registry, so a later removal names it again.
   */
  private readonly installedFrom = new Map<string, Registry>()
  private readonly ownerEntryId: string | undefined
  private readonly packageOperations = new Set<Promise<unknown>>()
  private readonly profile: ProfileContext
  private readonly outputBytes: number
  private readonly lockWaitMs: number
  private readonly inspectTimeoutMs: number
  private readonly githubConnectionTimeoutMs: number
  private readonly gitTransportTimeoutMs: number
  private readonly idleTimeoutMs: number
  /** The history, built on first use so it can track the home patch's copy when the distribution provides one. */
  private opened: ProfileHistory | undefined
  private readonly gitCommand: string
  private readonly historyTimeoutMs: number
  private readonly pnpmCommand: string
  private readonly versionListLimit: number
  private readonly versionLookupConcurrency: number
  private readonly configuredRegistries: Omit<PluginRegistries, 'resolved'>
  private readonly ownerContext: Context
  private readonly abort = new AbortController()
  /** Installations by request id, from their call until it settles. */
  private readonly installs = new Map<PluginInstallRequestId, InstallControl>()
  private readonly detail: BundleDetailOptions

  constructor(ctx: Context, config: Config) {
    super(ctx, 'pluginManager')
    this.ownerEntryId = ctx.fiber.entry?.id
    this.ownerContext = ctx
    this.profile = ctx.profileContext
    this.protectedPlugins = new Set([...PROTECTED_PLUGINS, ...(config as Required<Config>).protectedPlugins])
    this.unversionedEntries = new Set((config as Required<Config>).unversionedEntries)
    for (const name of this.profile.startedBundles) this.protectsManager(name)
    this.outputBytes = (config as Required<Config>).outputBytes
    this.lockWaitMs = (config as Required<Config>).lockWaitMs
    this.inspectTimeoutMs = (config as Required<Config>).inspectTimeoutMs
    this.githubConnectionTimeoutMs = (config as Required<Config>).githubConnectionTimeoutMs
    this.gitTransportTimeoutMs = (config as Required<Config>).gitTransportTimeoutMs
    this.idleTimeoutMs = (config as Required<Config>).idleTimeoutMs
    this.pnpmCommand = (config as Required<Config>).pnpmCommand
    const { gitCommand, historyTimeoutMs } = config as Required<Config>
    this.gitCommand = gitCommand
    this.historyTimeoutMs = historyTimeoutMs
    this.versionListLimit = (config as Required<Config>).versionListLimit
    this.versionLookupConcurrency = (config as Required<Config>).versionLookupConcurrency
    this.configuredRegistries = {
      registry: config.registry === undefined ? null : normalizeRegistry(config.registry),
      fallbackRegistries: (config as Required<Config>).fallbackRegistries.map(normalizeRegistry),
    }
    const required = config as Required<Config>
    this.detail = {
      profile: this.profile, maxDocumentBytes: required.detailMaxBytes, maxImageBytes: required.detailImageMaxBytes,
      npmFileSources: required.detailNpmFileSources, timeoutMs: required.detailFetchTimeoutMs, lifetime: this.abort.signal,
    }
    ctx.effect(() => async () => {
      this.abort.abort()
      await Promise.allSettled([...this.packageOperations])
    }, 'plugin-manager: package cancellation')
    // A configuration edit, from a settings form or the agent, is a version of its own, named by whoever made it.
    ctx.on('config-editor/edited', ({ entryId }) => {
      if (this.unversionedEntries.has(entryId)) return
      const task = this.recordEdit(entryId, this.changedBy())
      this.packageOperations.add(task)
      void task.finally(() => { this.packageOperations.delete(task) })
    })
    ctx.inject(['connection'], (scope) => {
      scope.effect(() => scope.connection.fetch.register({
        path: DETAIL_FILE_PATH, methods: ['GET'], requestBody: 'buffered', fetch: request => this.serveDetailFile(request),
      }), `plugin-manager: ${DETAIL_FILE_PATH}`)
    })
  }

  /**
   * Read a bundle's long description: the Markdown file its locale `meta.detail` names in `language`, otherwise its
   * README. An installed bundle is read from its directory without network access; an official bundle the installation
   * offers before it is installed is read from the npm file CDNs at its offered version. Nothing is cached.
   * @param name - the bundle's package name, as `listBundles()` lists it.
   * @param language - the display language, such as `zh-CN`; documents fall back through its prefixes to English.
   * @param options - `npmFileSources` names npm file CDNs to ask first for an offered bundle, in order, such as the one
   *   a Client measured as fastest; configured CDNs it omits follow, and CDNs that are not configured are not asked.
   * @returns the document with its origin and path, or `none`.
   * @throws {RemoteError} `plugin-manager/unknown-bundle`, `plugin-manager/invalid-language`, or
   *   `plugin-manager/detail-unavailable`.
   */
  @Remote
  async readBundleDetail(name: string, language: string, options?: { npmFileSources?: NpmFileSource[] }): Promise<BundleDetail> {
    return await readBundleDocument(await this.listedBundle(name), language, options?.npmFileSources ?? [], this.detail)
  }

  private async listedBundle(name: string): Promise<BundleInfo> {
    const bundle = (await this.listBundles()).find(candidate => candidate.name === name)
    if (bundle === undefined) throw new RemoteError('plugin-manager/unknown-bundle', `No such bundle: ${name}`, { name })
    return bundle
  }

  /**
   * Answer `GET ${DETAIL_FILE_PATH}?bundle=<name>&document=<path>&path=<destination>[&sources=<cdn>,...]` with one image
   * beside a bundle document; `sources` names npm file CDNs to ask first for an offered bundle, as `readBundleDetail` does.
   */
  private async serveDetailFile(request: Request): Promise<Response> {
    const params = new URL(request.url).searchParams
    const [bundle, document, path] = [params.get('bundle'), params.get('document'), params.get('path')]
    // Images are read again on every request, so a reinstalled bundle shows its own.
    const cache = 'no-store'
    if (bundle === null || document === null || path === null) return detailImageResponse('invalid', cache)
    try {
      const image = await readBundleImage(await this.listedBundle(bundle), document, path, params.get('sources')?.split(',') ?? [], this.detail)
      return detailImageResponse(image, cache)
    } catch (error) {
      const failure = remoteErrorOf(error)
      if (failure?.code === 'plugin-manager/unknown-bundle') return detailImageResponse(undefined, cache)
      if (failure?.code === 'plugin-manager/detail-unavailable') return detailImageResponse(failure.details.reason, cache)
      throw error
    }
  }

  /**
   * The home patch's half of a version, read when a call needs it: the distribution provides it as `profileHomePatch`,
   * and a profile without one saves versions of its own files alone, as upstream's does.
   * @returns the service, or undefined when the distribution provides none.
   */
  private homePatch(): ProfileHomePatch | undefined {
    return this.ownerContext.get('profileHomePatch')
  }

  /**
   * The profile files the history tracks: upstream's five, and the home patch's copy when the distribution provides
   * one, so a version covers both patch layers.
   * @returns the file names, relative to the profile directory.
   */
  private trackedFiles(): readonly string[] {
    const homePatch = this.homePatch()
    return homePatch === undefined ? PROFILE_FILES : [...PROFILE_FILES, homePatch.copyFilename]
  }

  /**
   * The profile's history, opened on first use over {@link trackedFiles}, so a service the distribution provides after
   * this manager is constructed is still tracked.
   * @returns the history.
   */
  private versions(): ProfileHistory {
    this.opened ??= new ProfileHistory(this.profile.dir, this.trackedFiles(), this.gitCommand, this.historyTimeoutMs,
      files => this.ownerContext.bail('plugin-manager/before-record', files))
    return this.opened
  }

  /**
   * Save a version of the profile's files, with the home patch's copy mirrored first when the distribution provides
   * one, so the version covers both patch layers. A version the admission refuses puts the copy back as it was.
   * @param summary - what changed, which is the version's subject.
   * @param changedBy - who changed it.
   * @returns the new version's id, or undefined when nothing changed.
   * @throws HistoryUnavailableError when git cannot keep the history; {@link VersionRefusedError} when the admission
   *   refuses the version.
   */
  private async recordVersion(summary: string, changedBy: ProfileChangedBy): Promise<ProfileVersionId | undefined> {
    const homePatch = this.homePatch()
    if (homePatch === undefined) return await this.versions().record(summary, changedBy)
    const previous = await homePatch.mirror()
    try {
      return await this.versions().record(summary, changedBy)
    } catch (error) {
      if (error instanceof VersionRefusedError) await homePatch.restoreCopy(previous)
      throw error
    }
  }

  // Saved under the profile's lock, which the editor released before announcing the edit.
  private async recordEdit(entryId: string, changedBy: ProfileChangedBy): Promise<void> {
    try {
      await withFileLock(join(this.profile.dir, 'package.json'),
        () => this.recordVersion(`Changed the settings of ${entryId}`, changedBy), { waitMs: this.lockWaitMs })
    } catch (error) {
      // The edit is saved and applied; a version that cannot be written only means it cannot be undone or restored.
      this.ownerContext.logger.warn(`the profile's history could not save the settings of ${entryId}: ${messageOf(error)}`)
      return
    }
    this.ownerContext.emit('plugin-manager/changed', { reason: 'config' })
  }

  /** Read exact plugin-version exemptions saved in this profile.
   * @returns Accepted package-name@version keys with the runtime versions they may run on, and any
   * record or file problem the reader rejected, which the caller reports instead of failing.
   */
  @Remote
  listVersionExemptions(): { exemptions: Record<string, string[]>; warnings: string[] } {
    const { exemptions, warnings } = readProfileCompatibility(this.profile.dir)
    return { exemptions, warnings }
  }

  /** Grant or revoke one exact plugin/runtime exemption and reevaluate live plugins.
   * @param packageVersion Exact manifest package name followed by @ and its version; never an installation spec or alias.
   * @param runtimeVersion Exact current DSH version for grants; revocation may name a previous runtime.
   * @param enabled Whether to grant rather than revoke the exemption.
   * @param acceptRisk Required true for grants after the user accepts possible crashes and data loss.
   * @returns Saved and runtime outcomes. Startup-only profiles require restart.
   */
  @Remote
  setVersionExemption(packageVersion: string, runtimeVersion: string, enabled: boolean, acceptRisk?: boolean): Promise<ChangeResult> {
    return this.change(result => this.configure(async () => {
      // A revoked exemption of a protected package stops it at the reevaluation below, as disabling it would.
      if (!enabled) this.assertProtectedExemptionsKept({ [packageVersion]: [runtimeVersion] }, {})
      await setProfileVersionExemption(this.profile.dir, packageVersion, runtimeVersion, enabled, acceptRisk === true)
      Object.assign(result, await this.reload())
    }), { stage: 'enable', target: packageVersion, enabled }, 'bundle',
    () => `${enabled ? 'Allowed' : 'Revoked'} ${packageVersion} on DSH ${runtimeVersion}`, exemptionOperationIdentity(packageVersion, runtimeVersion))
  }

  /**
   * Take back the latest change: put the profile back as the version before the latest held it, and apply it. An edit
   * made outside plugin management since the last change is saved as a version first, so it is that edit undo takes
   * back; when the `plugin-manager/before-record` check refuses to save that edit, undo takes it back by restoring the
   * latest version instead. It installs and audits what it brings back as {@link restore} does. The undo is itself a
   * version, so undoing it is another undo.
   * @returns Saved and runtime outcomes, naming the version taken back as `undone`, or the latest version as `restored`
   * when an unsaved edit was taken back, and listing what changed in `changes`. Fails with `nothing-to-undo` when the
   * history holds fewer than two versions, `history-unavailable` when git cannot keep it, and `audit-findings` or
   * `audit-refused` when the plugin audit refuses a package it brings back.
   */
  @Remote
  undo(): Promise<ChangeResult> {
    let summary = ''
    return this.change(result => this.configure(async () => {
      const { value: { latest, previous }, unsaved } = await this.readHistory(async () => {
        const [latest, previous] = await this.versions().list(2)
        return { latest: latest === undefined ? undefined : { ...latest, files: await this.versions().filesAt(latest.id) }, previous }
      })
      const current = this.profileFiles()
      if (unsaved !== undefined && latest !== undefined && this.trackedFiles().some(name => current.get(name) !== latest.files.get(name))) {
        result.restored = { version: latest.id, summary: latest.summary }
        summary = 'Undid an edit made outside plugin management that the history did not save'
        await this.restoreVersion(latest.id, result)
        return
      }
      if (latest === undefined || previous === undefined) throw new ManagementFailure('nothing-to-undo')
      result.undone = { version: latest.id, summary: latest.summary }
      summary = `Undid "${latest.summary}"`
      await this.restoreVersion(previous.id, result)
    }), { stage: 'undo', target: '' }, 'undo', () => summary)
  }

  /**
   * Put the profile back as one version held it, and apply it: a restored dependency set is installed from the restored
   * lockfile first, and every package the version brings back is audited before any of its code runs. An edit made
   * outside plugin management is saved as a version first. The restore is itself a version.
   * @param version - the version to restore, as {@link history} lists it.
   * @returns Saved and runtime outcomes, naming the version as `restored` and listing what changed in `changes`. Fails
   * with `unknown-version` when the history holds no such version, `history-unavailable` when git cannot keep it, and
   * `audit-findings` or `audit-refused` when the plugin audit refuses a package it brings back.
   */
  @Remote
  restore(version: ProfileVersionId): Promise<ChangeResult> {
    let summary = ''
    return this.change(result => this.configure(async () => {
      const { value: held } = await this.readHistory(() => this.versions().version(version))
      if (held === undefined) throw new ManagementFailure('unknown-version')
      result.restored = { version: held.id, summary: held.summary }
      summary = `Restored the version "${held.summary}"`
      await this.restoreVersion(held.id, result)
    }), { stage: 'restore', target: version }, 'restore', () => summary)
  }

  /**
   * The profile's versions, newest first, after saving an edit made outside plugin management as a version.
   * @param limit - the most to read, from 1 to 500.
   * @returns the versions, with `unsaved` naming why the edit was not saved when `plugin-manager/before-record` refused
   *   it, or why the profile has no history.
   */
  @Remote
  history(limit: number): Promise<ProfileHistoryInfo> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) return Promise.reject(new RangeError('limit must be an integer from 1 to 500'))
    return withFileLock(join(this.profile.dir, 'package.json'), async (): Promise<ProfileHistoryInfo> => {
      try {
        const unsaved = await this.recordOutsideEdit()
        return { available: true, versions: await this.versions().list(limit), ...unsaved === undefined ? {} : { unsaved } }
      } catch (error) {
        // Every failure of the history is a HistoryUnavailableError.
        return { available: false, reason: messageOf(error) }
      }
    }, { waitMs: this.lockWaitMs })
  }

  /**
   * The profile's versions, newest first, as the history holds them. Unlike {@link history}, it saves no version for an
   * edit made outside plugin management and never starts the history, so it writes nothing and runs only git reads.
   * @param limit - the most to read, from 1 to 500.
   * @returns the versions, empty before the history starts, or why git cannot read it.
   */
  async listHistory(limit: number): Promise<ProfileHistoryInfo> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new RangeError('limit must be an integer from 1 to 500')
    try {
      return { available: true, versions: await this.versions().list(limit) }
    } catch (error) {
      // Every failure of the history is a HistoryUnavailableError.
      return { available: false, reason: messageOf(error) }
    }
  }

  /**
   * What {@link undo} would put back if it ran now, read without saving a version or starting the history: the version
   * before the latest, or the latest itself when the managed files differ from it, since undo first saves that outside
   * edit and then takes it back.
   * @returns the version undo restores and what it changes, or the refusal undo would end with.
   */
  async previewUndo(): Promise<ProfileVersionPreview> {
    const current = this.profileFiles()
    return this.preview(current, async () => {
      const [latest, previous] = await this.versions().list(2)
      if (latest === undefined) return undefined
      const atLatest = await this.versions().filesAt(latest.id)
      const outside = PROFILE_FILES.some(name => current.get(name) !== atLatest.get(name))
      return outside ? latest : previous
    }, 'nothing-to-undo')
  }

  /**
   * What {@link restore} would put back if it ran now, read without saving a version or starting the history.
   * @param version - the version to restore, as {@link history} lists it.
   * @returns the version and what it changes, or the refusal restore would end with.
   */
  async previewRestore(version: ProfileVersionId): Promise<ProfileVersionPreview> {
    return this.preview(this.profileFiles(), () => this.versions().version(version), 'unknown-version')
  }

  /** Compare the files now with the target version's; only the history's reads become `history-unavailable`. */
  private async preview(
    current: ReadonlyMap<string, string | undefined>, target: () => Promise<ProfileVersion | undefined>,
    missing: 'nothing-to-undo' | 'unknown-version',
  ): Promise<ProfileVersionPreview> {
    let held: ProfileVersion | undefined
    let files: Map<string, string | undefined>
    try {
      held = await target()
      if (held === undefined) return { ok: false, error: { code: missing } }
      files = await this.versions().filesAt(held.id)
    } catch (error) {
      // Every failure of the history is a HistoryUnavailableError.
      return { ok: false, error: { code: 'history-unavailable', diagnostic: messageOf(error) } }
    }
    const changes = { ...profileVersionChanges(current, files), homePatchChanged: await this.homePatchDiffers(held.id) }
    const pack = await this.packOutsideItsFolder(changes)
    if (pack !== undefined) return { ok: false, error: { code: 'operation-error', diagnostic: pack } }
    return { ok: true, version: { version: held.id, summary: held.summary }, changes }
  }

  /**
   * Whether a version's home patch differs from the home's now, so a restore of it would replace a value the person set
   * there since.
   * @param version - the version.
   * @returns true when the version holds a home patch that differs from the home's; false without a `profileHomePatch`
   *   service, and for a version that holds none.
   */
  private async homePatchDiffers(version: ProfileVersionId): Promise<boolean> {
    const homePatch = this.homePatch()
    if (homePatch === undefined) return false
    try {
      return await homePatch.differs(version)
    } catch (error) {
      // A home patch that cannot be read is reported as a history failure, as the version's own files are.
      throw new ManagementFailure('history-unavailable', undefined, messageOf(error))
    }
  }

  /**
   * Refuse a package the release publishes as a pack unless the spec is its pack folder and this Host still runs the
   * release `runtimes/current` names, since an update that switched leaves the folder's link naming another release.
   * @param packs - the composed pack targets.
   * @param name - the package name.
   * @param spec - the spec being installed.
   * @throws ManagementFailure `operation-error` with the diagnostic.
   */
  private async requirePackFolder(packs: PackFolderCheck, name: string, spec: string): Promise<void> {
    if (!await packs.isPack(name)) return
    if (packs.linkSpec(name) !== spec) throw new ManagementFailure('operation-error', undefined, PACK_ONLY)
    if (!await packs.runsCurrentRelease()) throw new ManagementFailure('operation-error', undefined, PACK_UPDATE_PENDING)
    if (packs.intact !== undefined && !await packs.intact(name)) throw new ManagementFailure('operation-error', undefined, PACK_CHANGED)
  }

  /**
   * The first package a version would bring back or change whose spec is not its signed pack's folder, for a package
   * the release publishes as a pack.
   * @param changes - what the version changes.
   * @returns why the version is refused, naming the package, or `undefined` when every pack it holds is linked
   * through its pack folder of the running release.
   */
  private async packOutsideItsFolder(changes: ProfileVersionChanges): Promise<string | undefined> {
    const packs = this.ownerContext.get('packInstallTargets')
    if (packs === undefined) return undefined
    for (const plugin of changes.plugins) {
      if (plugin.change === 'removed' || !await packs.isPack(plugin.name)) continue
      if (dependencySpec(plugin.name, plugin.to, this.profile.dir) !== packs.linkSpec(plugin.name)) return `${plugin.name}: ${PACK_RESTORE}`
      // The pack's own folder is linked through `packs/current`, which names another release once an update switched.
      if (!await packs.runsCurrentRelease()) return `${plugin.name}: ${PACK_UPDATE_PENDING}`
    }
    return undefined
  }

  /** The tracked files as they are now; an absent file reads as undefined. */
  private profileFiles(): Map<string, string | undefined> {
    return new Map(this.trackedFiles().map((name) => {
      try { return [name, readFileSync(join(this.profile.dir, name), 'utf8')] }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [name, undefined]
        throw error
      }
    }))
  }

  /**
   * Save an edit made outside plugin management as its own version.
   * @returns why the `plugin-manager/before-record` check refused to save it, or undefined when it was saved or there was
   *   none.
   * @throws HistoryUnavailableError when git cannot keep the history.
   */
  private async recordOutsideEdit(): Promise<string | undefined> {
    try {
      await this.recordVersion(OUTSIDE_SUMMARY, { kind: 'outside' })
      return undefined
    } catch (error) {
      if (!(error instanceof VersionRefusedError)) throw error
      return error.reason
    }
  }

  /**
   * Read the profile's history for an undo or a restore, which cannot proceed without it: the edit made outside plugin
   * management is saved first, unless `plugin-manager/before-record` refuses it, which leaves it unsaved and names why;
   * a history git cannot keep is the `history-unavailable` refusal.
   */
  private async readHistory<T>(read: () => Promise<T>): Promise<{ value: T; unsaved?: string }> {
    try {
      const unsaved = await this.recordOutsideEdit()
      return { value: await read(), ...unsaved === undefined ? {} : { unsaved } }
    } catch (error) {
      // Every failure of the history is a HistoryUnavailableError.
      throw new ManagementFailure('history-unavailable', undefined, messageOf(error))
    }
  }

  /**
   * Write one version's profile files and apply them as an installation would, reinstalling when its lockfile differs,
   * and audit every package the version brings back before any of its code runs. With an unchanged lockfile, those
   * packages are already installed and are audited before any file is written. Otherwise the version's dependency set
   * is installed with every script held back, its packages are audited, and only then are the build scripts the
   * version allows run; a refusal puts the profile's files back as they were and installs their dependency set again.
   * A version without a lockfile, such as the profile before its first installation, is installed from its manifest
   * without creating one, which removes what later versions added. pnpm verifies the lockfile's entries against its
   * default registry, so the reinstall names the registry the packages entering or leaving the profile were installed
   * from, as a removal does, when they share one; otherwise the registry an installation asks first.
   */
  private async restoreVersion(version: ProfileVersionId, result: ChangeResult): Promise<void> {
    const current = this.profileFiles()
    const { value: files } = await this.readHistory(() => this.versions().filesAt(version))
    const changes = { ...profileVersionChanges(current, files), homePatchChanged: await this.homePatchDiffers(version) }
    result.changes = changes
    const pack = await this.packOutsideItsFolder(changes)
    if (pack !== undefined) throw new ManagementFailure('operation-error', undefined, pack)
    const provided = changes.plugins.flatMap(plugin => this.providedProtected(plugin.name))
    if (provided.length > 0) throw this.protectionFailure(provided)
    const rows = this.currentRows()
    const exemptions = readProfileVersionExemptions(this.profile.dir)
    const audited = broughtBack(changes)
    if (files.get(LOCKFILE) === current.get(LOCKFILE)) {
      await this.auditRestored(audited)
      await writeProfileVersion(this.profile.dir, files)
      try {
        this.assertProtectedRowsKept(rows, this.composedRows())
        this.assertProtectedExemptionsKept(exemptions, readProfileVersionExemptions(this.profile.dir))
      } catch (error) {
        // The version's files go back as they were; its dependency set is the current one, so nothing is reinstalled.
        await writeProfileVersion(this.profile.dir, current)
        throw error
      }
      // The home patch is written once every check has passed, so a refused restore leaves the home layer as it was.
      await this.homePatch()?.restore(version)
      Object.assign(result, await this.publishAndReload())
      return
    }
    await writeProfileVersion(this.profile.dir, files)
    const moved = changes.plugins.map(plugin => plugin.name)
    const used = new Set(moved.map(name => this.installedFrom.has(name)
      ? this.installedFrom.get(name)
      : this.configuredRegistries.registry))
    const registry = used.size === 1 ? [...used][0] : this.configuredRegistries.registry
    const registryArgs = typeof registry === 'string' ? [`--config.registry=${registry}`] : []
    const lockfileOf = (held: ReadonlyMap<string, string | undefined>): string =>
      held.get(LOCKFILE) === undefined ? '--config.lockfile=false' : '--frozen-lockfile'
    const succeeded = (run: PackageResult): boolean => run.exitCode === 0 && run.timedOut !== true
    result.packageResult = await this.runPnpm(['install', lockfileOf(files), '--ignore-scripts', ...registryArgs])
    if (!succeeded(result.packageResult)) throw new Error(result.packageResult.output)
    try {
      await this.auditRestored(audited, 'scripts')
      this.assertProtectedRowsKept(rows, this.composedRows())
      this.assertProtectedExemptionsKept(exemptions, readProfileVersionExemptions(this.profile.dir))
    } catch (error) {
      // No package the audit refused stays: the files go back as they were, and their installed set with them.
      await writeProfileVersion(this.profile.dir, current)
      const repair = await this.runPnpm(['install', lockfileOf(current), ...registryArgs])
      if (!succeeded(repair)) {
        result.warnings = [...result.warnings ?? [], 'the profile\'s files are back as they were, but pnpm could not install their dependencies again; run pnpm install in the profile']
      }
      throw error
    }
    result.packageResult = await this.runPnpm(['rebuild', '--pending'])
    if (!succeeded(result.packageResult)) throw new Error(result.packageResult.output)
    // Asked again once the builds have run, so an audit that records the installed files records their output too.
    await this.auditRestored(audited)
    for (const plugin of changes.plugins) if (plugin.change === 'removed') this.installedFrom.delete(plugin.name)
    // The home patch is written once every check has passed, so a refused restore leaves the home layer as it was.
    await this.homePatch()?.restore(version)
    Object.assign(result, await this.publishAndReload())
  }

  /**
   * Ask the distribution's plugin audit about each package a restored version brings back, as an installation and an
   * enablement would; a distribution without one audits nothing.
   * @param names - the packages, as {@link broughtBack} names them.
   * @param pending - `scripts` while the restore has installed them with every script held back.
   * @throws ManagementFailure `audit-refused` or `audit-findings` when the audit refuses one.
   */
  private async auditRestored(names: readonly string[], pending?: 'scripts'): Promise<void> {
    if (this.ownerContext.get('pluginAudit') === undefined) return
    for (const name of names) {
      const dir = resolveBundleDir('dsh', name, this.profile.installAnchor, this.profile.dir)
      await this.auditBundle(name, dir, readProfileManifest('dsh', dir).version, undefined, pending)
    }
  }

  /** Read current plugins, including why a row cannot be changed through the profile patch.
   * @returns Current runtime entries with persistent patch targets.
   */
  @Remote
  async listPlugins(): Promise<PluginInfo[]> {
    const rows = flatten(composeEntries([readProfilePatches('dsh', this.profile)]))
    const snapshot = await readPluginInventory(this.ctx)
    return snapshot.entries.map((entry) => {
      const actual = [...this.ctx.loader.entries()].find(row => row.id === entry.entryId)
      const candidates = rows.filter(row => row.id === actual?.options.id)
      const candidate = candidates[0]
      if (this.protectedPlugins.has(entry.moduleName) || entry.entryId === this.ownerEntryId) {
        return { ...entry, readOnlyReason: 'management-required' as const }
      }
      if (candidate === undefined || candidates.length > 1 || candidate.name !== entry.moduleName
        || actual?.parent.tree.ctx.fiber.entry?.id !== 'include') {
        return { ...entry, readOnlyReason: 'unaddressable' as const }
      }
      return { ...entry, patchId: candidate.id }
    })
  }

  /** Read installed, installation-provided, and offline Official catalog bundles, plus selected non-bundle names.
   * A dependency without a bundle patch is listed, as a `not-bundle` problem, only while it is selected.
   * @returns Package versions, manifest descriptions, the installable spec of profile dependencies, rows, optional
   * display metadata, activation selections, whether the installation offers the bundle, and removal availability.
   */
  @Remote
  listBundles(): Promise<BundleInfo[]> {
    return Promise.resolve(this.readBundles().map((bundle) => {
      const target = updateRefusal(bundle, bundle.name)
      return typeof target === 'string' ? bundle : { ...bundle, update: target.kind }
    }))
  }

  /** The bundle inventory before update eligibility, which is derived from each listed bundle. */
  private readBundles(): Omit<BundleInfo, 'update'>[] {
    const manifest = readProfileManifest('dsh', this.profile.dir)
    const exemptions = readProfileVersionExemptions(this.profile.dir)
    const selected = bundleSelection(manifest)
    const recorded = manifest.dependencies ?? {}
    const dependencies = Object.keys(recorded)
    const installation = JSON.parse(readFileSync(this.profile.installAnchor, 'utf8')) as InstallationManifest
    const catalog = new Map(OFFICIAL_ON_DEMAND_CATALOG.map(entry => [entry.packageName, entry]))
    const names = [...new Set([...selected, ...dependencies, ...Object.keys(installation.dependencies ?? {}), ...catalog.keys()])]
    const bundles: Omit<BundleInfo, 'update'>[] = []
    const runtimeVersion = getDshRuntimeVersion()
    for (const name of names) {
      const installed = dependencies.includes(name)
      const optional = OPTIONAL_BUNDLES.includes(name)
      const enabled = selected.includes(name)
      const shipped = Object.hasOwn(installation.dependencies ?? {}, name)
      const offered = catalog.get(name)
      const official = optional || offered !== undefined
      let target: Pick<BundleInfo, 'installTarget'> = {}
      let targetError: ManagementError | undefined
      if (offered !== undefined) {
        try {
          // A package the release publishes as a signed pack never has a registry target, installed or not.
          const packs = this.ownerContext.get('packInstallTargets')
          const pack = packs?.resolve(name, runtimeVersion)
          if (pack === undefined && packs?.listed(name) === true) throw new ManagementFailure('operation-error', undefined, PACK_ONLY)
          target = { installTarget: pack ?? officialBundleInstallTarget(name, this.profile.installAnchor, runtimeVersion) }
        }
        catch (error) { targetError = managementError(error) }
      }
      const catalogMeta = offered === undefined ? {} : { meta: offered.meta }
      if (offered !== undefined && !installed && !shipped) {
        let platformError: ManagementError | undefined
        try { assertBundlePlatform(offered.platforms, process.platform) }
        catch (error) { platformError = managementError(error) }
        const error = platformError ?? targetError ?? (enabled ? { code: 'not-bundle' as const } : undefined)
        bundles.push({ name, official, availability: 'missing', ...catalogMeta, ...target, enabled, installed, optional,
          ...platformError?.code === 'unsupported-platform' ? { listedByDefault: false } : {},
          removable: enabled, rows: [], overrides: [],
          ...error === undefined ? {} : { error } })
        continue
      }
      // Installation-owned copies remain protected even if a profile also declares their names.
      const owned = installed && !shipped
      const removable = owned || (enabled && !installed && !shipped)
      const sourceOf = (packageName?: string): { source?: string } => {
        if (!owned) return {}
        const spec = dependencySpec(name, recorded[name] as string, this.profile.dir, packageName)
        return { source: approvedFromTarget(manifest, name, target.installTarget) ? target.installTarget?.spec ?? spec : spec }
      }
      const readOnlyReason = this.protectsManager(name) ? 'management-required' as const : undefined
      let availability: BundleInfo['availability'] = 'missing'
      let version: string | undefined
      let listing: Pick<BundleInfo, 'listedByDefault'> = {}
      try {
        const info = bundleManifest(name, this.profile.dir, this.profile.installAnchor)
        availability = shipped ? 'installation' : 'profile'
        if (info === undefined) {
          if (enabled || offered !== undefined) bundles.push({ name, official, availability, ...catalogMeta, ...target,
            ...sourceOf(), enabled, installed, optional, removable: removable && readOnlyReason === undefined,
            ...(readOnlyReason === undefined ? {} : { readOnlyReason }), error: targetError ?? { code: 'not-bundle' }, rows: [], overrides: [] })
          continue
        }
        version = info.version
        const listedByDefault = info.dsh?.bundle?.listedByDefault
        // The launcher ignores this display field, so an invalid value is a metadata diagnostic, not a load error.
        const listingDiagnostic = listedByDefault === undefined || typeof listedByDefault === 'boolean'
          ? undefined
          : 'dsh.bundle.listedByDefault must be a boolean'
        if (typeof listedByDefault === 'boolean') listing = { listedByDefault }
        const compatibility = evaluatePluginCompatibility(info, exemptions)
        if (compatibility !== undefined && !compatibility.exempted) throw new ManagementFailure('incompatible-version', [incompatiblePlugin(compatibility)])
        const dir = resolveBundleDir('dsh', name, this.profile.installAnchor, this.profile.dir)
        const read: BundleInfo['meta'] = offered?.meta ?? readPluginMeta(info.name ?? name, pathToFileURL(join(dir, 'package.json')).href)
        const meta = listingDiagnostic === undefined
          ? read
          : { ...read, error: read?.error === undefined ? listingDiagnostic : `${read.error}; ${listingDiagnostic}` }
        let platformError: ManagementError | undefined
        try { assertBundlePlatform(info.dsh?.bundle?.platforms, process.platform) }
        catch (error) { platformError = managementError(error) }
        if (platformError?.code === 'unsupported-platform') listing = { listedByDefault: false }
        const error = platformError ?? targetError
        bundles.push({ name, official, availability, ...listing, ...target, ...(version === undefined ? {} : { version }),
          ...(info.description === undefined || info.description === '' ? {} : { description: info.description }),
          ...meta === undefined ? {} : { meta },
          ...sourceOf(info.name), enabled, installed, optional, removable: removable && readOnlyReason === undefined,
          ...(readOnlyReason === undefined ? {} : { readOnlyReason }),
          ...this.declaredRows(name, info),
          ...error === undefined ? {} : { error } })
      } catch (error) {
        if (enabled || installed || optional || offered !== undefined) {
          bundles.push({ name, official, availability, ...listing, ...catalogMeta, ...target, ...(version === undefined ? {} : { version }),
            ...sourceOf(), enabled, installed, optional, removable: removable && readOnlyReason === undefined,
            ...(readOnlyReason === undefined ? {} : { readOnlyReason }),
            error: targetError ?? managementError(error), rows: [], overrides: [] })
        }
      }
    }
    return bundles
  }

  /** Read the registries this manager asks: the configured first one, its fallbacks in order, and what pnpm's own configuration names.
   * @returns The registries in pnpm's comparison form; null is the one pnpm's own configuration names, `resolved` as pnpm reads it now.
   */
  @Remote
  async registries(): Promise<PluginRegistries> {
    return {
      ...this.configuredRegistries, fallbackRegistries: [...this.configuredRegistries.fallbackRegistries],
      resolved: await readProfileRegistry(this.profile.dir, {
        ...this.profile.packageManager ?? { command: this.pnpmCommand }, timeoutMs: this.inspectTimeoutMs,
      }),
    }
  }

  /** Read what a spec names before installing it.
   * @param spec One package spec: a registry name, an absolute path, a git address, or a tarball.
   * @param options The registry asked first.
   * @param signal Ends a registry lookup early.
   * @returns The package the spec names, or why it is refused.
   */
  @Remote
  async inspect(spec: string, options?: InspectOptions, signal?: AbortSignal): Promise<PluginSpecInspection> {
    let parsed
    try {
      parsed = parseInstallSpec(spec)
    } catch (error) {
      /* v8 ignore next 2 -- parseInstallSpec throws nothing but its own refusal */
      if (!(error instanceof InvalidInstallSpecError)) throw error
      return refused('invalid-spec', error.reason)
    }
    const manifest = readProfileManifest('dsh', this.profile.dir)
    const installation = JSON.parse(readFileSync(this.profile.installAnchor, 'utf8')) as InstallationManifest
    const known = new Set([
      ...bundleSelection(manifest), ...Object.keys(manifest.dependencies ?? {}), ...Object.keys(installation.dependencies ?? {}),
    ])
    const plan = registryPlan(options?.registry, await this.registries())
    const registry = plan[0] as Registry
    switch (parsed.kind) {
      case 'git': return { status: 'accepted', kind: 'git', bundle: null, registry, host: parsed.host }
      case 'tarball':
        if (parsed.path !== undefined && !existsSync(parsed.path)) return refused('not-a-package', 'the tarball does not exist')
        return { status: 'accepted', kind: 'tarball', bundle: null, registry, ...parsed.host === undefined ? {} : { host: parsed.host } }
      case 'path': {
        if (!existsSync(parsed.path)) return refused('not-a-package', 'the path does not exist')
        let read: object
        try {
          read = JSON.parse(await readFile(join(parsed.path, 'package.json'), 'utf8')) as object
        } catch (error) {
          return refused('not-a-package', `no readable package.json at the path: ${messageOf(error)}`)
        }
        const inspection = inspectionOf('path', read, registry)
        if (inspection.name === undefined) return refused('not-a-package', 'the package.json names no package')
        if (known.has(inspection.name)) return refused('already-installed', `${inspection.name} is already installed`)
        if (!inspection.bundle) return refused('not-a-bundle', `${inspection.name} declares no dsh.bundle`)
        return inspection
      }
      case 'registry': {
        if (known.has(parsed.name)) return refused('already-installed', `${parsed.name} is already installed`)
        const asked = await this.askRegistries(spec.trim(), INSPECT_FIELDS, plan, parsed, signal)
        const registries = asked.attempts.map(attempt => attempt.registry)
        if (asked.status === 'refused') return { status: 'refused', problem: asked.problem, reason: asked.reason, registries }
        // pnpm prints a range's highest match as one object; npm's array of every match is read by its last entry.
        const latest: unknown = Array.isArray(asked.answer) ? asked.answer.at(-1) : asked.answer
        if (typeof latest !== 'object' || latest === null) return { status: 'refused', problem: 'unknown', reason: 'pnpm view answered no package', registries }
        const inspection = inspectionOf('registry', latest, asked.registry)
        const named = inspection.name === undefined ? { ...inspection, name: parsed.name } : inspection
        if (!named.bundle) return { status: 'refused', problem: 'not-a-bundle', reason: `${named.name} declares no dsh.bundle`, registries }
        return named
      }
    }
  }

  /** Read the published versions newer than an installed registry package's version, from the first registry that answers.
   * Official bundles follow the DSH version and are not listed.
   * @param name Installed profile dependency name.
   * @param options The registry asked first; absent, the one the package was installed from in this process, else the configured one.
   * @param signal Ends the lookups early.
   * @returns At most `versionListLimit` newer versions, newest first, with their tags, deprecation, bundle declaration,
   * and DSH compatibility, and the registry that answered; or why no list could be read, with every registry asked.
   */
  @Remote
  async listVersions(name: string, options?: ListVersionsOptions, signal?: AbortSignal): Promise<PluginVersionList> {
    const target = updateRefusal((await this.listBundles()).find(bundle => bundle.name === name), name)
    if (typeof target === 'string') return { status: 'refused', problem: 'not-updatable', reason: target, attempts: [] }
    if (target.kind === 'git') return { status: 'refused', problem: 'not-updatable', reason: `${name} is installed from Git, which lists no versions`, attempts: [] }
    const plan = registryPlan(this.registryFor(name, options?.registry), await this.registries())
    const listing = await this.askRegistries(name, VERSION_LIST_FIELDS, plan, target.parsed, signal)
    if (listing.status === 'refused') return listing
    let newer
    try { newer = newerVersions(listing.answer, target.installed) }
    catch (error) { return { status: 'refused', problem: 'unknown', reason: messageOf(error), attempts: listing.attempts } }
    const listed = newer.slice(0, this.versionListLimit)
    const exemptions = readProfileVersionExemptions(this.profile.dir)
    const looked = await mapConcurrent(listed, this.versionLookupConcurrency, async (published) => {
      const spec = `${name}@${published.version}`
      const answer = await this.askRegistries(spec, VERSION_FIELDS, [listing.registry], { kind: 'registry', spec, name }, signal)
      if (answer.status === 'refused') return answer
      const facts = versionFacts(answer.answer, name, published.version)
      let compatibility
      try { compatibility = evaluatePluginCompatibility(facts.manifest, exemptions) }
      catch (error) { return { status: 'refused' as const, problem: 'unknown' as const, reason: messageOf(error), attempts: answer.attempts } }
      const version: PluginVersion = {
        ...published, bundle: facts.bundle, ...facts.deprecated === undefined ? {} : { deprecated: facts.deprecated },
        ...compatibility === undefined || compatibility.exempted ? {} : { incompatible: incompatiblePlugin(compatibility) },
      }
      return { status: 'read' as const, version }
    }, answer => answer.status === 'refused')
    const versions: PluginVersion[] = []
    for (const answer of looked) {
      /* v8 ignore next -- a lookup stops the rest only by refusing, which returns below */
      if (answer === undefined) continue
      if (answer.status === 'refused') return { ...answer, attempts: [...listing.attempts.slice(0, -1), ...answer.attempts] }
      versions.push(answer.version)
    }
    return {
      status: 'listed', installed: target.installed, registry: listing.registry, attempts: listing.attempts,
      versions, omitted: newer.length - listed.length,
    }
  }

  /**
   * Replace an installed bundle with a newer version. A registry copy updates to `name@version`, checked on the registry
   * first: it must exist, declare a bundle, and accept the running DSH version, or nothing changes. A Git copy updates
   * to the Git spec `options.spec` names, which must pin a full commit of the repository directory the copy came from;
   * with HMR, a network failure or timeout reaching its repository stops the update before anything changes. pnpm reads
   * a Git package only while installing it, so its bundle and compatibility are checked then. Either target
   * installation is undone, profile files and modules included, before its bundle loads unless it installs `name` at
   * `version`. With HMR the installed version is removed, so its plugins stop, and the target is installed with the same
   * selection; when that installation fails or is cancelled, the removed version is installed again: a registry copy
   * from the registry it came from, a Git copy from its saved spec. Without HMR the target is installed over the running
   * version and the result reports the restart.
   * @param name Installed profile dependency name.
   * @param version Exact version newer than the installed one.
   * @param options The registry asked first, as for `listVersions`; the Git spec of `version`, required for and accepted
   * only by a bundle `listBundles` lists with `update: 'git'`; and the request id naming the progress and the target
   * installation's logs and cancellation.
   * @returns The versions, the last step that ran with its result, and the reinstallation when one ran.
   */
  @Remote
  async updateBundle(name: string, version: string, options?: UpdateBundleOptions): Promise<PluginUpdateResult> {
    const requestId = options?.requestId
    const announce = (step: PluginUpdateStep): void => {
      if (requestId !== undefined) this.ownerContext.emit('plugin-manager/update-state', { requestId, step })
    }
    announce('checking')
    const target = updateRefusal((await this.listBundles()).find(item => item.name === name), name)
    const from = typeof target === 'string' ? '' : target.installed
    const refusedBefore = (error: ManagementError): PluginUpdateResult => ({
      from, to: version, step: 'check',
      result: { changed: false, application: 'failed', stage: 'install', target: name, error },
    })
    if (typeof target === 'string') return refusedBefore({ code: 'invalid-spec', diagnostic: target })
    const { bundle } = target
    if (semver.valid(version) === null || !semver.gt(version, from)) {
      return refusedBefore({ code: 'invalid-spec', diagnostic: `${version} is not a version newer than the installed ${from}` })
    }
    const planned = target.kind === 'git'
      ? this.planGitUpdate(name, target.origin, options)
      : await this.checkRegistryUpdate(name, version, options)
    if ('code' in planned) return refusedBefore(planned)
    const { spec, registry, saveExact } = planned
    const { enabled } = bundle
    // A lock timeout or disposal rejects instead of reporting; it reads as the failed step it is.
    const settled = (stage: ChangeResult['stage'], target: string, operation: Promise<ChangeResult>): Promise<ChangeResult> =>
      operation.catch((error: unknown) => ({ changed: false, application: 'failed', stage, target, error: managementError(error) }))
    const installTarget = (): Promise<ChangeResult> => settled('install', spec, this.installBundle(spec, {
      saveExact, enabled, expected: { name, version },
      ...registry === undefined ? {} : { registry }, ...requestId === undefined ? {} : { requestId },
    }))
    if (this.ownerContext.get('hmr') === undefined) {
      announce('installing')
      return { from, to: version, step: 'install', result: await installTarget() }
    }
    // A Git host that cannot be reached would fail the target and the reinstallation alike, so nothing is removed.
    const unreachable = target.kind === 'git' ? await this.gitHostUnreachable(spec) : undefined
    if (unreachable !== undefined) {
      return {
        from, to: version, step: 'check',
        result: {
          changed: false, application: 'failed', stage: 'install', target: name, failedAt: 'spec-host', packageResult: unreachable,
          error: { code: 'operation-error', diagnostic: unreachable.output },
        },
      }
    }
    // The removed version is installed again where it came from, else over the configured plan, as its removal asks.
    const previousRegistry = this.installedFrom.get(name)
    announce('removing')
    const removal = await settled('remove', name, this.removeBundle(name))
    if (removal.application === 'failed' || removal.application === 'cancelled') return { from, to: version, step: 'remove', result: removal }
    announce('installing')
    const result = await installTarget()
    if (result.application !== 'failed' && result.application !== 'cancelled') return { from, to: version, step: 'install', result }
    announce('restoring')
    // A target that installed but failed to start is still a dependency; it goes before the removed version returns.
    if (result.stage === 'enable') await settled('remove', name, this.removeBundle(name))
    // The reinstallation carries no request id, so cancelling the update cannot leave the package removed.
    const previous = target.kind === 'git' ? target.source : `${name}@${from}`
    const restore = await settled('install', previous, this.installBundle(previous, {
      saveExact, enabled, ...previousRegistry === undefined ? {} : { registry: previousRegistry },
    }))
    return { from, to: version, step: 'install', result, restore }
  }

  /**
   * The target of a Git copy's update: the caller's Git spec, pinned to a full commit of the copy's repository directory.
   * @param name The package name.
   * @param origin The repository directory the installed copy pins.
   * @param options The caller's spec and registry.
   * @returns The spec and the registry its dependencies are asked from first, or why the update is refused.
   */
  private planGitUpdate(name: string, origin: string, options: UpdateBundleOptions | undefined): UpdatePlan | ManagementError {
    const spec = options?.spec
    const pinned = spec === undefined ? undefined : pinnedGitOrigin(spec)
    if (spec === undefined || pinned === undefined) {
      return { code: 'invalid-spec', diagnostic: `${name} is installed from Git and updates only to a Git spec pinned to a full commit` }
    }
    if (pinned !== origin) {
      return { code: 'invalid-spec', diagnostic: `${spec} is not in the repository directory ${name} is installed from, ${origin}` }
    }
    return { spec, registry: this.registryFor(name, options?.registry), saveExact: false }
  }

  /**
   * Check that the network reaches the repository of a Git update's target. Only a network failure or a timeout
   * counts: a check Git cannot run, or one the repository refuses without credentials, leaves the answer to pnpm.
   * @param spec The target's pinned Git spec.
   * @returns The failed check, or undefined when the host answered or the check could not tell.
   */
  private async gitHostUnreachable(spec: string): Promise<PackageResult | undefined> {
    const parsed = parseInstallSpec(spec)
    /* v8 ignore next -- planGitUpdate accepts only a pinned Git spec */
    if (parsed.kind !== 'git') return undefined
    const env = this.profile.packageManager?.env === undefined ? {} : { env: this.profile.packageManager.env }
    const check = checkGitConnection(parsed, this.profile.dir, {
      timeoutMs: this.githubConnectionTimeoutMs, outputBytes: this.outputBytes, signal: this.abort.signal, ...env,
    })
    this.packageOperations.add(check)
    let failure: GithubConnectionFailure | undefined
    try { failure = await check } finally { this.packageOperations.delete(check) }
    this.abort.signal.throwIfAborted()
    if (failure?.kind !== 'network' && failure?.kind !== 'timeout') return undefined
    // The answer keeps a plain PackageResult; the check's command line stays out of the wire fields.
    const { argv: _argv, ...packageResult } = failure
    return packageResult
  }

  /**
   * Check a registry copy's update target on the registry plan before anything changes.
   * @param name The package name.
   * @param version The target version.
   * @param options The caller's registry, as for `listVersions`; a spec is refused.
   * @returns The exact spec and the registry that answered for it, or why the target cannot replace the bundle.
   */
  private async checkRegistryUpdate(
    name: string, version: string, options: UpdateBundleOptions | undefined,
  ): Promise<UpdatePlan | ManagementError> {
    const spec = `${name}@${version}`
    if (options?.spec !== undefined) return { code: 'invalid-spec', diagnostic: `${name} is installed from a registry and updates only to ${spec}` }
    const plan = registryPlan(this.registryFor(name, options?.registry), await this.registries())
    const checked = await this.askRegistries(spec, VERSION_FIELDS, plan, { kind: 'registry', spec, name })
    if (checked.status === 'refused') return { code: 'operation-error', diagnostic: checked.reason }
    const facts = versionFacts(checked.answer, name, version)
    if (!facts.bundle) return { code: 'not-bundle' }
    let compatibility
    try { compatibility = evaluatePluginCompatibility(facts.manifest, readProfileVersionExemptions(this.profile.dir)) }
    catch (error) { return { code: 'operation-error', diagnostic: messageOf(error) } }
    if (compatibility !== undefined && !compatibility.exempted) return { code: 'incompatible-version', incompatible: [incompatiblePlugin(compatibility)] }
    return { spec, registry: checked.registry, saveExact: true }
  }

  /**
   * The registry a version listing or an update asks first.
   * @param name The package name.
   * @param requested The caller's registry, when it named one.
   * @returns The requested registry, else the one this process last installed the package from, else undefined for the configured one.
   */
  private registryFor(name: string, requested: Registry | undefined): Registry | undefined {
    return requested !== undefined ? requested : this.installedFrom.get(name)
  }

  /**
   * Ask registries in turn through `pnpm view`, moving to the next one while a failure is the registry's: unreachable,
   * timed out, or without the package or version, which a mirror not yet synced reports.
   * @param spec The registry spec viewed.
   * @param fields The manifest fields printed.
   * @param plan The registries, in order; never empty.
   * @param parsed The spec's form, which decides whether a failure was the registry's.
   * @param signal Ends the lookup; a dropped lookup is not carried to the next registry.
   * @returns The parsed answer and the registry that gave it, or the last refusal, with every registry asked.
   */
  private async askRegistries(
    spec: string, fields: readonly string[], plan: readonly Registry[], parsed: ParsedInstallSpec, signal?: AbortSignal,
  ): Promise<RegistryAnswer> {
    const attempts: RegistryAttempt[] = []
    for (const [index, registry] of plan.entries()) {
      const view = await viewProfilePackage(this.profile.dir, spec, {
        ...this.profile.packageManager ?? { command: this.pnpmCommand },
        fields, timeoutMs: this.inspectTimeoutMs, ...signal === undefined ? {} : { signal }, registry,
      })
      const printed = view.stdout.replace(ANSI_SEQUENCE, '').trim()
      if (view.exitCode !== 0 || view.cause !== undefined || view.timedOut) {
        // pnpm prints a refusal as `{ error: { code, message } }` on stdout, with nothing on stderr.
        const log = [view.stderr.trim(), printedError(printed), view.cause === undefined ? '' : messageOf(view.cause)].filter(Boolean).join('\n')
        const kind = classifyInstallFailure({ log, timedOut: view.timedOut, ...view.cause === undefined ? {} : { cause: view.cause } })
        const reason = view.timedOut ? `pnpm view timed out after ${String(this.inspectTimeoutMs)}ms` : log || printed || `pnpm view exited with ${String(view.exitCode)}`
        const problem = kind === 'not-found' || kind === 'no-matching-version' ? 'not-found' : kind === 'network' || kind === 'timeout' ? 'network' : 'unknown'
        attempts.push({ registry, problem, reason })
        if (index < plan.length - 1 && signal?.aborted !== true && attributeFailure(kind, log, parsed) === 'registry') continue
        return { status: 'refused', problem, reason, attempts }
      }
      try {
        const answer: unknown = JSON.parse(printed || 'null')
        attempts.push({ registry })
        return { status: 'answered', answer, registry, attempts }
      } catch (error) {
        const reason = `unreadable pnpm view output: ${messageOf(error)}`
        attempts.push({ registry, problem: 'unknown', reason })
        return { status: 'refused', problem: 'unknown', reason, attempts }
      }
    }
    /* v8 ignore next -- the plan is never empty: every attempt returns or continues to the next */
    throw new Error('no registry was asked')
  }

  /** Persist a plugin entry's desired enablement and apply it on live profiles.
   * @param id Loader entry identity returned by listPlugins.
   * @param enabled Whether the plugin should run.
   * @returns Saved and runtime outcomes, including higher-priority overrides.
   */
  @Remote
  setPluginEnabled(id: PluginEntryId, enabled: boolean): Promise<ChangeResult> {
    return this.change(result => this.configure(async () => {
      const row = (await this.listPlugins()).find(item => item.entryId === id)
      if (row === undefined) throw new ManagementFailure('unknown-plugin')
      if (row.readOnlyReason === 'management-required') throw this.protectionFailure([row.moduleName])
      if (row.readOnlyReason !== undefined) throw new ManagementFailure(row.readOnlyReason)
      await writePluginEnabled(this.profile, row.patchId, row.moduleName, enabled)
      Object.assign(result, await this.reload(enabled ? [row.patchId] : []))
      const current = (await this.listPlugins()).find(item => item.entryId === id)
      return current?.enabled !== enabled && this.ownerContext.get('hmr') !== undefined ? 'overridden' : undefined
    }), { stage: 'enable', target: id, enabled }, 'plugin', () => `${enabled ? 'Turned on' : 'Turned off'} ${id}`)
  }

  /** Select or remove a bundle layer while retaining installed dependencies.
   * @param name Bundle package name.
   * @param enabled Whether the bundle contributes its patch layer.
   * @returns Persisted and runtime outcomes.
   */
  @Remote
  setBundleEnabled(name: string, enabled: boolean): Promise<ChangeResult> {
    return this.change(result => this.configure(async () => {
      const audit = await this.selectBundle(name, enabled)
      // The findings an audit let the enablement go on with reach the person as an installation's do.
      if (audit !== undefined && audit.findings.length > 0) result.audit = audit
      Object.assign(result, enabled ? await this.publishAndReload(this.bundleRows(name).map(row => row.id)) : await this.reload())
    }), { stage: 'enable', target: name, enabled }, 'bundle', () => `${enabled ? 'Turned on' : 'Turned off'} ${name}`)
  }

  /**
   * Install a package using the same pnpm implementation as dsh plugin. GitHub
   * repositories get a connection check bounded by githubConnectionTimeoutMs before pnpm starts;
   * only network failures or timeouts stop installation, and a stop streams the check's diagnostic
   * as the installation's install-log run under its request id, while pnpm owns authentication and transport fallback. An
   * HTTP(S) Git URL on another host is installed over SSH instead when access probes bounded by gitTransportTimeoutMs
   * find that only SSH can read it. With a `pluginAudit` provider composed, pnpm first only resolves the package into
   * the lockfile, the audit answers with `pending: 'install'`, and only then pnpm installs the lockfile; without one the
   * installation is a single `pnpm add`. A run
   * that fails, is cancelled, or adds a package without a bundle patch restores
   * `package.json` and `pnpm-lock.yaml` as they were; downloaded files can stay.
   * @param spec One package spec, including local paths relative to the invocation directory.
   * @param options Whether to activate the installed bundle (defaults to true), the request id a cancellation names,
   * the pending build scripts to allow, whether to save an exact dependency, and the registry asked first.
   * @returns Package-manager diagnostics, the registries asked, and the observed activation outcome.
   */
  @Remote
  installBundle(spec: string, options?: InstallBundleOptions): Promise<ChangeResult> {
    const requestId = options?.requestId
    const control: InstallControl = { abort: new AbortController(), phase: 'installing', result: Promise.resolve(null) }
    const stopped = (): boolean => control.abort.signal.aborted || this.abort.signal.aborted
    if (requestId !== undefined) this.installs.set(requestId, control)
    const announce = (phase: PluginInstallProgress['phase'], attempt?: PluginInstallProgress['attempt']): void => {
      if (requestId !== undefined) this.ownerContext.emit('plugin-manager/install-state', { requestId, phase, ...attempt === undefined ? {} : { attempt } })
    }
    const result = this.change(async (result) => {
      if (spec.trim() === '' || spec.startsWith('-')) throw new ManagementFailure('invalid-spec')
      if (stopped()) throw new InstallCancelledError()
      const before = readProfileManifest('dsh', this.profile.dir).dependencies ?? {}
      // With HMR, an installed package is removed before another version is installed, so its plugins stop first.
      const known = specPackageName(spec, before, this.profile.dir)
      // A package the release publishes as a signed pack installs only from its pack folder, never from a registry or another source.
      const packs = this.ownerContext.get('packInstallTargets')
      if (known !== undefined && packs !== undefined) await this.requirePackFolder(packs, known, spec)
      const provided = known === undefined ? [] : this.providedProtected(known)
      if (provided.length > 0) throw this.protectionFailure(provided)
      if (this.ownerContext.get('hmr') !== undefined && known !== undefined && Object.hasOwn(before, known)) {
        throw new ManagementFailure('already-installed')
      }
      const rows = this.currentRows()
      if (options?.approvedBuilds !== undefined) {
        await approveBuilds(this.profile.dir, options.approvedBuilds)
        result.approvedBuilds = options.approvedBuilds
      }
      const files = await this.readRestoredFiles()
      // Read once, so the resolution and the installation below take the same path for the whole installation.
      const audited = this.ownerContext.get('pluginAudit') !== undefined
      // With plugin packs composed, the package's name is read from a resolution that runs no script, as an audit's is.
      const guarded = packs !== undefined
      const twoPhase = audited || guarded
      let name: string
      let version: string | undefined
      try {
        result.registries = []
        const parsed = parsedForRegistry(spec)
        const signal = AbortSignal.any([this.abort.signal, control.abort.signal])
        const env = this.profile.packageManager?.env === undefined ? {} : { env: this.profile.packageManager.env }
        const connection = checkGithubConnection(parsed, this.profile.dir, {
          timeoutMs: this.githubConnectionTimeoutMs, outputBytes: this.outputBytes, signal, ...env,
        })
        this.packageOperations.add(connection)
        let connectionFailure: GithubConnectionFailure | undefined
        try { connectionFailure = await connection }
        finally { this.packageOperations.delete(connection) }
        if (stopped()) throw new InstallCancelledError()
        if (connectionFailure?.kind === 'network' || connectionFailure?.kind === 'timeout') {
          // The answer keeps a plain PackageResult; the check's command line is only streamed as the run below.
          const { argv, ...packageResult } = connectionFailure
          result.packageResult = packageResult
          result.failedAt = 'spec-host'
          // pnpm never runs, so the check is the installation's only run: stream its failure into the install log.
          // A timed-out Git reports no exit code of its own, unlike the result, which records the status it is read as.
          if (requestId !== undefined) {
            this.ownerContext.emit('plugin-manager/install-log', {
              requestId, jobId: randomUUID(), argv, cwd: this.profile.dir, stream: 'stderr',
              text: connectionFailure.output, exitCode: connectionFailure.timedOut === true ? null : connectionFailure.exitCode,
            })
          }
          throw new Error(connectionFailure.output)
        }
        const transport = chooseGitTransport(parsed, this.profile.dir, { timeoutMs: this.gitTransportTimeoutMs, signal, ...env })
        this.packageOperations.add(transport)
        let installSpec: string
        try { installSpec = await transport }
        finally { this.packageOperations.delete(transport) }
        if (stopped()) throw new InstallCancelledError()
        // The last run is the result's; the registries asked stay listed whatever the outcome.
        const plan = registryPlan(options?.registry, await this.registries())
        let run: PackageResult | undefined
        let used: Registry = null
        for (const [index, registry] of plan.entries()) {
          if (index > 0) await this.restoreFiles(files)
          // A stop that landed while the files went back, or before the first run, starts no run with a dead signal.
          if (stopped()) throw new InstallCancelledError()
          result.registries.push(registry)
          used = registry
          announce('installing', { registry, index: index + 1, total: plan.length })
          // With an audit, resolution only: no file is fetched into the profile and no script runs until it answered;
          // pnpm runs an approved git dependency's `prepare` even while it only resolves, unless scripts are ignored.
          // The expected package is checked on the run that installs it, so a resolution-only run carries no `expected`.
          const resolveOnly = twoPhase ? ['--lockfile-only', '--ignore-scripts'] : []
          run = await this.runPnpm(
            ['add', installSpec, ...resolveOnly, ...options?.saveExact === true ? ['--save-exact'] : [], ...registryArguments(registry)],
            control.abort.signal, requestId, twoPhase || options?.expected === undefined ? {} : { expected: options.expected },
          )
          result.packageResult = run
          if (stopped()) throw new InstallCancelledError()
          // A compatibility refusal is the package's own answer, so no other registry is asked.
          if (run.incompatible !== undefined) throw new ManagementFailure('incompatible-version', run.incompatible)
          // So is a run that installed another package, version, or no bundle where the caller expects one.
          if (run.unmet !== undefined) throw new ManagementFailure(run.unmet)
          // A run this manager terminated is not a success, even when pnpm trapped the signal and exited 0.
          if (run.exitCode === 0 && run.timedOut !== true) break
          /* v8 ignore next 2 -- runPnpm classifies every run it does not report as succeeded */
          if (run.kind === undefined) break
          // What the last failed run could not reach; a later run that succeeds leaves nothing to say.
          delete result.failedAt
          // A run this manager terminated got no answer from the registry at all, so no registry explains it.
          if (run.timedOut === true) break
          const failedAt = attributeFailure(run.kind, run.output, parsedForRegistry(installSpec))
          if (failedAt !== 'other') result.failedAt = failedAt
          if (failedAt !== 'registry' || index === plan.length - 1) break
        }
        /* v8 ignore next -- the plan is never empty, so a run always settled */
        if (run === undefined) throw new Error('no registry was asked')
        // A terminated run reports no usable exit status, so neither its files nor its bundle are trusted.
        const succeeded = run.exitCode === 0 && run.timedOut !== true
        if (succeeded) delete result.failedAt
        if (!succeeded) {
          // pnpm-workspace.yaml is not restored, so the names it left undecided, or reported as blocked, are offered for approval.
          try { result.pendingBuilds = await recordPendingBuilds(this.profile.dir, run.output) }
          catch (error) {
            this.ownerContext.logger.warn('Could not read pending build approvals after pnpm failed', error)
          }
          throw new Error(run.output)
        }
        const after = readProfileManifest('dsh', this.profile.dir).dependencies ?? {}
        const installed = Object.keys(after).filter(name => before[name] !== after[name])
        // Without HMR a repeated installation can leave the saved dependency as it was.
        if (installed.length === 0) {
          const local = specPackageName(spec, after, this.profile.dir)
          if (local !== undefined && Object.hasOwn(after, local)) installed.push(local)
        }
        const target = installed[0]
        if (installed.length !== 1 || target === undefined) throw new ManagementFailure('ambiguous-install')
        name = target
        const providedByTarget = this.providedProtected(name)
        if (providedByTarget.length > 0) throw this.protectionFailure(providedByTarget)
        // Whatever source the spec named, a package the release publishes as a pack installs only from its pack folder.
        // The resolution ran no script and fetched nothing, so a refusal here leaves the files as they were.
        if (packs !== undefined) await this.requirePackFolder(packs, name, spec)
        if (twoPhase) {
          // The lockfile names what will be installed; a refusal here leaves nothing fetched and no script run.
          if (audited) await this.auditBundle(name, join(this.profile.dir, 'node_modules', name), undefined, options?.acceptedAudit, 'install', result.registries)
          const fetched = await this.runPnpm(['install', '--frozen-lockfile', ...registryArguments(used)], control.abort.signal, requestId, {
            baseline: { manifest: files.get(join(this.profile.dir, 'package.json')), lockfile: files.get(join(this.profile.dir, 'pnpm-lock.yaml')) },
            ...options?.expected === undefined ? {} : { expected: options.expected },
          })
          result.packageResult = fetched
          if (stopped()) throw new InstallCancelledError()
          if (fetched.incompatible !== undefined) throw new ManagementFailure('incompatible-version', fetched.incompatible)
          if (fetched.unmet !== undefined) throw new ManagementFailure(fetched.unmet)
          if (fetched.exitCode !== 0 || fetched.timedOut === true) {
            // The build scripts pnpm reported as blocked are offered for approval, as for a failed resolution.
            try { result.pendingBuilds = await recordPendingBuilds(this.profile.dir, fetched.output) }
            catch (error) {
              this.ownerContext.logger.warn('Could not read pending build approvals after pnpm failed', error)
            }
            throw new Error(fetched.output)
          }
        }
        const dir = resolveBundleDir('dsh', name, this.profile.installAnchor, this.profile.dir)
        const manifest = bundleManifest(name, this.profile.dir, this.profile.installAnchor)
        if (manifest?.dsh?.bundle === undefined) throw new ManagementFailure('not-bundle')
        const compatibility = evaluatePluginCompatibility(manifest, readProfileVersionExemptions(this.profile.dir))
        if (compatibility !== undefined && !compatibility.exempted) throw new ManagementFailure('incompatible-version', [incompatiblePlugin(compatibility)])
        // Every installation is audited, enabled or not, so the user reads the findings where they chose the package.
        const audit = await this.auditBundle(name, dir, manifest.version, options?.acceptedAudit)
        if (audit !== undefined && audit.findings.length > 0) result.audit = audit
        if (audit?.decision === 'accepted' && options?.acceptedAudit === audit.digest) await acceptAudit(this.profile.dir, name, audit.digest)
        for (const file of bundlePatchPaths(dir, manifest.dsh.bundle)) loadOverlayPatches('dsh', file)
        // The bundle's patch, and a replaced package's, must leave every protected row as it was.
        this.assertProtectedRowsKept(rows, this.composedRows(options?.enabled === false ? undefined : name))
        version = manifest.version
        this.installedFrom.set(name, used)
      } catch (error) {
        // pnpm has exited by now, so the files it rewrote go back as they were.
        await this.restoreFiles(files)
        throw error
      }
      control.phase = 'applying'
      announce('applying')
      result.bundle = name
      if (version !== undefined) result.version = version
      result.target = name
      result.stage = 'enable'
      return this.configure(async () => {
        if (options?.enabled !== false) await this.selectBundle(name, true)
        // Without HMR the replaced package's plugins keep running until the restart the result already reports.
        if (Object.hasOwn(before, name) && this.ownerContext.get('hmr') === undefined) return
        // A selected bundle's own rows must start.
        const selected = bundleSelection(readProfileManifest('dsh', this.profile.dir)).includes(name)
        Object.assign(result, await this.publishAndReload(selected ? this.bundleRows(name).map(row => row.id) : []))
      })
    }, { stage: 'install', target: spec, enabled: options?.enabled !== false }, 'install', result => `Installed ${result.bundle ?? spec}`)
    control.result = result
    return result.finally(() => { if (requestId !== undefined) this.installs.delete(requestId) })
  }

  /** Recover the result of an active installation without cancelling it.
   * @param requestId The id supplied when installation started.
   * @returns The installation's outcome after it settles, or null if no active request has that id.
   * Completed results are not retained; null establishes neither success nor cancellation.
   */
  @Remote
  async waitForInstall(requestId: PluginInstallRequestId): Promise<ChangeResult | null> {
    return this.installs.get(requestId)?.result ?? null
  }

  /** Stop an installation this manager owns and wait until its files are back.
   * @param requestId The id the installation was started with.
   * @returns `cancelled` once the Git check or pnpm exited and the files are restored, `too-late` once the bundle is being
   * applied, `not-running` for any other id.
   */
  @Remote
  async cancelInstall(requestId: PluginInstallRequestId): Promise<PluginInstallCancellation> {
    const control = this.installs.get(requestId)
    if (control === undefined) return { status: 'not-running' }
    if (control.phase === 'applying') return { status: 'too-late' }
    this.ownerContext.emit('plugin-manager/install-state', { requestId, phase: 'cancelling' })
    control.abort.abort()
    /* v8 ignore next -- change() folds every failure into its result; only a lock or disposal error rejects */
    await control.result.then(() => undefined, () => undefined)
    return { status: 'cancelled' }
  }

  /** Unload and remove a profile-owned bundle dependency through dsh plugin's pnpm path; a selected name no
   * dependency holds is only deselected.
   * @param name Installed dependency or selected bundle name.
   * @returns Removal diagnostics and the remaining profile state.
   */
  @Remote
  removeBundle(name: string): Promise<ChangeResult> {
    return this.change(async (result) => {
      const installed = await this.configure(async () => {
        const bundle = (await this.listBundles()).find(item => item.name === name)
        if (bundle === undefined || !bundle.removable) throw new ManagementFailure('not-removable')
        if (this.ownerContext.get('hmr') === undefined && (this.profile.startedBundles.includes(name)
          || (bundle.error === undefined && this.bundleRows(name).some(row => [...this.ctx.loader.entries()]
            .some(entry => entry.options.id === row.id && entry.fiber !== undefined))))) {
          throw new ManagementFailure('stop-profile')
        }
        const contributions = bundle.error === undefined ? this.bundleRows(name) : []
        if (bundle.enabled) {
          await this.selectBundle(name, false)
          Object.assign(result, await this.reload())
        }
        if ([...this.ctx.loader.entries()].some(entry => entry.fiber?.uid != null
          && contributions.some(row => row.id === entry.options.id && row.name === entry.options.name))) {
          throw new ManagementFailure('bundle-in-use')
        }
        return bundle.installed
      })
      if (!installed) return
      // `pnpm remove` takes no `--registry` option; the generic configuration flag sets the same setting. A package
      // installed before this process started is removed with the registry an installation asks first.
      const registry = this.installedFrom.has(name) ? this.installedFrom.get(name) : this.configuredRegistries.registry
      result.packageResult = await this.runPnpm(['remove', name, ...typeof registry === 'string' ? [`--config.registry=${registry}`] : []])
      if (result.packageResult.exitCode !== 0 || result.packageResult.timedOut === true) {
        throw new Error(result.packageResult.output)
      }
      this.installedFrom.delete(name)
      Object.assign(result, await this.configure(() => this.publishAndReload()))
    }, { stage: 'remove', target: name }, 'remove', () => `Removed ${name}`)
  }

  /** The rows a bundle's patch inserts and the existing rows it changes; an unreadable patch throws. */
  private declaredRows(name: string, info: ProfileManifest): Pick<BundleInfo, 'rows' | 'overrides'> {
    const bundle = info.dsh?.bundle
    /* v8 ignore next -- bundleManifest answers only manifests that declare a patch */
    if (bundle === undefined) return { rows: [], overrides: [] }
    const dir = resolveBundleDir('dsh', name, this.profile.installAnchor, this.profile.dir)
    const patches: PatchOptions[] = bundlePatchPaths(dir, bundle).flatMap(file => loadOverlayPatches('dsh', file))
    // One entry per row id: the Loader keeps a single entry for an id, whichever layer declared it last.
    const live = new Map<string, { entryId: PluginEntryId; baseUrl: string | undefined }>()
    for (const entry of this.ctx.loader.entries()) {
      /* v8 ignore next -- the Loader gives every entry an id before it is listed */
      if (typeof entry.options.id === 'string') live.set(entry.options.id, {
        entryId: pluginEntryId(entry.id), baseUrl: entry.parent.tree.ctx.baseUrl,
      })
    }
    const rows: BundleRowInfo[] = []
    const packages = this.ctx.get('pluginPackages')
    for (const row of flatten(composeEntries([patches.filter(item => item.insert !== undefined)]))) {
      // Group rows are containers without a plugin inventory entry; their children carry the switches.
      if (typeof row.id !== 'string' || typeof row.name !== 'string' || row.group === true) continue
      const active = live.get(row.id)
      const entryId = active?.entryId
      const base = active?.baseUrl ?? pathToFileURL(join(dir, 'package.json')).href
      const meta = packages?.metaOf(row.name, base)
      rows.push({ rowId: row.id, moduleName: row.name,
        ...entryId === undefined ? {} : { entryId }, ...meta === undefined ? {} : { meta } })
    }
    const declared = new Set(rows.map(row => row.rowId))
    const overrides = [...new Set(patches.flatMap(item =>
      item.insert === undefined && typeof item.id === 'string' && !declared.has(item.id) ? [item.id] : []))]
    return { rows, overrides }
  }

  /**
   * Run one pnpm command in the profile, streaming its output as install-log chunks. `baseline` is the profile's files
   * from before an earlier resolution-only run, as the package operation takes it; `expected` is the package an `add`
   * or an install must leave installed.
   */
  private async runPnpm(
    args: readonly string[], signal?: AbortSignal, requestId?: PluginInstallRequestId,
    checks: { readonly baseline?: ProfileBaseline; readonly expected?: InstallBundleOptions['expected'] } = {},
  ): Promise<PackageResult> {
    const jobId = randomUUID()
    const argv = ['pnpm', ...args]
    const cwd = this.profile.dir
    const identity = requestId === undefined ? {} : { requestId }
    const task = runProfilePnpm({ ...this.profile, profile: this.profile.name }, args, {
      execution: 'service', ...this.profile.packageManager ?? { command: this.pnpmCommand },
      signal: signal === undefined ? this.abort.signal : AbortSignal.any([this.abort.signal, signal]),
      outputBytes: this.outputBytes, activateNewBundles: false, idleTimeoutMs: this.idleTimeoutMs,
      lookupTimeoutMs: this.inspectTimeoutMs,
      ...checks.baseline === undefined ? {} : { baseline: checks.baseline },
      ...checks.expected === undefined ? {} : { expected: checks.expected },
      onOutput: (text, stream) => {
        this.ownerContext.emit('plugin-manager/install-log', { ...identity, jobId, argv, cwd, stream, text })
      },
    })
    this.packageOperations.add(task)
    try {
      const result = await task
      this.ownerContext.emit('plugin-manager/install-log', {
        ...identity, jobId, argv, cwd, stream: 'stdout', text: '', exitCode: signal?.aborted === true ? null : result.exitCode,
      })
      // A terminated run keeps its own kind even when pnpm trapped the signal and exited 0.
      if (result.exitCode === 0 && result.timedOut !== true) return result
      return {
        ...result,
        kind: classifyInstallFailure({ log: result.output, ...result.timedOut === true ? { timedOut: true } : {} }),
      }
    } catch (error) {
      this.ownerContext.emit('plugin-manager/install-log', { ...identity, jobId, argv, cwd, stream: 'stderr', text: messageOf(error), exitCode: null })
      throw error
    } finally {
      this.packageOperations.delete(task)
    }
  }

  /** The profile files an installation may rewrite, as they are now; absent files read as undefined. */
  private async readRestoredFiles(): Promise<Map<string, string | undefined>> {
    const files = new Map<string, string | undefined>()
    for (const name of RESTORED_FILES) {
      const path = join(this.profile.dir, name)
      files.set(path, existsSync(path) ? await readFile(path, 'utf8') : undefined)
    }
    return files
  }

  /** Put the profile files back; pnpm has exited by the time this runs. */
  private async restoreFiles(files: Map<string, string | undefined>): Promise<void> {
    for (const [path, content] of files) {
      if (content === undefined) await rm(path, { force: true })
      else await writeFileAtomic(path, content, { mode: 0o600 })
    }
  }

  /**
   * Ask the distribution's plugin audit about a bundle's package, with the digests the user accepted for it and the one
   * this call accepts, what the change has yet to do for it, and the registries an installation asked; a distribution
   * without one audits nothing.
   * @returns The audit, or undefined without one.
   * @throws ManagementFailure `audit-refused` or `audit-findings` when the audit refuses the change.
   */
  private async auditBundle(
    name: string, dir: string, version: string | undefined, accepting?: string, pending?: 'install' | 'scripts',
    registries?: Registry[],
  ): Promise<PluginAuditResult | undefined> {
    const audit = this.ownerContext.get('pluginAudit')
    if (audit === undefined) return undefined
    const accepted = [...await acceptedAudits(this.profile.dir, name), ...accepting === undefined ? [] : [accepting]]
    const result = await audit.audit({
      name, ...version === undefined ? {} : { version }, dir, accepted, ...pending === undefined ? {} : { pending },
      ...registries === undefined ? {} : { registries: [...registries] },
    })
    switch (result.decision) {
      case 'clear':
      case 'accepted':
        return result
      case 'refused': throw new ManagementFailure('audit-refused', undefined, undefined, result)
      case 'needs-acceptance': throw new ManagementFailure('audit-findings', undefined, undefined, result)
      /* v8 ignore next -- PluginAuditDecision is a closed union */
      default: return assertNever(result.decision)
    }
  }

  /** Select or deselect a bundle; returns what the plugin audit answered for an enablement it let go on. */
  private async selectBundle(name: string, enabled: boolean): Promise<PluginAuditResult | undefined> {
    const manifest = readProfileManifest('dsh', this.profile.dir)
    const previous = bundleSelection(manifest)
    let audit: PluginAuditResult | undefined
    if (enabled || !previous.includes(name)) {
      const metadata = bundleManifest(name, this.profile.dir, this.profile.installAnchor)
      if (metadata === undefined) throw new ManagementFailure('not-bundle')
      if (enabled) {
        assertBundlePlatform(metadata.dsh?.bundle?.platforms, process.platform)
        const compatibility = evaluatePluginCompatibility(metadata, readProfileVersionExemptions(this.profile.dir))
        if (compatibility !== undefined && !compatibility.exempted) throw new ManagementFailure('incompatible-version', [incompatiblePlugin(compatibility)])
        audit = await this.auditBundle(name, resolveBundleDir('dsh', name, this.profile.installAnchor, this.profile.dir), metadata.version)
        if (!previous.includes(name)) this.assertProtectedRowsKept(this.currentRows(), this.composedRows(name))
      }
    }
    if (!enabled && previous.includes(name)) {
      if (this.protectsManager(name)) throw this.bundleRefusal(name)
    }
    const bundles = enabled ? [...previous, ...previous.includes(name) ? [] : [name]] : previous.filter(item => item !== name)
    if (JSON.stringify(previous) === JSON.stringify(bundles)) return audit
    manifest.dsh = { ...manifest.dsh, profile: { ...manifest.dsh?.profile, bundles } }
    await saveManifest(this.profile.dir, manifest)
    if (enabled) this.protectsManager(name)
    return audit
  }

  private bundleRows(name: string): EntryOptions[] {
    return flatten(composeEntries([this.bundleLayer(name)?.patches ?? []]))
  }

  /** A bundle's patch layer, as the profile loader reads it; `undefined` for a package that declares no bundle. */
  private bundleLayer(name: string): ProfileLayer | undefined {
    const info = bundleManifest(name, this.profile.dir, this.profile.installAnchor)
    if (info?.dsh?.bundle === undefined) return undefined
    const packageDir = resolveBundleDir('dsh', name, this.profile.installAnchor, this.profile.dir)
    const patchPaths = bundlePatchPaths(packageDir, info.dsh.bundle)
    return { packageName: name, packageDir, patchPaths, patches: patchPaths.flatMap(file => loadOverlayPatches('dsh', file)) }
  }

  /**
   * The profile's composed rows as its files give them now, the profile patch, home patch and overlays included.
   * @param selecting - a bundle to compose as if it were selected after the others.
   */
  private composedRows(selecting?: string): EntryOptions[] {
    const loaded = loadProfileDirectory('dsh', this.profile.dir, this.profile.installAnchor)
    const selected = selecting === undefined || loaded.layers.some(layer => layer.packageName === selecting)
      ? []
      : [this.bundleLayer(selecting)]
    const layers = [...loaded.layers, ...selected.filter((layer): layer is ProfileLayer => layer !== undefined)]
    return flatten(composeEntries([readProfilePatches('dsh', this.profile, { ...loaded, layers })]))
  }

  /**
   * The composed rows a change is compared with: the profile files' composition, or, while those files do not compose,
   * the rows the root Include runs, which are the last composition the profile applied.
   */
  private currentRows(): EntryOptions[] {
    try { return this.composedRows() } catch (_error) {
      // A profile that does not compose runs its last applied composition; an undo or a restore may repair the files.
    }
    const root = [...this.ctx.loader.entries()].find(entry => entry.id === 'include')
    /* v8 ignore next -- the root Include runs while the manager does; without its patches no row is current,
       so every protected row of the change is refused */
    return flatten(composeEntries([(root?.options.config as { patches?: PatchOptions[] } | undefined)?.patches ?? []]))
  }

  /** Whether the manager protects a composed row: by its module, or as the manager's own entry. */
  private protectsRow(row: EntryOptions): boolean {
    return this.protectedPlugins.has(row.name) || `include:${row.id}` === this.ownerEntryId
  }

  /** The protected module names a package provides. */
  private providedProtected(packageName: string): string[] {
    return [...this.protectedPlugins].filter(name => packageOf(name) === packageName)
  }

  /**
   * Refuse a change whose composed rows differ from the current ones under the id of a protected row: a protected row
   * dropped, replaced, reconfigured, disabled or enabled, a row of a protected module added, or another row given the
   * id of one, which the Loader would mount beside or instead of it.
   * @param before - the composed rows before the change.
   * @param after - the composed rows the change would give.
   * @throws ManagementFailure `management-required` naming the modules of the rows it changes.
   */
  private assertProtectedRowsKept(before: readonly EntryOptions[], after: readonly EntryOptions[]): void {
    const ids = new Set([...before, ...after].filter(row => this.protectsRow(row)).map(row => row.id))
    const changed = [...ids].flatMap((id) => {
      const [was, now] = [before.filter(row => row.id === id), after.filter(row => row.id === id)]
      return isDeepStrictEqual(was, now) ? [] : [...was, ...now].map(row => row.name)
    })
    if (changed.length > 0) throw this.protectionFailure(changed)
  }

  /**
   * Refuse a change that takes away a version exemption of a package that provides a protected module or is a
   * management bundle: without it, the package's version check stops the guard at the next reevaluation, as disabling
   * its row would.
   * @param before - the exemptions before the change, by `name@version`.
   * @param after - the exemptions the change would leave.
   * @throws ManagementFailure `management-required` naming the protected modules the package provides.
   */
  private assertProtectedExemptionsKept(
    before: Readonly<Record<string, readonly string[]>>, after: Readonly<Record<string, readonly string[]>>,
  ): void {
    const lost = Object.entries(before).flatMap(([key, runtimes]) => {
      const name = key.slice(0, key.lastIndexOf('@'))
      const kept = after[key] ?? []
      return runtimes.some(runtime => !kept.includes(runtime)) && this.protectsManager(name) ? [name] : []
    })
    if (lost.length > 0) throw this.protectionFailure(lost.flatMap(name => this.providedProtected(name)))
  }

  /**
   * The `management-required` refusal for changing protected modules. When some of them only `protectedPlugins` lists,
   * its diagnostic names those, so a caller can say the profile protects them rather than plugin management needing them.
   */
  private protectionFailure(moduleNames: readonly string[]): ManagementFailure {
    const configured = [...new Set(moduleNames.filter(name => !PROTECTED_PLUGINS.has(name) && this.protectedPlugins.has(name)))]
    return new ManagementFailure('management-required', undefined, configured.length === 0 ? undefined : `protected by this profile: ${configured.join(', ')}`)
  }

  /** The refusal for deselecting or removing a management bundle, naming the protected modules it carries or provides. */
  private bundleRefusal(name: string): ManagementFailure {
    let rows: EntryOptions[] = []
    try { rows = this.bundleRows(name) } catch (_error) {
      // An unreadable management bundle names no rows; its refusal names what the package provides.
    }
    return this.protectionFailure([...rows.filter(row => this.protectsRow(row)).map(row => row.name), ...this.providedProtected(name)])
  }

  private protectsManager(name: string): boolean {
    if (this.managementBundles.has(name)) return true
    let rows: EntryOptions[] = []
    try { rows = this.bundleRows(name) } catch (_error) {
      // Unreadable bundles contribute no new rows; listBundles reports their diagnostics.
    }
    const protectedBundle = this.providedProtected(name).length > 0 || rows.some(row => this.protectsRow(row))
    if (protectedBundle) this.managementBundles.add(name)
    return protectedBundle
  }

  private configure<T>(operation: () => Promise<T>): Promise<T> {
    const hmr = this.ownerContext.get('hmr')
    const apply = () => { this.abort.signal.throwIfAborted(); return operation() }
    return hmr === undefined ? apply() : hmr.runExclusive(apply)
  }

  /**
   * Publish the profile's runtime resolution without HMR, unless a deselected startup bundle still runs and needs the
   * current table. A publication that needs a restart waits for the restart the result already reports.
   */
  private async refreshPackages(): Promise<void> {
    const selected = bundleSelection(readProfileManifest('dsh', this.profile.dir))
    if (this.profile.startedBundles.some(name => !selected.includes(name))) return
    try {
      const packages = this.ownerContext.get('pluginPackages')
      // A dropped mapping's bundle is not running: the guard above keeps the table while a deselected startup bundle runs.
      if (packages?.resolution !== undefined) await packages.refresh()
    } catch (error) {
      if (!(error instanceof ResolutionRestartRequired)) throw error
    }
  }

  /**
   * Apply a package change: without HMR, publish the runtime resolution when that is safe, then {@link reload}.
   * @param requiredIds Entry ids that must start.
   * @returns The reload's outcome.
   */
  private async publishAndReload(requiredIds: readonly string[] = []): Promise<Reload> {
    if (this.ownerContext.get('hmr') === undefined) await this.refreshPackages()
    return this.reload(requiredIds)
  }

  /**
   * Apply the saved profile; with HMR it recomposes live, including the runtime resolution.
   * @param requiredIds Entry ids that must start.
   * @returns Warnings about entries that were already inactive, and why the change waits for a restart, if it does.
   */
  private async reload(requiredIds: readonly string[] = []): Promise<Reload> {
    const hmr = this.ownerContext.get('hmr')
    if (hmr === undefined) {
      // Startup-only profiles recompose at restart; the saved patches still have to compose.
      composeEntries([readProfilePatches('dsh', this.profile)])
      return { warnings: [] }
    }
    const { warnings, pending, restartReason } = await hmr.reconcileProfile(requiredIds)
    const restart = restartReason ?? pending[0]?.reason
    return restart === undefined ? { warnings } : { warnings, restartReason: restart }
  }

  /** Who is making a change: the Agent whose tool call it runs in, by its Session, or else the person. */
  private changedBy(): ProfileChangedBy {
    const agent = this.ctx.get('agents')?.currentInitiator()
    return agent === undefined ? { kind: 'person' } : { kind: 'agent', sessionId: agent.session.id }
  }

  private async change(
    operation: (result: ChangeResult) => Promise<ChangeResult['application'] | void>,
    request: Pick<ChangeResult, 'stage' | 'target' | 'enabled'>,
    reason: PluginChange['reason'],
    summary: (result: ChangeResult) => string,
    identity?: Pick<PluginOperation, 'target' | 'version'>,
  ): Promise<ChangeResult> {
    const id = randomUUID() as PluginOperationId
    const target = identity === undefined ? this.operationTarget(reason, request.target) : identity.target
    const version = identity === undefined ? this.operationVersion(reason, reason === 'plugin' ? request.target : target) : identity.version
    const facts = { id, reason, stage: request.stage,
      target,
      ...version === undefined ? {} : { version },
      ...request.enabled === undefined ? {} : { enabled: request.enabled } }
    this.reportOperation({ ...facts, time: new Date().toISOString(), phase: 'started' })
    let settled: ChangeResult
    try {
      settled = await withFileLock(join(this.profile.dir, 'package.json'), async () => {
        this.abort.signal.throwIfAborted()
        // An edit made outside plugin management is its own version, so this change's version, and an undo, hold only it.
        const warnings: string[] = []
        await this.recordVersion(OUTSIDE_SUMMARY, { kind: 'outside' }).catch((error: unknown) => {
          warnings.push(`the profile's history could not save an earlier edit: ${messageOf(error)}`)
        })
        const before = this.diskState()
        const result: ChangeResult = { ...request, changed: false,
          ...this.ownerContext.get('hmr') !== undefined ? { application: 'applied' } : { application: 'restart-required', restartReason: 'no-hmr' } }
        try {
          const outcome = await operation(result)
          if (outcome !== undefined) result.application = outcome
          // A reload that waits for a restart leaves the change saved but not applied.
          else if (result.application === 'applied' && result.restartReason !== undefined) result.application = 'restart-required'
        } catch (error) {
          if (error instanceof InstallCancelledError) {
            result.application = 'cancelled'
          } else {
            result.application = 'failed'
            result.error = managementError(error)
          }
        }
        if (result.application !== 'restart-required') delete result.restartReason
        result.changed = before !== this.diskState()
        if (result.changed) {
          // The change itself is saved; a version that cannot be written only means it cannot be undone or restored.
          await this.recordVersion(summary(result), this.changedBy()).catch((error: unknown) => {
            warnings.push(`the profile's history could not save this change: ${messageOf(error)}`)
          })
        }
        if (warnings.length > 0) result.warnings = [...result.warnings ?? [], ...warnings]
        this.ownerContext.emit('plugin-manager/changed', { reason })
        return result
      }, { waitMs: this.lockWaitMs })
    } catch (error) {
      this.reportOperation({ ...facts, time: new Date().toISOString(), phase: 'unknown' })
      throw error
    }
    const refusedVersion = reason === 'install'
      ? settled.error?.incompatible?.find(plugin => plugin.name === facts.target)?.version
      : undefined
    const observedVersion = diagnosticVersion(settled.version ?? refusedVersion)
    this.reportOperation({ ...facts, time: new Date().toISOString(), phase: 'settled',
      stage: settled.stage, target: settled.bundle === undefined ? facts.target : installOperationTarget(settled.bundle),
      application: settled.application, changed: settled.changed,
      ...observedVersion === undefined ? {} : { version: observedVersion },
      ...settled.error === undefined ? {} : { errorCode: settled.error.code },
      ...settled.restartReason === undefined ? {} : { restartReason: settled.restartReason } })
    return settled
  }

  private reportOperation(operation: PluginOperation): void {
    void this.ownerContext.parallel('plugin-manager/operation', operation).catch((_error: unknown) => {
      // All subscribers run; diagnostic failures cannot change the management result.
      console.error('dsh plugin-manager: operation diagnostic delivery failed')
    })
  }

  private operationTarget(reason: PluginChange['reason'], target: string): string | null {
    if (reason !== 'plugin') {
      const name = installOperationTarget(target)
      return reason === 'install' || name === target ? name : null
    }
    return target.length <= 256 && [...this.ctx.loader.entries()].some(entry => entry.id === target) ? target : null
  }

  /** Read the request-time package version without preventing recovery from damaged metadata. */
  private operationVersion(reason: PluginChange['reason'], target: string | null): string | undefined {
    if (reason === 'install' || target === null) return undefined
    try {
      if (reason !== 'plugin') return diagnosticVersion(bundleManifest(target, this.profile.dir, this.profile.installAnchor)?.version)
      const entry = [...this.ctx.loader.entries()].find(row => row.id === target)
      const source = entry?.parent.tree.ctx.baseUrl
      if (entry === undefined || source === undefined) return undefined
      return diagnosticVersion(this.ownerContext.get('pluginPackages')?.packageOf(entry.options.name, source)?.version)
    } catch (_error) {
      // Disabling or removing a broken package must not depend on diagnostic metadata being readable.
      return undefined
    }
  }

  private diskState(): string {
    return this.trackedFiles().map((file) => {
      try { return readFileSync(join(this.profile.dir, file), 'utf8') }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''
        throw error
      }
    }).join('\0')
  }
}

export default PluginManager
