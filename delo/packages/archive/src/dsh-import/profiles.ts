/**
 * The profiles of a stock home as the import carries them. A profile lands
 * only after the person says yes to its profiles, and nothing in it runs on
 * the way: its manifest is written again with a name, `private`, the
 * dependencies that name a registry package by a version range or a tag, and
 * the bundle list, and nothing else, so no script, pnpm setting, override or
 * path reaches the Delo home. A dependency installed from a path, a link, a
 * git address, a URL or an alias is not carried and is listed for the person
 * to add again. The version exemptions, the lockfile and the build approvals
 * stay behind, so an install resolves the plugins again and runs a plugin's
 * install script only after the person approves it. The import appends Delo's
 * own bundles to the bundle list, so the profile runs with Delo's privacy
 * defaults.
 *
 * The carry check of `@delo/profile-safety` compares the profile the person
 * had with the profile as it lands, under the home patch it runs with in the
 * Delo home. It reads texts the guarded reader read once, written into a
 * private scratch directory, so nothing is read from the stock home a second
 * time by path.
 *
 * @module @delo/archive/dsh-import/profiles
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { OPTIONAL_BUNDLES, ON_DEMAND_BUNDLES, PROFILE_TEMPLATES, RETIRED_BUNDLES } from '@deepseek-ai/dsh-official-bundles'
import { bundleListOf, dependenciesOf, isProfileSafetyError, planCarry, readInventory, type CarryRefusal, type ProfileInventory } from '@delo/profile-safety'
import semver from 'semver'

/** The scope of Delo's own bundles and plugins. */
const DELO_SCOPE = '@delo/'

/** What the import does with one bundle or plugin a profile names. */
export type DshImportPluginStatus = 'carried' | 'install' | 'added' | 'not-carried'

/** One bundle or plugin of a carried profile. */
export interface DshImportPlugin {
  /** The package name, as the manifest wrote it. */
  readonly name: string
  /** A bundle of `dsh.profile.bundles`, or a plugin package the manifest depends on. */
  readonly kind: 'bundle' | 'plugin'
  /** Carried and loads as it is, to install after the import, added by the import, or not carried. */
  readonly status: DshImportPluginStatus
  /** Why, in a phrase the preview prints after the status. */
  readonly note: string
}

/** One profile's manifest as it lands. */
export interface LandedManifest {
  /** The manifest's text: two-space JSON with a trailing newline. */
  readonly text: string
  /** The bundle list as it lands: the stock list without the bundles it does not carry, then Delo's. */
  readonly bundles: readonly string[]
  /** Every bundle and plugin, in the order the manifest names them, then Delo's. */
  readonly plugins: readonly DshImportPlugin[]
}

/** The bundles a DeepSeek Harness installation carries, so a profile that names one loads it without an install. */
const SHIPPED_BUNDLES: ReadonlySet<string> = new Set([...Object.values(PROFILE_TEMPLATES).flatMap(template => template.bundles), ...OPTIONAL_BUNDLES])

/** The official bundles installed on demand. */
const ON_DEMAND: ReadonlySet<string> = new Set(ON_DEMAND_BUNDLES)

/** An npm package name: lowercase, an optional scope, and no character a path or a shell gives meaning to. */
const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/u

/** The longest npm package name. */
const MAX_PACKAGE_NAME = 214

/** A dist-tag: a word that is not a version range. */
const DIST_TAG = /^[A-Za-z][A-Za-z0-9._-]{0,63}$/u

/**
 * Whether a name is an npm package name the import carries.
 * @param name - a dependency or bundle name.
 * @returns true for a valid lowercase package name of at most 214 characters.
 */
export function isPackageName(name: string): boolean {
  return name.length <= MAX_PACKAGE_NAME && PACKAGE_NAME.test(name)
}

/**
 * Whether a dependency spec resolves a package from the registry: a version range or a dist-tag.
 * @param spec - the dependency spec.
 * @returns false for a path, a link, a git address, a URL, an alias and anything else that names where code comes from.
 */
export function isRegistrySpec(spec: string): boolean {
  return semver.validRange(spec) !== null || DIST_TAG.test(spec)
}

