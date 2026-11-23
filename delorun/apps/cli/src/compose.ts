/**
 * The one composition of every Host Delorun boots over a Delorun home, and the checks that hold the booted result to what
 * the composition promised. Every path that boots a Host runs {@link composeDelorunProfile} before upstream's profile
 * runner and {@link assertDelorunInvariants} after it: `delorun start` in the foreground and its detached child, setup's
 * ending, an update's or a rollback's successor and the start after an interrupted update (each a `delorun start
 * --foreground`), safe mode, and `delorun headless`.
 *
 * The composition, in order:
 *
 * 1. upstream's profile preparation, the refusal of a profile that skipped a Delorun bundle (a skipped pack bundle only
 *    prints a notice), and for `delorun headless` the refusal of a `headless` profile that does not load
 *    `@delorun/bundle-headless`;
 * 2. safe mode's filtered layers and overlay, when its marker is set; otherwise the person's `--patch` overlays of
 *    `delorun start`, in the order given, which safe mode refuses;
 * 3. the approved plugin content step ({@link ApprovedPluginContent}), whose overlays apply after safe mode's;
 * 4. C1's sandbox overlay, the last overlay, so it applies over every layer
 *    ([sandbox protection](./sandbox-protection.ts));
 * 5. the static check of the composed rows ({@link assertComposedInvariants}), before any plugin runs.
 *
 * The invariants, checked on the composed rows before boot and on the Loader's rows after it:
 *
 * - each required row, the `sandbox` row and every row a Delorun bundle inserts, is inserted once, by
 *   the bundle that declares it (upstream's `@deepseek-ai/dsh-base` for `sandbox`, a Delorun bundle for a Delorun row), and
 *   runs the plugin that bundle names; no other bundle, the profile's patch, the home's patch or an overlay inserts the
 *   id again, which would replace the row;
 * - each required row is enabled and active, except that an opt-in row ({@link OPT_IN_ROWS}) may be disabled; safe
 *   mode's overlay never exempts one;
 * - the `sandbox` row's `protectedHome` is the home's real path, its `deniedSockets` hold every socket C1 denies, its
 *   `escapeSocketDirectories` hold every directory the start names, its `privateTmp` is on, and it sets no
 *   `runnerCommand` or `runnerFailureSignatures`;
 * - in the CLI profile, each prompt row's switch has the value the recorded prompts answer gives it ("Ask me first"
 *   Delorun's default, "Ask less (like DeepSeek Harness)" the parity value), and the guard rows `delorun-fetch-guard` and `delorun-update-gate`
 *   are on; in the `headless` profile, which has no setup answer, each row of `@delorun/bundle-headless` has Delorun's
 *   default ({@link HEADLESS_ROW_VALUES});
 * - each required Delorun row's package, and the Delorun bundle that declares the row, resolve inside this Delorun's own
 *   packages ({@link delorunPackagesRoot}: `runtimes/<version>/app`, or the source checkout), so a same-named package
 *   elsewhere, such as in the profile's `node_modules`, cannot stand in for it;
 * - the `plugin-manager` row's `protectedPlugins` keep every name a Delorun bundle's patch of the row lists;
 * - after boot, each service a required row provides ({@link ROW_SERVICES}) is provided by that row, by the fiber that
 *   registered it and not by its presence alone, and is present unless the row's switch is off: `sandbox`, `fetchGuard`,
 *   the consent services, `pluginAudit` and `delorunPluginTrust`, and `delorunTurnGate`, through which an update's or a stop's
 *   wait refuses new turns.
 *
 * A Delorun bundle here is a bundle in the `@delorun/` scope that is not one of the running release's optional plugin packs
 * ([release packs](./release-packs.ts)). A layer is a pack only when its real path is the folder the running release
 * installs the pack in, or the profile's Changes review copy of the pack whose approved source is that folder; a layer
 * that only has a pack's name is a Delorun bundle, which the stand-in rule refuses. A pack loads from outside this Delorun's
 * packages, so the rows it inserts, nested ones included, are not required rows and it declares none; a pack that inserts
 * or changes a required row is held to the invariants like any other layer.
 *
 * A violation stops the start with one refusal that names each row, the files that set the value, and the remedy.
 *
 * @module @delorun/cli/compose
 */
import { readFileSync, realpathSync, rmSync } from 'node:fs'
import { activeDirectory, readApproved, type ApprovedRecord } from '@delorun/changes'
import { runDirectory, writeProtectedFile } from '@delorun/home'
import { COMPUTER_ONLY_ROW_MODULES, protectedPluginsIn } from '@delorun/home-auth'
import type { DelorunPackLayers } from '@delorun/plugin-mcp-consent'
import { stringify } from 'yaml'
import { createRuntimeResolution } from '@deepseek-ai/dsh-app-boot'
import { homedir } from 'node:os'
import { join, relative, sep } from 'node:path'
import { CLI_PROFILE } from '@delorun/contract-home-layout'
import type { ResolvedProfileRuntime } from '@deepseek-ai/dsh/profile-boot'
import type { PromptsAnswer } from '@delorun/contract-setup-answers'
import { promptRows } from '@delorun/setup-apply'
import type { CommandOutput } from './command.ts'
import { DELORUN_PROFILE_BUNDLES, HEADLESS_BUNDLE } from '@delorun/bundle-local/profile'
import { delorunRowIds, isDelorunPackage, OPT_IN_ROWS, packageOfModule, refuseSkippedDelorunBundles, skippedPackNotices, type BootedRow } from './delorun-bundles.ts'
import { CliError, EXIT } from './exit.ts'
import { composedRow, isRecord, patchLayers, rowInserts, rowPatches, sourcesSetting, type PatchLayer } from './patch-layers.ts'
import { delorunPackagesRoot } from './package-manager.ts'
import { INSTALL_CHECK_ROW } from './plugin-install-check.ts'
import { safeModeNotice, safeModeStart, type SafeModeStart } from './safe-mode.ts'
import { missingEscapeSocketDirectories, SANDBOX_ROW, sandboxProtection, startOnlySockets, writeSandboxOverlay, type SandboxProtection } from './sandbox-protection.ts'
import { migrationsPath } from './profile-migrations.ts'
import type { ReleasePacks } from './release-packs.ts'
import { readPromptsAnswer } from './setup/prompt-switches.ts'

