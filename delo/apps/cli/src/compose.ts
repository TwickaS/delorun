/**
 * The one composition of every Host Delo boots over a Delo home, and the checks that hold the booted result to what
 * the composition promised. Every path that boots a Host runs {@link composeDeloProfile} before upstream's profile
 * runner and {@link assertDeloInvariants} after it: `delorun start` in the foreground and its detached child, setup's
 * ending, an update's or a rollback's successor and the start after an interrupted update (each a `delorun start
 * --foreground`), safe mode, and `delorun headless`.
 *
 * The composition, in order:
 *
 * 1. upstream's profile preparation, the refusal of a profile that skipped a Delo bundle, and for `delorun headless` the
 *    refusal of a `headless` profile that does not load `@delo/bundle-headless`;
 * 2. safe mode's filtered layers and overlay, when its marker is set;
 * 3. the approved plugin content step ({@link ApprovedPluginContent}), whose overlays apply after safe mode's;
 * 4. C1's sandbox overlay, the last overlay, so it applies over every layer
 *    ([sandbox protection](./sandbox-protection.ts));
 * 5. the static check of the composed rows ({@link assertComposedInvariants}), before any plugin runs.
 *
 * The invariants, checked on the composed rows before boot and on the Loader's rows after it:
 *
 * - each required row, the `sandbox` row and every row a Delo bundle inserts, is inserted once, by
 *   the bundle that declares it (upstream's `@deepseek-ai/dsh-base` for `sandbox`, a Delo bundle for a Delo row), and
 *   runs the plugin that bundle names; no other bundle, the profile's patch, the home's patch or an overlay inserts the
 *   id again, which would replace the row;
 * - each required row is enabled and active; safe mode's overlay never exempts one;
 * - the `sandbox` row's `protectedHome` is the home's real path, its `deniedSockets` hold every socket C1 denies, its
 *   `escapeSocketDirectories` hold every directory the start names, and it sets no `runnerCommand` or
 *   `runnerFailureSignatures`;
 * - in the CLI profile, each prompt row's switch has the value the recorded prompts answer gives it ("Safer prompts"
 *   Delo's default, "Same as stock" the parity value), and the guard rows `delo-fetch-guard` and `delo-update-gate`
 *   are on; in the `headless` profile, which has no setup answer, each row of `@delo/bundle-headless` has Delo's
 *   default ({@link HEADLESS_ROW_VALUES});
 * - after boot, each service a required row provides ({@link ROW_SERVICES}) is provided by that row, by the fiber that
 *   registered it and not by its presence alone, and is present unless the row's switch is off: `sandbox`, `fetchGuard`,
 *   the consent services and `deloTurnGate`, through which an update's or a stop's wait refuses new turns.
 *
 * A violation stops the start with one refusal that names each row, the files that set the value, and the remedy.
 *
 * @module @delo/cli/compose
 */
import { realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { ResolvedProfileRuntime } from '@deepseek-ai/dsh/profile-boot'
import type { PromptsAnswer } from '@delo/contract-setup-answers'
import type { CommandOutput } from './command.ts'
import { HEADLESS_BUNDLE } from '@delo/bundle-local/profile'
import { deloRowIds, isDeloPackage, refuseSkippedDeloBundles, type BootedRow } from './delo-bundles.ts'
import { CliError, EXIT } from './exit.ts'
import { composedRow, isRecord, patchLayers, rowInserts, sourcesSetting, type PatchLayer } from './patch-layers.ts'
import { safeModeNotice, safeModeStart, type SafeModeStart } from './safe-mode.ts'
import { missingEscapeSocketDirectories, SANDBOX_ROW, sandboxProtection, writeSandboxOverlay, type SandboxProtection } from './sandbox-protection.ts'
import { migrationsPath } from './profile-migrations.ts'
import { promptRows, readPromptsAnswer } from './setup/prompt-switches.ts'

/**
 * Which Host a composition boots: a CLI profile, which carries `@delo/bundle-local` and `@delo/bundle-studio`, or the
 * home's `headless` profile, upstream's `headless` template with `@delo/bundle-headless` linked into it.
 */
export type ComposeKind = 'cli' | 'headless'

/** What a composition is given. */
export interface ComposeRequest {
  /** The prepared Delo home. */
  readonly home: string
  /** The profile's name. */
  readonly profile: string
  /** The profile's kind. */
  readonly kind: ComposeKind
  /** Where safe mode's notice is written. */
  readonly output: CommandOutput
  /** The launch environment, read for the Docker context whose socket C1 denies. */
  readonly env: Readonly<Record<string, string | undefined>>
  /** The OS home directory, under which Docker Desktop for macOS keeps its sockets; the user's by default. */
  readonly osHome?: string
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
  /** Every layer that composes the rows, the overlays included, for the refusals' sources. */
  readonly layers: readonly PatchLayer[]
  /** The rows the Host must have active, each with the plugin its declaring bundle names. */
  readonly required: readonly RequiredRow[]
  /** Each row's config values the Host must have, by row id and key. */
  readonly values: ReadonlyMap<string, Readonly<Record<string, unknown>>>
  /** The prompts answer the values follow, in the CLI profile. */
  readonly prompts: PromptsAnswer | undefined
}

/** The guard rows that stay on whatever the prompts answer. */
const GUARD_ROWS: Readonly<Record<string, Readonly<Record<string, unknown>>>> = {
  'delo-fetch-guard': { enabled: true },
  'delo-update-gate': { enabled: true, holdUntilChecked: true },
}

/**
 * The values each row of `@delo/bundle-headless` must have in the `headless` profile: Delo's defaults, which no setup
 * answer changes there.
 */
export const HEADLESS_ROW_VALUES: Readonly<Record<string, Readonly<Record<string, unknown>>>> = {
  'delo-instruction-consent': { enabled: true },
  'delo-mcp-consent': { enabled: true },
  'delo-schedule-consent': { enabled: true },
  'delo-permission-defaults': { enabled: true },
  ...GUARD_ROWS,
}

/** The service an update's or a stop's wait attaches its gate to. */
export const TURN_GATE_SERVICE = 'deloTurnGate'

/** The bundle that declares the `sandbox` row: upstream's base bundle, under every profile Delo boots. */
export const SANDBOX_BUNDLE = '@deepseek-ai/dsh-base'

/**
 * The services each required row provides, by row id. After boot each must be provided by its row's fiber, and must be
 * present unless the row's config sets `enabled` to `false`, which is how a consent row turned to its parity value
 * registers nothing.
 */
export const ROW_SERVICES: Readonly<Record<string, readonly string[]>> = {
  [SANDBOX_ROW]: ['sandbox'],
  'delo-fetch-guard': ['fetchGuard'],
  'delo-update-gate': [TURN_GATE_SERVICE],
  'delo-instruction-consent': ['writeConsent'],
  'delo-mcp-consent': ['mcpAddConsent'],
  'delo-schedule-consent': ['scheduleConsent'],
  'delo-permission-defaults': ['permissionDefaults', 'sandboxModeGuard'],
}

/**
 * Compose the profile a Host boots over this home.
 * @param request - the home, the profile, its kind, the output and the environment.
 * @param dependencies - the profile preparation and the approved plugin content step.
 * @returns the composed start.
 * @throws {CliError} when the profile cannot be loaded or skipped a Delo bundle, a layer sets the sandbox runner or
 *   carries expressions on the row, the approved content step refuses, or the composed rows break an invariant.
 */
export async function composeDeloProfile(request: ComposeRequest, dependencies: ComposeDependencies): Promise<ComposedStart> {
  let resolvedProfile: ResolvedProfileRuntime
  try {
    resolvedProfile = await dependencies.prepareProfile(request.profile)
    refuseSkippedDeloBundles(resolvedProfile.profile)
  } catch (error) {
    if (error instanceof CliError) throw error
    throw new CliError(EXIT.failed, `delorun: the profile ${request.profile} could not be loaded: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (request.kind === 'headless') refuseHeadlessWithoutBundle(request.home, resolvedProfile)
  const deloRows = deloRowIds(resolvedProfile.profile)
  // Safe mode boots the same profile with its third-party layers and rows left out, and edits none of its files.
  const safe = safeModeStart({ home: request.home, profile: request.profile, resolvedProfile })
  if (safe !== undefined) {
    request.output.stdout(safeModeNotice(safe))
    resolvedProfile = safe.resolvedProfile
  }
  const before = safe?.patchFiles ?? []
  const approved = await dependencies.approvedPluginContent({ request, resolvedProfile, patchFiles: before, safe })
  const protection = await sandboxProtection(request.home, request.profile, request.env, request.osHome ?? homedir())
  const others = [...before, ...approved]
  const overlay = await writeSandboxOverlay(request.home, request.profile, resolvedProfile.profile, others, protection)
  const patchFiles = [...others, overlay]
  const prompts = request.kind === 'cli' ? readPromptsAnswer(join(request.home, 'profiles', request.profile)) : undefined
  const values = new Map<string, Readonly<Record<string, unknown>>>(prompts === undefined
    ? Object.entries(HEADLESS_ROW_VALUES)
    : [...promptRows(prompts).map(row => [row.id, row.config] as const), ...Object.entries(GUARD_ROWS)])
  const layers = patchLayers(request.home, resolvedProfile.profile, patchFiles)
  const composed: ComposedStart = {
    request,
    resolvedProfile,
    patchFiles,
    safe,
    protection,
    layers,
    required: [SANDBOX_ROW, ...deloRows].map(id => ({ id, name: declaredName(layers, id) })),
    values,
    prompts,
  }
  assertComposedInvariants(composed)
  return composed
}

/**
 * Refuse a `headless` profile that does not load `@delo/bundle-headless`: its task would run without Delo's guards.
 * @param home - the Delo home.
 * @param resolvedProfile - the prepared profile.
 * @throws {CliError} naming the bundle and the remedy.
 */
function refuseHeadlessWithoutBundle(home: string, resolvedProfile: ResolvedProfileRuntime): void {
  if (resolvedProfile.profile.layers.some(layer => layer.packageName === HEADLESS_BUNDLE)) return
  const record = migrationsPath(home, resolvedProfile.profile.name)
  throw new CliError(EXIT.failed, [
    `delorun headless: the ${resolvedProfile.profile.name} profile does not load Delo's headless bundle ${HEADLESS_BUNDLE}, which holds the guards a headless task runs under, so Delo did not start the task.`,
    `To fix it, remove ${record} so that the next delorun headless adds the bundle again, or remove the folder ${resolvedProfile.profile.dir} so that Delo creates the profile again with it.`,
  ].join('\n'))
}

/**
 * Whether a layer is the bundle that declares a required row.
 * @param layer - the layer.
 * @param id - the row's id.
 * @returns true for upstream's base bundle and the `sandbox` row, and for a Delo bundle and any other required row.
 */
function declares(layer: PatchLayer, id: string): boolean {
  if (layer.packageName === undefined) return false
  return id === SANDBOX_ROW ? layer.packageName === SANDBOX_BUNDLE : isDeloPackage(layer.packageName)
}

/**
 * The plugin the declaring bundle names for a required row.
 * @param layers - the layers.
 * @param id - the row's id.
 * @returns the name of the first insert of the row, when the declaring bundle made it; otherwise `undefined`.
 */
function declaredName(layers: readonly PatchLayer[], id: string): string | undefined {
  for (const layer of layers) {
    const insert = rowInserts(layer.patches, id)[0]
    if (insert === undefined) continue
    return declares(layer, id) && typeof insert.name === 'string' ? insert.name : undefined
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
  if (!declares(first.layer, row.id)) {
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
        : id in GUARD_ROWS ? 'which stays on whatever the prompts answer' : `which the recorded prompts answer "${composed.prompts === 'stock' ? 'Same as stock' : 'Safer prompts'}" sets`
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
    `delorun: the profile ${profile} would ${booted ? 'run' : 'boot'} without protections Delo requires, so Delo ${booted ? 'stopped it' : 'did not start it'}:`,
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
  const violations = violationsOf(composed, composedRows(composed))
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
      return provider.row === id ? [] : [{ subject: service, problem: `is provided by ${provider.row === undefined ? 'no plugin row' : `the row ${provider.row}`}, not by ${id}`, sources: provider.row === undefined ? [] : sourcesSetting(composed.layers, provider.row, () => true) }]
    }
    const row = byId.get(id)
    if (row === undefined || row.disabled || (isRecord(row.config) && row.config.enabled === false)) return []
    return [{ subject: service, problem: id === 'delo-update-gate' ? 'is not provided, so an update or a stop could not refuse new turns while it waits' : `is not provided by ${id}`, sources: [] }]
  }))
}

/**
 * Hold a booted Host to the invariants: what mounted, not only what was composed.
 * @param composed - the composed start the Host booted.
 * @param host - the booted Host.
 * @throws {CliError} naming each violation, the files that set it and the remedy; the caller stops the Host.
 */
export function assertDeloInvariants(composed: ComposedStart, host: BootedHost): void {
  const violations = [...violationsOf(composed, host.rows()), ...serviceViolations(composed, host)]
  if (violations.length > 0) throw refusal(composed.request.profile, violations, true)
}