/**
 * Write one stock manifest again as it lands.
 * @param manifest - the parsed stock manifest.
 * @param profile - the profile's name, which names the landed package.
 * @param path - the manifest's home-relative path, for the refusal of a bundle list that is not a list.
 * @param deloBundles - the bundles Delo appends to every carried profile.
 * @returns the landed manifest, its bundle list and every package with its status.
 * @throws ProfileSafetyError `PROFILE_UNREADABLE` when `dsh.profile.bundles` is not a list of names.
 */
export function landManifest(manifest: unknown, profile: string, path: string, deloBundles: readonly string[]): LandedManifest {
  const stock = bundleListOf(manifest, path)
  const declared = dependenciesOf(manifest)
  const dependencies: Record<string, string> = {}
  const plugins: DshImportPlugin[] = []
  const dropped = new Set<string>()
  for (const [name, spec] of Object.entries(declared)) {
    if (isPackageName(name) && isRegistrySpec(spec)) dependencies[name] = spec
    else dropped.add(name)
  }
  const bundles: string[] = []
  for (const name of stock) {
    const plugin = { name, kind: 'bundle' as const, ...bundleStatus(name, declared[name], dropped.has(name)) }
    plugins.push(plugin)
    if (plugin.status !== 'not-carried') bundles.push(name)
  }
  for (const [name, spec] of Object.entries(declared)) {
    if (stock.includes(name)) continue
    plugins.push({ name, kind: 'plugin', ...dropped.has(name) ? notCarried(name, spec) : { status: 'install', note: `from the registry, ${spec}` } })
  }
  const added = deloBundles.filter(name => !bundles.includes(name))
  for (const name of added) plugins.push({ name, kind: 'bundle', status: 'added', note: 'Delo\'s own bundle, which keeps Delo\'s privacy defaults in this profile' })
  const landed = { name: `dsh-profile-${profile}`, private: true, dependencies, dsh: { profile: { bundles: [...bundles, ...added] } } }
  return { text: `${JSON.stringify(landed, undefined, 2)}\n`, bundles: landed.dsh.profile.bundles, plugins }
}

/**
 * What the import does with one bundle of the stock list.
 * @param name - the bundle's package name.
 * @param spec - the manifest's dependency spec for it, if it declares one.
 * @param dropped - whether that dependency is not carried.
 * @returns its status and note.
 */
function bundleStatus(name: string, spec: string | undefined, dropped: boolean): Pick<DshImportPlugin, 'status' | 'note'> {
  if (!isPackageName(name)) return { status: 'not-carried', note: 'not a package name' }
  if (RETIRED_BUNDLES.has(name)) return { status: 'not-carried', note: 'retired by DeepSeek Harness' }
  if (name.startsWith(DELO_SCOPE)) return { status: 'carried', note: 'ships with Delo' }
  if (SHIPPED_BUNDLES.has(name)) return { status: 'carried', note: 'ships with DeepSeek Harness' }
  if (dropped) return notCarried(name, spec as string)
  if (spec !== undefined) return { status: 'install', note: `from the registry, ${spec}` }
  if (ON_DEMAND.has(name)) return { status: 'install', note: 'an official bundle installed on demand' }
  return { status: 'install', note: 'the stock profile does not say where it comes from; add it by name' }
}

/**
 * The status of a dependency the import does not carry.
 * @param name - the dependency's name.
 * @param spec - its spec.
 * @returns `not-carried`, with where it came from and what to do.
 */
function notCarried(name: string, spec: string): Pick<DshImportPlugin, 'status' | 'note'> {
  if (!isPackageName(name)) return { status: 'not-carried', note: 'not a package name' }
  return { status: 'not-carried', note: `installed from ${JSON.stringify(spec)}, which is not a registry version; if you trust it, add it again yourself` }
}