/**
 * Which Host a composition boots: a CLI profile, which carries `@delorun/bundle-local` and `@delorun/bundle-studio`, or the
 * home's `headless` profile, upstream's `headless` template with `@delorun/bundle-headless` linked into it.
 */
export type ComposeKind = 'cli' | 'headless'

/** What a composition is given. */
export interface ComposeRequest {
  /** The prepared Delorun home. */
  readonly home: string
  /** The profile's name. */
  readonly profile: string
  /** The profile's kind. */
  readonly kind: ComposeKind
  /** Where safe mode's notice is written. */
  readonly output: CommandOutput
  /** The launch environment, read for the Docker context and the ssh-agent whose sockets C1 denies. */
  readonly env: Readonly<Record<string, string | undefined>>
  /** The OS home directory, under which Docker Desktop for macOS keeps its sockets; the user's by default. */
  readonly osHome?: string
  /** The user id that names the runtime and tmux directories C1 hides; this process's by default. */
  readonly uid?: number
  /**
   * The person's overlays from `delorun start --patch`, absolute, in order. They apply over the profile's layers and
   * under the approved plugin content and the sandbox overlay, so the composition's invariants hold over them.
   */
  readonly patchFiles?: readonly string[]
}

/** The composition so far, which the approved plugin content step reads. */
export interface CompositionDraft {
  /** The composition's request. */
  readonly request: ComposeRequest
  /** The profile as it will boot, with safe mode's filtering applied. */
  readonly resolvedProfile: ResolvedProfileRuntime
  /** The overlays so far, in the order they apply. */
  readonly patchFiles: readonly string[]
  /** The safe-mode start, when the marker is set. */
  readonly safe: SafeModeStart | undefined
}

/**
 * The extension slot for approved plugin content: one function the composition calls after safe mode and before the
 * sandbox overlay, which the sandbox overlay therefore applies over. It returns the overlay files to add, in order, and
 * may refuse the start by throwing a `CliError` that names the plugin and the remedy.
 * @param draft - the composition so far.
 * @returns the overlay files it adds; none when there is nothing approved to apply.
 */
export type ApprovedPluginContent = (draft: CompositionDraft) => Promise<readonly string[]>

/** The step that adds nothing and refuses nothing. */
export const NO_APPROVED_CONTENT: ApprovedPluginContent = () => Promise.resolve([])

/** What a composition calls outside this module; specs replace them. */
export interface ComposeDependencies {
  /** Loads the profile and reports its skipped bundles, as upstream's boot does. */
  readonly prepareProfile: (profile: string) => Promise<ResolvedProfileRuntime>
  /** The approved plugin content step; Changes' `changesApprovedContent` in a real start ([changes](./changes/start.ts)). */
  readonly approvedPluginContent: ApprovedPluginContent
  /** The running release's optional plugin packs; `runningReleasePacks` in a real start ([release packs](./release-packs.ts)). */
  readonly releasePacks: ReleasePacks
}

/** One row the Host must run as its declaring bundle composed it. */
export interface RequiredRow {
  /** The row's id. */
  readonly id: string
  /** The plugin the declaring bundle names; `undefined` when no layer, or not the declaring bundle, inserts the row. */
  readonly name: string | undefined
}

/** A composed start: what to hand upstream's profile runner, and what the booted result is held to. */
export interface ComposedStart {
  /** The composition's request. */
  readonly request: ComposeRequest
  /** The profile to boot. */
  readonly resolvedProfile: ResolvedProfileRuntime
  /** The overlays to pass, in order; the sandbox overlay is the last. */
  readonly patchFiles: readonly string[]
  /** The safe-mode start, when the marker is set. */
  readonly safe: SafeModeStart | undefined
  /** C1's sandbox settings the overlay sets. */
  readonly protection: SandboxProtection
  /** The sockets only this start denies, which a successor's H3 does not hold it to ({@link startOnlySockets}). */
  readonly startOnlySockets: readonly string[]
  /** Every layer that composes the rows, the overlays included, for the refusals' sources. */
  readonly layers: readonly PatchLayer[]
  /** The rows the Host must have active, each with the plugin its declaring bundle names. */
  readonly required: readonly RequiredRow[]
  /** Each row's config values the Host must have, by row id and key. */
  readonly values: ReadonlyMap<string, Readonly<Record<string, unknown>>>
  /** The prompts answer the values follow, in the CLI profile. */
  readonly prompts: PromptsAnswer | undefined
  /** Where each required Delorun row's package resolves, real path, for the rows whose package resolves. */
  readonly rowPackages: readonly RowPackage[]
  /** The running release's optional plugin pack bundles that load from the release's pack folder or its approved review copy, without the runtime's own bundles; their rows are not required Delorun rows. */
  readonly packBundles: ReadonlySet<string>
  /** The running release's packs and their folders, without the runtime's own bundles, which {@link packLayersOf} judges layers by. */
  readonly releasePacks: ReadonlyMap<string, string>
  /** The directory this Delorun's own packages lie in ({@link delorunPackagesRoot}). */
  readonly packagesRoot: string
  /** Whether the npm mirror is on ({@link npmMirrorOf}); the start passes it to the Host as `DELORUN_NPM_MIRROR`. */
  readonly npmMirror: boolean
}

