/**
 * What importing a setup would do to a profile, computed from the archive's document and the profile's files and
 * written nowhere. The import replaces the profile's whole setup: every plugin of the person's that the archive lacks
 * is removed, and every carried settings entry the archive lacks goes back to its default. The plan lists each of
 * those, so the person sees what is lost before they are asked.
 *
 * @module @delorun/changes/setup-transfer/plan
 */
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { SetupDocument, SetupLocalPlugin, SetupPlugin, SetupRegistryPlugin } from '@delorun/archive'
import { dependenciesOf, isLocalSpec } from '@delorun/profile-safety'
import { isDeepStrictEqual } from 'node:util'
import { Document, isMap, isSeq, parseDocument, YAMLSeq } from 'yaml'
import type { ChangesContext } from '../actions.ts'
import { ChangesError } from '../errors.ts'
import { readProfileManifest } from '../link.ts'
import { approvedOf, readApproved } from '../records.ts'
import { readVersion } from '../store.ts'
import { composedRowIds } from './composed-ids.ts'
import { entryClass, entryLabel, isModelEntry, isPlainObject, isProductPackage, judgeEntry, offDefaultEndpoints, routeFields, type LeftOutItem, type PatchEntry } from './policy.ts'

/** What the person chose for an import. */
export interface ImportOptions {
  /** Whether the archive's settings replace the profile's; ignored when the archive includes none. The model always does. */
  readonly settings: boolean
  /** Whether plugins the archive does not list are removed; otherwise only the plugins it lists are touched. */
  readonly removeOthers: boolean
  /** Whether the person confirmed that requests and the provider's key go to each endpoint that is not the provider's default; an import with such an endpoint refuses without it. */
  readonly endpointsConfirmed?: boolean
}

/** The choices an import makes when the person gives none: settings replaced, no other plugin removed. */
export const DEFAULT_IMPORT_OPTIONS: ImportOptions = { settings: true, removeOthers: false }

/** What the profile has now for a plugin the import moves, as a code the studio words in the person's language. */
export type PluginWas =
  | { readonly kind: 'version', readonly version: string }
  | { readonly kind: 'not-installed', readonly spec: string }
  | { readonly kind: 'registry', readonly spec: string }
  | { readonly kind: 'local' | 'local-unapproved' | 'local-other' }

/** A part of the setup an import replaces, as a code. */
export type ReplaceCode = 'plugins-listed' | 'plugins-all' | 'model' | 'settings' | 'settings-off' | 'settings-none'

/** One settings entry an import sets, changes or takes back to its default. */
export interface SettingChange {
  readonly kind: 'set' | 'changed' | 'default'
  readonly label: string
}

/** A key the person adds after an import: the default model's provider, or a variable a provider reads. */
export type KeyItem =
  | { readonly kind: 'model', readonly provider: string, readonly model?: string }
  | { readonly kind: 'variable', readonly name: string }

/** An endpoint the imported model settings send requests to. */
export interface EndpointItem {
  readonly field: string
  readonly url: string
}

/** An endpoint other than a provider's default that the imported settings send requests, and the provider's key, to. */
export interface EndpointNotice {
  readonly provider: string
  readonly host: string
}

/** One plugin the import adds or moves. */
export interface PluginInstall {
  readonly plugin: SetupPlugin
  /** `add` when the profile has no such plugin, `replace` when it has one at another version or from another source. */
  readonly kind: 'add' | 'replace'
  /** What the profile has now, in words; absent for `add`. */
  readonly from?: string
  /** The same as a code. */
  readonly was?: PluginWas
}