/** The texts the carry check reads for one profile, each read once through the guarded reader. */
export interface CarryTexts {
  /** The stock manifest. */
  readonly stockManifest: string
  /** The stock profile patch, or `undefined` when the profile has none. */
  readonly stockPatch: string | undefined
  /** The stock home patch, or `undefined` when the stock home has none the import reads. */
  readonly stockHomePatch: string | undefined
  /** The manifest as it lands. */
  readonly landedManifest: string
  /** The profile patch as it lands, or `undefined` when none lands. */
  readonly landedPatch: string | undefined
  /** The home patch the profile runs under in the Delo home, `undefined` for none, and `null` when the Delo home holds one that is not a plain file the import reads. */
  readonly landedHomePatch: string | null | undefined
  /** The bundle list as the profile lands. */
  readonly bundles: readonly string[]
  /** Whether {@link landedHomePatch} is the Delo home's own home patch rather than the carried rows of the stock one. */
  readonly ownHomePatch: boolean
}

/** The note of a profile whose layers the carry check cannot read. */
const UNREADABLE_NOTE = 'A patch layer this profile runs under cannot be read, so whether its rows carry is not known; check the profile after the import.'

/**
 * Run the carry check over one profile, and say in a person's words what does not carry.
 * @param texts - the stock and landed manifests and patch layers.
 * @returns one sentence per row or setting that does not carry, empty when everything carries.
 */
export function carryNotes(texts: CarryTexts): string[] {
  if (texts.landedHomePatch === null) return [UNREADABLE_NOTE]
  const landedHomePatch = texts.landedHomePatch
  const scratch = mkdtempSync(join(tmpdir(), 'delo-dsh-carry-'))
  try {
    const inventory = (side: string, manifest: string, patch: string | undefined, homePatch: string | undefined): ProfileInventory => {
      const home = join(scratch, side)
      const profileDir = join(home, 'profile')
      mkdirSync(profileDir, { recursive: true, mode: 0o700 })
      writeFileSync(join(profileDir, 'package.json'), manifest, { mode: 0o600 })
      if (patch !== undefined) writeFileSync(join(profileDir, 'cordis.patch.yml'), patch, { mode: 0o600 })
      if (homePatch !== undefined) writeFileSync(join(home, 'cordis.patch.yml'), homePatch, { mode: 0o600 })
      return readInventory({ profileDir, homeDir: home })
    }
    let before: ProfileInventory
    let after: ProfileInventory
    try {
      before = inventory('stock', texts.stockManifest, texts.stockPatch, texts.stockHomePatch)
      after = inventory('landed', texts.landedManifest, texts.landedPatch, landedHomePatch)
    } catch (error: unknown) {
      if (!isProfileSafetyError(error)) throw error
      return [UNREADABLE_NOTE]
    }
    // Delo's bundles are the one change to the bundle list the import makes, and the preview states them.
    const plan = planCarry({ ...before, bundles: texts.bundles }, { ...after, bundles: texts.bundles })
    return plan.refusals.flatMap(refusal => carryRefusalNotes(refusal, texts.ownHomePatch))
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

/**
 * The sentences of one carry refusal about a row or settings. A refusal about a local plugin is not repeated here,
 * because the profile's plugin list already names every plugin the import does not carry.
 * @param refusal - the refusal.
 * @param ownHomePatch - whether the profile runs under the Delo home's own home patch rather than the carried rows of the stock one.
 * @returns one sentence per subject, none for a refusal of another kind.
 */
export function carryRefusalNotes(refusal: CarryRefusal, ownHomePatch: boolean): string[] {
  if (!['UNNAMED_CHANGE', 'ROW_NOT_CARRIED', 'CONFIGURATION_NOT_CARRIED'].includes(refusal.code)) return []
  return refusal.subjects.map((subject) => {
    const what = `${subject.kind === 'row' ? 'row' : 'settings for'} ${subject.name}`
    if (refusal.code === 'UNNAMED_CHANGE') return `The Delo home patch's ${what} will apply to this profile too.`
    if (subject.layer === 'home-patch') return `The stock home patch's ${what} will not apply: ${ownHomePatch ? 'the Delo home keeps its own home patch' : 'it is held back'}.`
    return `${subject.kind === 'row' ? `The row ${subject.name} does` : `The settings for ${subject.name} do`} not land in this profile: ${subject.kind === 'row' ? 'it is' : 'they are'} held back.`
  })
}