/** Where a required Delorun row's package, or the bundle that declares it, resolves. */
export interface RowPackage {
  /** The row. */
  readonly id: string
  /** The package. */
  readonly packageName: string
  /** Its directory, real path. */
  readonly dir: string
}

/** The plugin manager's row, whose registries and protected plugins the composition holds. */
export const PLUGIN_MANAGER_ROW = 'plugin-manager'

/** The guard rows that stay on whatever the prompts answer. */
const GUARD_ROWS: Readonly<Record<string, Readonly<Record<string, unknown>>>> = {
  'delorun-fetch-guard': { enabled: true },
  'delorun-update-gate': { enabled: true, holdUntilChecked: true },
}

/** The prompts answers as a refusal names them. */
const PROMPT_ANSWER_LABELS = { safer: 'Ask me first', stock: 'Ask less (like DeepSeek Harness)', dangerous: 'Never ask (dangerous)' } as const

/**
 * The values each row of `@delorun/bundle-headless` must have in the `headless` profile: Delorun's defaults, which no setup
 * answer changes there.
 */
export const HEADLESS_ROW_VALUES: Readonly<Record<string, Readonly<Record<string, unknown>>>> = {
  'delorun-instruction-consent': { enabled: true, approvedPluginWrites: true },
  'delorun-mcp-consent': { enabled: true },
  'delorun-schedule-consent': { enabled: true },
  'delorun-permission-defaults': { enabled: true, fullAccessEverywhere: false },
  'delorun-delegation-consent': { enabled: true },
  'delorun-plugin-changes': { enabled: true },
  ...GUARD_ROWS,
}

/** The bundles the runtime ships and its profiles require, which are never packs, whatever a packs file lists. */
const RUNTIME_BUNDLES: ReadonlySet<string> = new Set([...DELORUN_PROFILE_BUNDLES, HEADLESS_BUNDLE])

/** The service an update's or a stop's wait attaches its gate to. */
export const TURN_GATE_SERVICE = 'delorunTurnGate'

/** The bundle that declares the `sandbox` row: upstream's base bundle, under every profile Delorun boots. */
export const SANDBOX_BUNDLE = '@deepseek-ai/dsh-base'

/**
 * The services each required row provides, by row id. After boot each must be provided by its row's fiber, and must be
 * present unless the row's config sets `enabled` to `false`, which is how a consent row turned to its parity value
 * registers nothing.
 */
export const ROW_SERVICES: Readonly<Record<string, readonly string[]>> = {
  [SANDBOX_ROW]: ['sandbox'],
  'delorun-fetch-guard': ['fetchGuard'],
  'delorun-update-gate': [TURN_GATE_SERVICE],
  'delorun-instruction-consent': ['writeConsent'],
  'delorun-mcp-consent': ['mcpAddConsent'],
  'delorun-schedule-consent': ['scheduleConsent'],
  'delorun-permission-defaults': ['permissionDefaults', 'sandboxModeGuard', 'delorunCommandNetwork', 'sandboxNetwork'],
  'delorun-delegation-consent': ['delegationConsent'],
  'delorun-plugin-install-check': ['pluginAudit', 'delorunPluginTrust'],
}

/**
 * Compose the profile a Host boots over this home.
 * @param request - the home, the profile, its kind, the output and the environment.
 * @param dependencies - the profile preparation and the approved plugin content step.
 * @returns the composed start.
 * @throws {CliError} when the profile cannot be loaded or skipped a Delorun bundle, a layer sets the sandbox runner or
 *   carries expressions on the row, the approved content step refuses, or the composed rows break an invariant.
 */