/** What importing a setup does to one profile. */
export interface SetupPlan {
  /** The plugins to add or move, in the archive's order. */
  readonly install: readonly PluginInstall[]
  /** Plugins the archive names without their code, which the person copies themselves. */
  readonly named: readonly string[]
  /** The parts of the setup this import replaces, in words. */
  readonly replaces: readonly string[]
  /** The same as codes. */
  readonly replaceCodes: readonly ReplaceCode[]
  /** The settings entries this import sets, changes or takes back to their defaults. */
  readonly settingChanges: readonly SettingChange[]
  /** The settings entries of the archive a setup does not carry, as codes. */
  readonly leftOutItems: readonly LeftOutItem[]
  /** The keys to add afterwards, as codes. */
  readonly keyItems: readonly KeyItem[]
  /** The endpoints, as fields. */
  readonly endpointItems: readonly EndpointItem[]
  /** The endpoints the person confirms separately: each provider and host that is not the provider's default. */
  readonly endpointNotices: readonly EndpointNotice[]
  /** The plugins the profile already has exactly as the archive names them. */
  readonly keep: readonly string[]
  /** The plugins of the person's the archive lacks, which the import removes. */
  readonly remove: readonly string[]
  /** One sentence for each carried settings entry the import sets, changes or takes back to its default. */
  readonly settings: readonly string[]
  /** The settings entries of the archive that a setup does not carry, one sentence each; they are not applied. */
  readonly leftOut: readonly string[]
  /** What the person must do about a model key after the import. */
  readonly keyNotes: readonly string[]
  /** Endpoints the imported model settings send requests to, which the person reads before agreeing. */
  readonly endpoints: readonly string[]
  /** Whether the import changes any file of the profile. */
  readonly changes: boolean
}

/** The carried-class entries of a profile's patch, with the YAML nodes the import keeps or replaces. */
export interface PatchPlan {
  /** The text the profile's patch file gets. */
  readonly text: string
  /** Whether the text differs from the file. */
  readonly changed: boolean
  /** The sentences for {@link SetupPlan.settings}. */
  readonly lines: readonly string[]
  /** The same as fields. */
  readonly changes: readonly SettingChange[]
}

/**
 * Plan an import.
 * @param ctx - the profile.
 * @param document - the setup document an archive passed validation with.
 * @param options - what the person chose.
 * @param removedAlready - plugins the import has removed from the manifest already, whose rows are still the import's to take away.
 * @returns the plan and the text the profile's patch file would get.
 * @throws {ChangesError} `SETUP_REFUSED` for a plugin of Delorun's or upstream's scope, an entry that holds a credential, or a patch file that is not a YAML list; `RECORD_UNREADABLE` when the profile's manifest cannot be read.
 */
export async function planSetupImport(ctx: ChangesContext, document: SetupDocument, options: ImportOptions = DEFAULT_IMPORT_OPTIONS, removedAlready: readonly string[] = []): Promise<{ readonly plan: SetupPlan, readonly patch: PatchPlan }> {
  for (const plugin of document.plugins) {
    if (isProductPackage(plugin.name)) {
      throw new ChangesError('SETUP_REFUSED', plugin.name, `The setup names ${plugin.name}, a package of Delorun's own. A setup carries plugins you added, never the product itself.`)
    }
  }
  const manifest = await readProfileManifest(ctx.profileDir)
  const dependencies = dependenciesOf(manifest)
  const approved = await readApproved(ctx.profileDir)
  const wanted = new Set(document.plugins.map(plugin => plugin.name))
  const install: PluginInstall[] = []
  const keep: string[] = []
  const named: string[] = []
  const withSettings = options.settings && document.includesSettings
  for (const plugin of document.plugins) {
    const spec = Object.hasOwn(dependencies, plugin.name) ? dependencies[plugin.name] : undefined
    if (plugin.source === 'local' && plugin.files.length === 0) {
      // A plugin the profile already links and has approved stays as it is: it is kept, not left for the person to copy.
      if (spec !== undefined && isLocalSpec(spec) && approvedOf(approved, plugin.name) !== undefined) keep.push(plugin.name)
      else named.push(plugin.name)
      continue
    }
    const now = spec === undefined ? undefined : await currentState(ctx, plugin, spec, approved)
    if (now?.same === true) keep.push(plugin.name)
    else install.push({ plugin, kind: spec === undefined ? 'add' : 'replace', ...now === undefined ? {} : { from: now.words, was: now.was } })
  }
  const remove = options.removeOthers ? Object.keys(dependencies).filter(name => !isProductPackage(name) && !wanted.has(name)) : []
  const known = new Set([...wanted, ...removedAlready, ...Object.keys(dependencies).filter(name => !isProductPackage(name))])
  const reserved = composedRowIds(ctx.profileDir)
  const leftOut: string[] = []
  const leftOutItems: LeftOutItem[] = []
  const carried: PatchEntry[] = []
  for (const entry of withSettings ? [...document.models, ...document.settings] : document.models) {
    const verdict = judgeEntry(entry, wanted, reserved)
    if (verdict.carry) carried.push(entry)
    else if (verdict.secret === true) throw new ChangesError('SETUP_REFUSED', 'setup', `Nothing was imported: ${verdict.reason}. A setup never carries a key.`)
    else {
      leftOut.push(verdict.reason)
      leftOutItems.push({ subject: verdict.label, code: verdict.code })
    }
  }
  const stay = new Set(Object.keys(dependencies).filter(name => !isProductPackage(name) && !wanted.has(name) && !remove.includes(name)))
  const patch = await planPatch(ctx.profileDir, carried, known, withSettings, reserved, stay)
  const plan: SetupPlan = {
    install, keep, remove, named,
    replaces: [
      ...document.plugins.length > 0 ? [options.removeOthers ? 'plugins (the ones the file does not list are removed)' : 'the plugins the file lists (others stay)'] : [],
      'model provider and model choices',
      ...withSettings ? ['other settings'] : [document.includesSettings ? 'other settings stay as they are (not included by you)' : 'other settings stay as they are (the file has none)'],
    ],
    replaceCodes: [
      ...document.plugins.length > 0 ? [options.removeOthers ? 'plugins-all' as const : 'plugins-listed' as const] : [],
      'model' as const,
      withSettings ? 'settings' as const : document.includesSettings ? 'settings-off' as const : 'settings-none' as const,
    ],
    settingChanges: patch.changes,
    leftOutItems,
    keyItems: keyItems(carried),
    endpointItems: endpointItems(carried),
    endpointNotices: endpointNotices(carried),
    settings: patch.lines,
    leftOut,
    keyNotes: keyNotes(carried),
    endpoints: endpointsOf(carried).map(({ field, url }) => `${field} sends requests to ${url}`),
    changes: install.length > 0 || remove.length > 0 || patch.changed,
  }
  return { plan, patch }
}