export async function composeDelorunProfile(request: ComposeRequest, dependencies: ComposeDependencies): Promise<ComposedStart> {
  const releasePacks = new Map([...await dependencies.releasePacks(request)].filter(([name]) => !RUNTIME_BUNDLES.has(name)))
  const packNames = new Set(releasePacks.keys())
  let resolvedProfile: ResolvedProfileRuntime
  try {
    resolvedProfile = await dependencies.prepareProfile(request.profile)
    refuseSkippedDelorunBundles(resolvedProfile.profile, packNames)
  } catch (error) {
    if (error instanceof CliError) throw error
    throw new CliError(EXIT.failed, `delorun: the profile ${request.profile} could not be loaded: ${error instanceof Error ? error.message : String(error)}`)
  }
  for (const notice of skippedPackNotices(resolvedProfile.profile, packNames)) request.output.stderr(notice)
  const packBundles = await installedPackBundles(request, resolvedProfile.profile, releasePacks)
  if (request.kind === 'headless') refuseHeadlessWithoutBundle(request.home, resolvedProfile)
  const delorunRows = delorunRowIds(resolvedProfile.profile, packBundles)
  // Safe mode boots the same profile with its third-party layers and rows left out, and edits none of its files.
  const safe = safeModeStart({ home: request.home, profile: request.profile, resolvedProfile })
  const overlays = request.patchFiles ?? []
  if (safe !== undefined) {
    if (overlays.length > 0) throw new CliError(EXIT.failed, `delorun: the profile ${request.profile} is in safe mode, which leaves out everything but Delorun's and upstream's own plugins, so it does not apply --patch ${overlays.join(', ')}; start without --patch, or leave safe mode with delorun recover exit-safe-mode`)
    request.output.stdout(safeModeNotice(safe))
    resolvedProfile = safe.resolvedProfile
  }
  const before = safe?.patchFiles ?? overlays
  const approved = await dependencies.approvedPluginContent({ request, resolvedProfile, patchFiles: before, safe })
  const protection = await sandboxProtection(request.home, request.profile, request.env, request.osHome ?? homedir(), request.uid ?? process.getuid?.())
  const others = [...before, ...approved]
  const overlay = await writeSandboxOverlay(request.home, request.profile, resolvedProfile.profile, others, protection)
  const startOnly = startOnlySockets(request.home, resolvedProfile.profile, others, protection)
  const dangerousOverlay = request.kind === 'headless' ? await writeHeadlessDangerousOverlay(request.home, request.profile) : []
  const patchFiles = [...others, overlay, ...dangerousOverlay]
  const prompts = request.kind === 'cli' ? readPromptsAnswer(join(request.home, 'profiles', request.profile)) : undefined
  const headlessValues = dangerousOverlay.length > 0
    ? { ...HEADLESS_ROW_VALUES, 'delorun-permission-defaults': { enabled: true, fullAccessEverywhere: true } }
    : HEADLESS_ROW_VALUES
  const values = new Map<string, Readonly<Record<string, unknown>>>(prompts === undefined
    ? Object.entries(headlessValues)
    : [...promptRows(prompts).map(row => [row.id, row.config] as const), ...Object.entries(GUARD_ROWS)])
  const layers = patchLayers(request.home, resolvedProfile.profile, patchFiles)
  const requiredIds = [SANDBOX_ROW, ...delorunRows]
  const rowPackages = await delorunRowPackages(resolvedProfile, layers, requiredIds.filter(id => id !== SANDBOX_ROW))
  const composed: ComposedStart = {
    request,
    resolvedProfile,
    patchFiles,
    safe,
    protection,
    startOnlySockets: startOnly,
    layers,
    required: requiredIds.map(id => ({ id, name: declaredName(layers, id, packBundles) })),
    values,
    prompts,
    rowPackages,
    packBundles,
    releasePacks,
    packagesRoot: delorunPackagesRoot(),
    npmMirror: npmMirrorOf(layers),
  }
  assertComposedInvariants(composed)
  return composed
}

/**
 * A path's real path.
 * @param path - the path.
 * @returns the real path, or `undefined` when the path does not resolve.
 */
function realPathOf(path: string): string | undefined {
  try {
    return realpathSync.native(path)
  } catch (error) {
    // A missing or unreadable path (`error`) is no pack's folder, so a layer there is held to the rules for Delorun's own bundles.
    return undefined
  }
}

/**
 * The test for whether a bundle layer is a pack of the running release by where it loads from: the folder the release
 * installs the pack in, reached through any link, or the profile's Changes review copy of the pack whose approved source
 * resolves to that folder. A layer that only carries a pack's name is not a pack. The approved record is read at each
 * test, so a test after the person applied or discarded a change sees the record as it is then.
 * @param request - the home and the profile.
 * @param profileDir - the profile's folder, which holds its approved record.
 * @param releasePacks - the running release's packs and their folders, without the runtime's own bundles.
 * @returns the test: true when the layer is a pack.
 */
export function packLayerTest(request: Pick<ComposeRequest, 'home' | 'profile'>, profileDir: string, releasePacks: ReadonlyMap<string, string>): (layer: { readonly packageName: string, readonly packageDir: string }) => Promise<boolean> {
  return async (layer) => {
    const folder = releasePacks.get(layer.packageName)
    const pack = folder === undefined ? undefined : realPathOf(folder)
    const real = realPathOf(layer.packageDir)
    if (pack === undefined || real === undefined) return false
    if (real === pack) return true
    let approved: ApprovedRecord | undefined
    try {
      approved = await readApproved(profileDir)
    } catch (error) {
      // A record Changes cannot read (`error`) approves no source, so only a layer in a pack's own folder is a pack.
      approved = undefined
    }
    const source = approved?.plugins[layer.packageName]?.source
    return source !== undefined && realPathOf(source) === pack && real === realPathOf(activeDirectory(request.home, request.profile, layer.packageName))
  }
}

/**
 * The layers that are packs of the running release by where they load from ({@link packLayerTest}).
 * @param request - the home and the profile.
 * @param profile - the loaded profile.
 * @param releasePacks - the running release's packs and their folders, without the runtime's own bundles.
 * @returns the names of the layers that are packs.
 */
async function installedPackBundles(request: ComposeRequest, profile: ResolvedProfileRuntime['profile'], releasePacks: ReadonlyMap<string, string>): Promise<Set<string>> {
  const packs = new Set<string>()
  if (releasePacks.size === 0) return packs
  const isPack = packLayerTest(request, profile.dir, releasePacks)
  for (const layer of profile.layers) if (await isPack(layer)) packs.add(layer.packageName)
  return packs
}

/**
 * The launcher's judgement of the profile's bundle layers, which `@delorun/plugin-mcp-consent` reads at each review to
 * tell a pack's or Delorun's own row from a third-party bundle's ([layers](../../../packages/plugin-mcp-consent/src/layers.ts)).
 * A layer is `runtime` when it is one of the bundles the runtime ships and its profiles require (a bundle name resolves
 * from the installation first, so a profile package cannot take one's place), `pack` when {@link packLayerTest} says so
 * now, and `other` otherwise.
 * @param request - the home and the profile.
 * @param profileDir - the profile's folder, which holds its approved record.
 * @param releasePacks - the running release's packs and their folders, without the runtime's own bundles.
 * @returns the judge.
 */
export function packLayersOf(request: Pick<ComposeRequest, 'home' | 'profile'>, profileDir: string, releasePacks: ReadonlyMap<string, string>): DelorunPackLayers {
  const isPack = packLayerTest(request, profileDir, releasePacks)
  return {
    kindOf: async (layer) => {
      if (RUNTIME_BUNDLES.has(layer.packageName)) return 'runtime'
      return await isPack(layer) ? 'pack' : 'other'
    },
  }
}

/**
 * The overlay that gives a `headless` run dangerous mode. The run has no setup answer of its own, so it takes the CLI
 * profile's: the permission row gets `fullAccessEverywhere` only when that answer is `dangerous`, and the plugin still
 * needs the grant file. Any other answer removes an overlay an earlier run left.
 * @param home - the resolved Delorun home.
 * @param profile - the headless profile.
 * @returns the overlay's path, or an empty list when the CLI profile's answer is not `dangerous`.
 */
async function writeHeadlessDangerousOverlay(home: string, profile: string): Promise<string[]> {
  const path = join(runDirectory(home, profile), 'dangerous.patch.yml')
  if (readPromptsAnswer(join(home, 'profiles', CLI_PROFILE)) !== 'dangerous') {
    rmSync(path, { force: true })
    return []
  }
  await writeProtectedFile(path, stringify([{ id: 'delorun-permission-defaults', config: { enabled: true, fullAccessEverywhere: true } }]))
  return [path]
}

/**
 * Refuse a `headless` profile that does not load `@delorun/bundle-headless`: its task would run without Delorun's guards.
 * @param home - the Delorun home.
 * @param resolvedProfile - the prepared profile.
 * @throws {CliError} naming the bundle and the remedy.
 */
function refuseHeadlessWithoutBundle(home: string, resolvedProfile: ResolvedProfileRuntime): void {
  if (resolvedProfile.profile.layers.some(layer => layer.packageName === HEADLESS_BUNDLE)) return
  const record = migrationsPath(home, resolvedProfile.profile.name)
  throw new CliError(EXIT.failed, [
    `delorun headless: the ${resolvedProfile.profile.name} profile does not load Delorun's headless bundle ${HEADLESS_BUNDLE}, which holds the guards a headless task runs under, so Delorun did not start the task.`,
    `To fix it, remove ${record} so that the next delorun headless adds the bundle again, or remove the folder ${resolvedProfile.profile.dir} so that Delorun creates the profile again with it.`,
  ].join('\n'))
}

/**
 * Where each required Delorun row's package resolves, as the boot's runtime resolution resolves it, and where the bundle
 * that declares the row was loaded from.
 * @param resolvedProfile - the prepared profile.
 * @param layers - the layers.
 * @param ids - the required Delorun rows.
 * @returns one entry per row and package that resolves.
 */
async function delorunRowPackages(resolvedProfile: ResolvedProfileRuntime, layers: readonly PatchLayer[], ids: readonly string[]): Promise<RowPackage[]> {
  const resolution = await createRuntimeResolution({ installAnchor: resolvedProfile.installAnchor, profile: resolvedProfile.profile })
  const found: RowPackage[] = []
  for (const id of ids) {
    const declaring = layers.find(layer => rowInserts(layer.patches, id).length > 0)
    if (declaring?.packageName !== undefined && declaring.packageDir !== undefined) found.push({ id, packageName: declaring.packageName, dir: realpathSync.native(declaring.packageDir) })
    const name = composedRow(layers, id)?.name
    if (typeof name !== 'string') continue
    const packageName = packageOfModule(name)
    for (const entry of resolution.entries.filter(each => each.name === packageName)) found.push({ id, packageName, dir: realpathSync.native(entry.packageDir) })
  }
  return found
}

/**
 * The violations of required Delorun rows whose package, or declaring bundle, resolves outside this Delorun's packages: a
 * same-named stand-in, such as a copy in the profile's `node_modules`, would otherwise pass the check by name.
 * @param composed - the composed start.
 * @returns one violation per row and package.
 */
function standInViolations(composed: ComposedStart): Violation[] {
  return composed.rowPackages.flatMap((row): Violation[] => {
    const path = relative(composed.packagesRoot, row.dir)
    if (path !== '..' && !path.startsWith(`..${sep}`) && !path.startsWith(sep) && !/^[A-Za-z]:/u.test(path)) return []
    return [{ subject: row.id, problem: `loads ${row.packageName} from ${row.dir}, which is not this Delorun's own copy in ${composed.packagesRoot}; a package of that name installed elsewhere, such as in the profile, cannot stand in for it`, sources: [] }]
  })
}