/** Whether the profile has a plugin as the setup names it, and what it has now. */
interface StateOf {
  readonly same: boolean
  readonly words: string
  readonly was: PluginWas
}

/**
 * Whether the profile already has a plugin as the setup names it.
 * @param ctx - the profile.
 * @param plugin - the plugin the setup names.
 * @param spec - the spec the profile's manifest holds for it.
 * @param approved - the profile's approved plugins.
 * @returns whether they are the same, and what the profile has now in words.
 */
async function currentState(ctx: ChangesContext, plugin: SetupPlugin, spec: string, approved: Awaited<ReturnType<typeof readApproved>>): Promise<StateOf> {
  if (plugin.source === 'registry') return registryState(ctx.profileDir, plugin, spec)
  return localState(ctx, plugin, spec, approved)
}

/**
 * @param profileDir - the profile directory.
 * @param plugin - a registry plugin of the setup.
 * @param spec - the profile's spec for it.
 * @returns whether the installed version is the one named.
 */
async function registryState(profileDir: string, plugin: SetupRegistryPlugin, spec: string): Promise<StateOf> {
  if (isLocalSpec(spec)) return { same: false, words: 'a plugin made on this computer', was: { kind: 'local' } }
  const path = join(profileDir, 'node_modules', plugin.name, 'package.json')
  let version: unknown
  try {
    version = existsSync(path) ? (JSON.parse(await readFile(path, 'utf8')) as { version?: unknown }).version : undefined
  } catch {
    // An unreadable package.json counts as no installed version, so the plugin is installed again.
    version = undefined
  }
  const installed = typeof version === 'string' ? version : undefined
  return { same: installed === plugin.version, words: installed === undefined ? `${spec}, not installed` : `version ${installed}`, was: installed === undefined ? { kind: 'not-installed', spec } : { kind: 'version', version: installed } }
}

/**
 * @param ctx - the profile.
 * @param plugin - a local plugin of the setup.
 * @param spec - the profile's spec for it.
 * @param approved - the profile's approved plugins.
 * @returns whether the profile's approved copy holds exactly the archive's files.
 */