/**
 * The violations of the plugin manager's row: a protected plugin that a Delorun bundle's patch of the row lists and the
 * composed row does not.
 * @param composed - the composed start.
 * @param row - the plugin manager's row, composed or booted; `undefined` when the profile has none.
 * @returns the violations.
 */
function pluginManagerViolations(composed: ComposedStart, row: { readonly config?: unknown } | undefined): Violation[] {
  if (row === undefined) return []
  const config = isRecord(row.config) ? row.config : {}
  const kept = new Set(Array.isArray(config.protectedPlugins) ? config.protectedPlugins.filter((name): name is string => typeof name === 'string') : [])
  const declared = composed.layers.filter(layer => layer.packageName !== undefined && isDelorunPackage(layer.packageName))
    .flatMap(layer => rowPatches(layer.patches, PLUGIN_MANAGER_ROW))
    .flatMap(patch => isRecord(patch.config) && Array.isArray(patch.config.protectedPlugins) ? patch.config.protectedPlugins.filter((name): name is string => typeof name === 'string') : [])
  const dropped = [...new Set(declared)].filter(name => !kept.has(name))
  if (dropped.length === 0) return []
  return [{ subject: PLUGIN_MANAGER_ROW, problem: `no longer protects ${dropped.join(', ')}; a patch of the row replaces its whole config, so restate protectedPlugins with every name Delorun's bundle lists`, sources: sourcesSetting(composed.layers, PLUGIN_MANAGER_ROW, patch => isRecord(patch.config) && 'protectedPlugins' in patch.config) }]
}

/**
 * Whether the composition turns the npm mirror on: the composed `delorun-plugin-install-check` row's `npmMirror` is
 * literally `true`.
 * @param layers - the layers.
 * @returns the setting; false without the row or with any other value.
 */
export function npmMirrorOf(layers: readonly PatchLayer[]): boolean {
  const config = composedRow(layers, INSTALL_CHECK_ROW)?.config
  return isRecord(config) && config.npmMirror === true
}

/**
 * Whether a layer is the bundle that declares a required row.
 * @param layer - the layer.
 * @param id - the row's id.
 * @param packBundles - the running release's pack bundles, which declare no required row.
 * @returns true for upstream's base bundle and the `sandbox` row, and for a Delorun bundle that is not a pack and any
 *   other required row.
 */
function declares(layer: PatchLayer, id: string, packBundles: ReadonlySet<string>): boolean {
  if (layer.packageName === undefined) return false
  return id === SANDBOX_ROW ? layer.packageName === SANDBOX_BUNDLE : isDelorunPackage(layer.packageName) && !packBundles.has(layer.packageName)
}

/**
 * The plugin the declaring bundle names for a required row.
 * @param layers - the layers.
 * @param id - the row's id.
 * @param packBundles - the running release's pack bundles.
 * @returns the name of the first insert of the row, when the declaring bundle made it; otherwise `undefined`.
 */
function declaredName(layers: readonly PatchLayer[], id: string, packBundles: ReadonlySet<string>): string | undefined {
  for (const layer of layers) {
    const insert = rowInserts(layer.patches, id)[0]
    if (insert === undefined) continue
    return declares(layer, id, packBundles) && typeof insert.name === 'string' ? insert.name : undefined
  }
  return undefined
}

/**
 * The violations of the layers that insert a required row: a first insert that its declaring bundle did not make, and
 * every later insert, which would replace the row with an entry of the same id.
 * @param composed - the composed start.
 * @param row - the required row.
 * @returns the violations.
 */
function insertViolations(composed: ComposedStart, row: RequiredRow): Violation[] {
  const inserts = composed.layers.flatMap(layer => rowInserts(layer.patches, row.id).map(entry => ({ layer, entry })))
  const first = inserts[0]
  if (first === undefined) return []
  const violations: Violation[] = []
  if (!declares(first.layer, row.id, composed.packBundles)) {
    violations.push({ subject: row.id, problem: `is inserted with the plugin ${JSON.stringify(first.entry.name)} by a layer that does not declare it`, sources: [first.layer.source] })
  }
  const again = inserts.slice(1)
  if (again.length > 0) {
    violations.push({ subject: row.id, problem: `is inserted again${row.name === undefined ? '' : `, which would replace the plugin ${row.name}`}, with ${again.map(({ entry }) => JSON.stringify(entry.name)).join(', ')}`, sources: [...new Set(again.map(({ layer }) => layer.source))] })
  }
  return violations
}

/** One broken invariant. */
interface Violation {
  /** The row, or the service. */
  readonly subject: string
  /** What is wrong. */
  readonly problem: string
  /** The files that set the value, in layer order; empty when none did. */
  readonly sources: readonly string[]
}

/**
 * The rows of the composition as the boot include would mount them, before any plugin runs: each required row's
 * composed entry, with `disabled` and `config` as the last layer that sets each gives them.
 * @param composed - the composed start.
 * @returns one row per required row the composition inserts, active unless it is disabled.
 */
export function composedRows(composed: ComposedStart): BootedRow[] {
  return composed.required.flatMap(({ id }) => {
    const entry = composedRow(composed.layers, id)
    if (entry === undefined) return []
    return [{ id, name: String(entry.name), disabled: entry.disabled === true, state: 'active' as const, ...entry.config === undefined ? {} : { config: entry.config } }]
  })
}

/**
 * Whether a row is one of the protections a start requires on whatever a bundle's manifest says: the sandbox, the plugin
 * manager, the guard and consent rows whose values the start pins, and the rows of the computer-only and protected modules.
 * @param composed - the composed start.
 * @param id - the row's id.
 * @returns true for a security row.
 */
function isSecurityRow(composed: ComposedStart, id: string): boolean {
  if (id === SANDBOX_ROW || id === PLUGIN_MANAGER_ROW || composed.values.has(id) || Object.hasOwn(HEADLESS_ROW_VALUES, id)) return true
  const module = composedRow(composed.layers, id)?.name
  if (typeof module !== 'string') return false
  const protectedModules = protectedPluginsIn(composedRow(composed.layers, PLUGIN_MANAGER_ROW)?.config) ?? new Set<string>()
  return Object.hasOwn(COMPUTER_ONLY_ROW_MODULES, module) || protectedModules.has(module)
}

/**
 * Whether the Delorun bundle that declares a row lists it in `delorun.requires` of its own `package.json`: a "Needs setup" row,
 * which the bundle ships disabled until the person turns it on once its needs are met.
 * @param composed - the composed start.
 * @param id - the row's id.
 * @returns true when the declaring Delorun bundle's manifest names the row; false when it cannot be read.
 */
function declaresNeeds(composed: ComposedStart, id: string): boolean {
  if (isSecurityRow(composed, id)) return false
  const layer = composed.layers.find(each => each.packageDir !== undefined && declares(each, id, composed.packBundles) && rowInserts(each.patches, id).length > 0)
  if (layer?.packageDir === undefined) return false
  let manifest: unknown
  try {
    manifest = JSON.parse(readFileSync(join(layer.packageDir, 'package.json'), 'utf8'))
  } catch (error) {
    // An unreadable or malformed manifest (`error`) declares nothing: the row is held to the rule for every other required row.
    return false
  }
  const requires = isRecord(manifest) && isRecord(manifest.delorun) ? manifest.delorun.requires : undefined
  return isRecord(requires) && Object.hasOwn(requires, id)
}

/**
 * The violations of a set of rows.
 * @param composed - the composed start.
 * @param rows - the rows, composed or booted.
 * @returns the violations; a row whose `disabled` is an expression the boot evaluates counts as enabled before boot.
 */
function violationsOf(composed: ComposedStart, rows: readonly BootedRow[]): Violation[] {
  const violations: Violation[] = []
  const byId = new Map(rows.map(row => [row.id, row]))
  for (const required of composed.required) {
    const { id } = required
    violations.push(...insertViolations(composed, required))
    const count = rows.filter(row => row.id === id).length
    if (count > 1) violations.push({ subject: id, problem: `is mounted ${String(count)} times`, sources: [] })
    const row = byId.get(id)
    if (row === undefined) {
      violations.push({ subject: id, problem: 'is not in the profile', sources: [] })
      continue
    }
    if (required.name !== undefined && row.name !== required.name) {
      violations.push({ subject: id, problem: `runs the plugin ${JSON.stringify(row.name)}, not ${required.name}`, sources: sourcesSetting(composed.layers, id, patch => patch.name !== undefined && patch.name !== required.name) })
    }
    if (row.disabled) {
      if (OPT_IN_ROWS.has(id) || declaresNeeds(composed, id)) continue
      violations.push({ subject: id, problem: 'is disabled', sources: sourcesSetting(composed.layers, id, patch => patch.disabled !== undefined && patch.disabled !== false) })
      continue
    }
    if (row.state !== 'active') violations.push({ subject: id, problem: `did not start (${row.state})`, sources: [] })
  }
  const sandbox = byId.get(SANDBOX_ROW)
  if (sandbox !== undefined) violations.push(...sandboxViolations(composed, sandbox))
  for (const [id, expected] of composed.values) {
    const row = byId.get(id)
    if (row === undefined || row.disabled) continue
    for (const [key, value] of Object.entries(expected)) {
      const actual = isRecord(row.config) ? row.config[key] : undefined
      if (actual === value) continue
      const because = composed.request.kind === 'headless'
        ? 'which a delorun headless run always has'
        : id in GUARD_ROWS ? 'which stays on whatever the prompts answer' : `which the recorded prompts answer "${PROMPT_ANSWER_LABELS[composed.prompts ?? 'safer']}" sets`
      violations.push({ subject: id, problem: `has ${key} ${JSON.stringify(actual)}, not ${JSON.stringify(value)}, ${because}`, sources: sourcesSetting(composed.layers, id, patch => isRecord(patch.config) && key in patch.config && patch.config[key] !== value) })
    }
  }
  return violations
}

/**
 * The violations of the sandbox row's settings.
 * @param composed - the composed start.
 * @param row - the sandbox row.
 * @returns the violations.
 */