async function localState(ctx: ChangesContext, plugin: SetupLocalPlugin, spec: string, approved: Awaited<ReturnType<typeof readApproved>>): Promise<StateOf> {
  if (!isLocalSpec(spec)) return { same: false, words: `version ${spec} from a registry`, was: { kind: 'registry', spec } }
  const approval = approvedOf(approved, plugin.name)
  if (approval === undefined) return { same: false, words: 'a plugin made on this computer, not approved yet', was: { kind: 'local-unapproved' } }
  const held = await readVersion(ctx.home, approval.version)
  const files = held.entries.flatMap(entry => entry.type === 'file' ? [`${entry.path}:${entry.digest}:${String(entry.executable)}`] : [])
  const wanted = plugin.files.map(file => `${file.path}:${file.sha256}:${String(file.executable)}`)
  const same = held.entries.every(entry => entry.type === 'file') && isDeepStrictEqual([...files].sort(), [...wanted].sort())
  return { same, words: 'a plugin made on this computer, with other content', was: { kind: 'local-other' } }
}

/**
 * The text the profile's patch file gets: every entry of the carried class is replaced by the setup's entries, and
 * every other entry stays where it is, with its comments and expressions.
 * @param profileDir - the profile directory.
 * @param carried - the setup's entries.
 * @param known - the plugins the profile will have, whose rows are of the carried class.
 * @param withSettings - whether the setup's other settings are replaced, not only the model's.
 * @param reserved - the row ids the profile's bundles hold.
 * @param stay - the plugins the profile keeps that the setup does not list, whose rows the import leaves as they are.
 * @returns the new text and the sentences naming each difference.
 * @throws {ChangesError} `SETUP_REFUSED` when the file is not a YAML list of patch entries.
 */
async function planPatch(profileDir: string, carried: readonly PatchEntry[], known: ReadonlySet<string>, withSettings: boolean, reserved: ReadonlySet<string>, stay: ReadonlySet<string>): Promise<PatchPlan> {
  const path = join(profileDir, 'cordis.patch.yml')
  const before = existsSync(path) ? await readFile(path, 'utf8') : ''
  const document = parseDocument(before === '' ? '[]\n' : before, { logLevel: 'silent' })
  if (document.errors.length > 0) throw new ChangesError('SETUP_REFUSED', path, "The profile's cordis.patch.yml is not YAML, so a setup cannot be imported into it.")
  const items = document.contents ?? new YAMLSeq()
  if (!isSeq(items)) throw new ChangesError('SETUP_REFUSED', path, "The profile's cordis.patch.yml is not a list of patch entries, so a setup cannot be imported into it.")
  const current = new Map<string, unknown>()
  const kept: unknown[] = []
  for (const item of items.items) {
    const entry: unknown = isMap(item) ? item.toJSON() : undefined
    if (isPlainObject(entry) && !rowsStay(entry, stay) && entryClass(entry, known, reserved) && (withSettings || isModelEntry(entry))) current.set(keyOf(entry), entry)
    else kept.push(item)
  }
  const lines: string[] = []
  const changes: SettingChange[] = []
  const wanted = new Map(carried.map(entry => [keyOf(entry), entry]))
  for (const [key, entry] of wanted) {
    const had = current.get(key)
    if (had === undefined) { lines.push(`set: ${entryLabel(entry)}`); changes.push({ kind: 'set', label: entryLabel(entry) }) }
    else if (!isDeepStrictEqual(had, entry)) { lines.push(`changed: ${entryLabel(entry)}`); changes.push({ kind: 'changed', label: entryLabel(entry) }) }
  }
  for (const [key, entry] of current) {
    if (!wanted.has(key)) { lines.push(`back to its default: ${entryLabel(entry as PatchEntry)}`); changes.push({ kind: 'default', label: entryLabel(entry as PatchEntry) }) }
  }
  const rewritten = new YAMLSeq<unknown>()
  for (const node of kept) rewritten.add(node)
  for (const entry of carried) rewritten.add(document.createNode(entry))
  const after = lines.length === 0 ? before : new Document(rewritten).toString({ lineWidth: 0 })
  return { text: after, changed: lines.length > 0, lines, changes }
}

/**
 * @param entry - a patch entry.
 * @returns the key two entries share when they set the same rows.
 */
function keyOf(entry: PatchEntry): string {
  if (typeof entry['id'] === 'string') return `id:${entry['id']}${typeof entry['name'] === 'string' ? `@${entry['name']}` : ''}`
  const names = Array.isArray(entry['insert']) ? entry['insert'].map(row => isPlainObject(row) ? `${String(row['id'] ?? '')}@${String(row['name'] ?? '')}` : '?') : []
  return `insert:${names.join(',')}`
}