function sandboxViolations(composed: ComposedStart, row: BootedRow): Violation[] {
  const config = isRecord(row.config) ? row.config : {}
  const sources = (key: string): string[] => sourcesSetting(composed.layers, SANDBOX_ROW, patch => isRecord(patch.config) && key in patch.config)
  const violations: Violation[] = []
  const home = realpathSync.native(composed.request.home)
  if (config.protectedHome !== home) violations.push({ subject: SANDBOX_ROW, problem: `protects ${JSON.stringify(config.protectedHome)}, not the home ${home}`, sources: sources('protectedHome') })
  const denied = Array.isArray(config.deniedSockets) ? config.deniedSockets : []
  const missing = composed.protection.deniedSockets.filter(socket => !denied.includes(socket))
  if (missing.length > 0) violations.push({ subject: SANDBOX_ROW, problem: `does not deny ${missing.join(', ')}`, sources: sources('deniedSockets') })
  const unhidden = missingEscapeSocketDirectories(composed.protection, config)
  if (unhidden.length > 0) violations.push({ subject: SANDBOX_ROW, problem: `does not hide the escape directories ${unhidden.join(', ')}`, sources: sources('escapeSocketDirectories') })
  if (config.privateTmp !== true) violations.push({ subject: SANDBOX_ROW, problem: 'shows confined commands the host\'s /tmp (privateTmp is not on)', sources: sources('privateTmp') })
  for (const key of ['runnerCommand', 'runnerFailureSignatures']) {
    if (config[key] !== undefined) violations.push({ subject: SANDBOX_ROW, problem: `sets ${key}`, sources: sources(key) })
  }
  return violations
}

/**
 * The refusal for a set of violations.
 * @param profile - the profile.
 * @param violations - the violations; not empty.
 * @param booted - whether the Host had booted.
 * @returns the error to stop the start with.
 */
function refusal(profile: string, violations: readonly Violation[], booted: boolean): CliError {
  return new CliError(EXIT.failed, [
    `delorun: the profile ${profile} would ${booted ? 'run' : 'boot'} without protections Delorun requires, so Delorun ${booted ? 'stopped it' : 'did not start it'}:`,
    ...violations.map(violation => `  ${violation.subject} ${violation.problem}${violation.sources.length === 0 ? '' : ` (set in ${violation.sources.join(', ')})`}`),
    `To fix it, remove those settings from the files named, or start without your plugins with: delorun recover safe-mode --profile ${profile}`,
  ].join('\n'))
}

/**
 * Hold the composed rows to the invariants before any plugin runs.
 * @param composed - the composed start.
 * @throws {CliError} naming each violation, the files that set it and the remedy.
 */
export function assertComposedInvariants(composed: ComposedStart): void {
  const violations = [...violationsOf(composed, composedRows(composed)), ...standInViolations(composed), ...pluginManagerViolations(composed, composedRow(composed.layers, PLUGIN_MANAGER_ROW))]
  if (violations.length > 0) throw refusal(composed.request.profile, violations, false)
}

/** What the invariants read of a booted Host. */
export interface BootedHost {
  /**
   * The Loader's rows after startup settled.
   * @returns the rows, with their configs.
   */
  readonly rows: () => readonly BootedRow[]
  /**
   * Who provides a service in the root context.
   * @param name - the service's name.
   * @returns `undefined` when no active fiber provides it; otherwise the provider, whose `row` is the id of the Loader
   *   row whose fiber registered the service or is an ancestor of the fiber that did, or `undefined` when no row's is.
   */
  readonly providerOf: (name: string) => ServiceProvider | undefined
}

/** The provider of a service in a booted Host. */
export interface ServiceProvider {
  /** The id of the Loader row that provides it; `undefined` when the provider is no Loader row's fiber or descendant. */
  readonly row: string | undefined
  /** Whether the provided value is a fail-closed stand-in that a row mounted after its real service failed. */
  readonly failClosed?: boolean
}

/**
 * The violations of the services the required rows provide.
 * @param composed - the composed start.
 * @param host - the booted Host.
 * @returns a violation for each service another provider holds, and for each that is absent while its row is enabled
 *   and its switch is not off.
 */
function serviceViolations(composed: ComposedStart, host: BootedHost): Violation[] {
  const byId = new Map(host.rows().map(row => [row.id, row]))
  return composed.required.flatMap(({ id }) => (ROW_SERVICES[id] ?? []).flatMap((service): Violation[] => {
    const provider = host.providerOf(service)
    if (provider !== undefined) {
      if (provider.failClosed === true) return [{ subject: service, problem: `is a fail-closed stand-in: ${id} is on but its real service failed to start, so the composition is not healthy`, sources: [] }]
      return provider.row === id ? [] : [{ subject: service, problem: `is provided by ${provider.row === undefined ? 'no plugin row' : `the row ${provider.row}`}, not by ${id}`, sources: provider.row === undefined ? [] : sourcesSetting(composed.layers, provider.row, () => true) }]
    }
    const row = byId.get(id)
    if (row === undefined || row.disabled || (isRecord(row.config) && row.config.enabled === false)) return []
    return [{ subject: service, problem: id === 'delorun-update-gate' ? 'is not provided, so an update or a stop could not refuse new turns while it waits' : `is not provided by ${id}`, sources: [] }]
  }))
}

/**
 * Hold a booted Host to the invariants: what mounted, not only what was composed.
 * @param composed - the composed start the Host booted.
 * @param host - the booted Host.
 * @throws {CliError} naming each violation, the files that set it and the remedy; the caller stops the Host.
 */
export function assertDelorunInvariants(composed: ComposedStart, host: BootedHost): void {
  const violations = [...violationsOf(composed, host.rows()), ...serviceViolations(composed, host), ...pluginManagerViolations(composed, host.rows().find(row => row.id === PLUGIN_MANAGER_ROW))]
  if (violations.length > 0) throw refusal(composed.request.profile, violations, true)
}