/**
 * What to tell the person about the keys the imported model settings read: the default model's provider, and every
 * variable a route reads its key from. The key itself is never in a setup.
 * @param carried - the setup's carried entries.
 * @returns the sentences; empty when the setup sets no model.
 */
function keyNotes(carried: readonly PatchEntry[]): string[] {
  const notes: string[] = []
  for (const entry of carried) {
    const config = isPlainObject(entry['config']) ? entry['config'] : {}
    if (entry['id'] === 'agent-default-model' && typeof config['provider'] === 'string') {
      notes.push(`The default model is ${config['provider']}${typeof config['model'] === 'string' ? ` / ${config['model']}` : ''}. Add its key with delorun setup key, or in the studio under Settings → Agent → Models; no key comes with a setup.`)
    }
    for (const name of keyVariables(config)) notes.push(`A provider reads its key from ${name}.`)
  }
  return [...new Set(notes)]
}

/**
 * @param config - a row's config.
 * @returns each `apiKeyEnv` value it holds, at any depth.
 */
function keyVariables(config: unknown): string[] {
  if (Array.isArray(config)) return config.flatMap(item => keyVariables(item))
  if (!isPlainObject(config)) return []
  return Object.entries(config).flatMap(([key, value]) => key === 'apiKeyEnv' && typeof value === 'string' ? [value] : keyVariables(value))
}

/**
 * @param carried - the setup's carried entries.
 * @returns each endpoint the entries name, as `<field> sends requests to <URL>`.
 */
function endpointsOf(carried: readonly PatchEntry[]): { field: string, url: string }[] {
  return carried.flatMap(entry => rowsOf(entry).flatMap(row => routeFields(row).flatMap(({ kind, field, value }) => kind === 'endpoint' ? [{ field: `${entryLabel(entry)}.${field}`, url: value }] : [])))
}

/**
 * @param entry - a carried patch entry.
 * @returns the entry itself, or the rows it inserts.
 */
function rowsOf(entry: PatchEntry): PatchEntry[] {
  const inserted = entry['insert']
  return Array.isArray(inserted) ? inserted.filter(isPlainObject) : [entry]
}

/**
 * @param entry - a patch entry of the profile.
 * @param stay - the plugins the profile keeps that the setup does not list.
 * @returns whether it only inserts rows of plugins the import keeps without listing them, which the import leaves alone.
 */
function rowsStay(entry: PatchEntry, stay: ReadonlySet<string>): boolean {
  const inserted = entry['insert']
  return Array.isArray(inserted) && inserted.length > 0 && inserted.every(row => isPlainObject(row) && typeof row['name'] === 'string' && stay.has(row['name']))
}

/**
 * @param carried - the setup's carried entries.
 * @returns each provider and host the entries send requests to that is not the provider's default, without repeats.
 */
function endpointNotices(carried: readonly PatchEntry[]): EndpointNotice[] {
  const found = carried.flatMap(entry => rowsOf(entry).flatMap(row => offDefaultEndpoints(row)))
  return found.filter((item, at) => found.findIndex(other => other.provider === item.provider && other.host === item.host) === at)
}

/**
 * The keys to add after the import, as codes.
 * @param carried - the setup's carried entries.
 * @returns the default model's provider and each variable a provider reads its key from.
 */
function keyItems(carried: readonly PatchEntry[]): KeyItem[] {
  const items: KeyItem[] = []
  for (const entry of carried) {
    const config = isPlainObject(entry['config']) ? entry['config'] : {}
    if (entry['id'] === 'agent-default-model' && typeof config['provider'] === 'string') {
      items.push({ kind: 'model', provider: config['provider'], ...typeof config['model'] === 'string' ? { model: config['model'] } : {} })
    }
    for (const name of keyVariables(config)) items.push({ kind: 'variable', name })
  }
  return items.filter((item, at) => items.findIndex(other => JSON.stringify(other) === JSON.stringify(item)) === at)
}

/**
 * The endpoints the carried entries name, as fields.
 * @param carried - the setup's carried entries.
 * @returns each field and the URL it holds.
 */
function endpointItems(carried: readonly PatchEntry[]): EndpointItem[] {
  return endpointsOf(carried).map(({ field, url }) => ({ field, url }))
}
