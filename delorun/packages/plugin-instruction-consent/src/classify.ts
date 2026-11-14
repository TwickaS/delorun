/**
 * The instruction-layer classifier of `@delorun/plugin-instruction-consent`, free
 * of Cordis: it decides whether one write target is an instruction-layer file
 * — a skill, a preset or an instruction file (`AGENTS.md`, `CLAUDE.md` and the
 * loader's other default names), the glossary's definition — and builds the
 * note that names the effect and carries the diff. A target that classifies as
 * none of the three is no instruction-layer file, and the review that consults
 * this module answers `undefined`, so the mutation runs exactly as upstream
 * runs it.
 *
 * The classifier compares the target against the locations the harness reads
 * instructions from — the instruction loader's own file names, the skill
 * provider's own roots and directory names, and the composition files the
 * profile launcher reads — never a restatement of them. Every path, target and
 * root alike, resolves to the nearest existing ancestor's real path plus the
 * missing tail, the resolution `@deepseek-ai/dsh-fs-local` uses for its target
 * key. A target lies at or below a root when one of the target's existing
 * ancestors is the root's existing part by device and inode and the remaining
 * names begin with the root's missing tail, so links, letter case, Unicode
 * normalization, short names and hard links resolve to one identity. Only a
 * missing tail and the name rules compare text, folding letter case when the
 * directory holding the name sits on a case-insensitive volume, which a probe
 * of that directory decides; the platform decides nothing.
 *
 * The classification reads the filesystem when the review runs. A link
 * created or swapped between the review and the write is outside what one
 * review can see.
 *
 * @module @delorun/plugin-instruction-consent/classify
 */
import { type BigIntStats, lstatSync, opendirSync, realpathSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, sep } from 'node:path'
import { DEFAULT_INSTRUCTION_FILE_NAMES } from '@deepseek-ai/dsh-agent-instructions'
import { resolveAgentsHome, resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { HOME_SKILL_DIR, PROJECT_SKILL_DIRS } from '@deepseek-ai/dsh-skill-filesystem'
import type { WriteConsentDiff } from '@deepseek-ai/dsh-tool-fs'

/**
 * The file names the workspace instruction loader reads as instructions by default: `AGENTS.md`, `CLAUDE.md` and
 * their local overlays. The loader's own exported list is the source, so a default the loader adds is a name this
 * classifier covers without another edit.
 */
export const INSTRUCTION_FILE_NAMES: readonly string[] = DEFAULT_INSTRUCTION_FILE_NAMES

/**
 * The project-scope skill directories the skill provider reads, below a project root. The provider's own exported
 * list is the source, so the classifier and the loader cannot disagree about where a project skill lives.
 */
export const PROJECT_SKILLS_DIRS: readonly string[] = PROJECT_SKILL_DIRS

/** The most directories one {@link createCaseProbe} remembers before it forgets them all and probes again. */
const CASE_PROBE_CACHE_LIMIT = 256

/**
 * The composition layer a patch file belongs to, in the order the profile launcher applies them: a selected bundle's
 * declared patch file, the profile's own `cordis.patch.yml`, or the home's `cordis.patch.yml`.
 */
export type CompositionLayer = 'bundle' | 'profile' | 'home'

/** One composition file the profile launcher reads: the presets, plugins and their instruction text it declares. */
export interface CompositionFile {
  /** The absolute path the launcher reads. */
  readonly path: string
  /** The layer the file supplies. */
  readonly layer: CompositionLayer
}

/** One classified instruction-layer target. */
export type InstructionLayerTarget =
  | { readonly kind: 'skill'; readonly root: 'home' | 'shared' | 'project' | 'custom' }
  | { readonly kind: 'preset'; readonly layer: CompositionLayer }
  | { readonly kind: 'instructions'; readonly scope: 'global' | 'folder' }

/**
 * Whether the volume holding one existing directory compares names case-insensitively.
 * @param directory - an existing directory, as a real path.
 * @returns true when two spellings that differ only in letter case name the same entry there.
 */
export type CaseProbe = (directory: string) => boolean

/** The harness home and the shared agent root of one resolution. */
export interface Homes {
  /** The harness home (`DSH_HOME`). */
  readonly dshHome: string
  /** The shared agent root (`DSH_AGENTS_HOME`). */
  readonly agentsHome: string
}

/** The environment the homes resolve from, the roots the mounted loaders name, and the case-sensitivity probe. */
export interface ClassifyOptions {
  /** The environment read for `DSH_HOME` and `DSH_AGENTS_HOME`; defaults to `process.env`. */
  readonly env?: Readonly<Record<string, string | undefined>>
  /**
   * Homes the loaders resolved earlier — the instruction loader resolves its homes once, when it mounts — which count
   * beside the homes `env` resolves to now.
   */
  readonly homes?: readonly Homes[]
  /**
   * The skill roots the mounted providers resolve without a workspace (`ctx.skills.configuredRoots()`), so a
   * deployment's own skill directory — a `customSkillDirs` entry, say — classifies as a skill. Omitted, the default
   * stores and the project directories alone count.
   */
  readonly skillRoots?: readonly string[]
  /** The composition files the profile launcher reads; omitted, no file classifies as a preset. */
  readonly compositionFiles?: readonly CompositionFile[]
  /**
   * The case-sensitivity probe; defaults to {@link probeCaseInsensitive}, uncached. A long-lived caller passes one
   * {@link createCaseProbe} so each directory is probed once.
   */
  readonly caseInsensitive?: CaseProbe
}

/** One existing path component by real path and identity. */
interface Node {
  readonly path: string
  readonly dev: bigint
  readonly ino: bigint
}

/** One resolved path: its existing part, the names below it that do not exist, and whether those names fold case. */
interface Location {
  /** The existing real ancestors, the nearest first and the filesystem root last. */
  readonly chain: readonly [Node, ...Node[]]
  /** The missing names below `chain[0]`, outermost first. */
  readonly tail: readonly string[]
  /** Whether the directory that holds the first name below the existing part folds letter case. */
  readonly fold: boolean
}

/** One textual spelling of the target, for the name rules. */
interface Spelling {
  readonly path: string
  readonly fold: boolean
}

/** The resolved forms of one target. */
interface Target {
  /** The locations a write reaches: through a final link, and at the link itself when the last name is one. */
  readonly locations: readonly Location[]
  /** The spellings the name rules read: each location's path and the path as given. */
  readonly spellings: readonly Spelling[]
}

/**
 * Classify one write target as an instruction-layer file.
 * @param path - the target path, absolute as the consent seam resolves it; a path that is not absolute (a remote
 *   backend's display path) meets only the name rules, as spelled, without case folding.
 * @param options - the environment and earlier homes, the roots the mounted loaders name, and the case probe.
 * @returns the target's kind and scope, or undefined when the target is no
 *   instruction-layer file and its write needs no consent.
 * @throws the filesystem error when a path or root cannot be resolved for a reason other than absence (a link loop,
 *   a denied search permission); the consent seam then refuses the write, which the local backend cannot commit
 *   either.
 */
export function classifyTarget(path: string, options: ClassifyOptions = {}): InstructionLayerTarget | undefined {
  if (path === '') return undefined
  const env = options.env ?? process.env
  const probe = options.caseInsensitive ?? probeCaseInsensitive
  const locate = (candidate: string): Location => locatePath(candidate, probe)
  const target = resolveTarget(path, probe)
  const homes = [{ dshHome: resolveDshHome(undefined, env), agentsHome: resolveAgentsHome(undefined, env) }, ...options.homes ?? []]
  const skill = classifySkill(target, homes, options.skillRoots ?? [], locate)
  if (skill !== undefined) return skill
  const composition = (options.compositionFiles ?? []).find(file => matches(locate(file.path), target, 'same'))
  if (composition !== undefined) return { kind: 'preset', layer: composition.layer }
  return classifyInstructions(target, homes, locate)
}

/**
 * Classify a skill target: a file below the skill store of the harness home or of the shared agent root (the
 * provider's `HOME_SKILL_DIR` in each), below a project's `.dsh/skills` or `.agents/skills` directory, or below a
 * configured skill root — the roots the skill provider reads.
 * @param target - the resolved target.
 * @param homes - each resolution of the harness home and the shared agent root.
 * @param configuredRoots - the roots the mounted providers resolved from their configuration.
 * @param locate - resolves one root.
 * @returns the skill target with the root it sits in, or undefined.
 */
function classifySkill(
  target: Target,
  homes: readonly Homes[],
  configuredRoots: readonly string[],
  locate: (path: string) => Location,
): InstructionLayerTarget | undefined {
  if (homes.some(home => matches(locate(join(home.dshHome, HOME_SKILL_DIR)), target, 'inside'))) return { kind: 'skill', root: 'home' }
  if (homes.some(home => matches(locate(join(home.agentsHome, HOME_SKILL_DIR)), target, 'inside'))) return { kind: 'skill', root: 'shared' }
  const project = target.spellings.some(spelling => PROJECT_SKILLS_DIRS.some(directory => hasSegments(spelling, directory.split('/'))))
  if (project) return { kind: 'skill', root: 'project' }
  if (configuredRoots.some(root => matches(locate(root), target, 'inside'))) return { kind: 'skill', root: 'custom' }
  return undefined
}

/**
 * Classify an instruction file target. A file with a name the workspace instruction loader reads by default directly in
 * a home, or the file such a path resolves to wherever it lives, is the user-global instruction file whose text loads
 * in every future chat (the loader reads the home's `AGENTS.md`). Any other file with one of those names is a folder's
 * standing instructions, which load in every future chat that works in that folder.
 * @param target - the resolved target.
 * @param homes - each resolution of the harness home and the shared agent root.
 * @param locate - resolves one home file.
 * @returns the instructions target with its scope, or undefined.
 */
function classifyInstructions(
  target: Target,
  homes: readonly Homes[],
  locate: (path: string) => Location,
): InstructionLayerTarget | undefined {
  const homeFiles = homes.flatMap(home => [home.dshHome, home.agentsHome]).flatMap(home => INSTRUCTION_FILE_NAMES.map(name => join(home, name)))
  if (homeFiles.some(file => matches(locate(file), target, 'same'))) return { kind: 'instructions', scope: 'global' }
  const named = target.spellings.some(spelling => INSTRUCTION_FILE_NAMES.some(name => equal(name, basename(spelling.path), spelling.fold)))
  return named ? { kind: 'instructions', scope: 'folder' } : undefined
}

/**
 * Build the review note for one classified target: the sentence that names the
 * instruction-layer effect of that scope, and the tool's diff verbatim, so the
 * person sees exactly what would be written before they allow it.
 * @param target - the classification of the target.
 * @param diff - the tool's diff representation, omitted when the tool carries none.
 * @returns the note the approval ask shows.
 */
export function reviewNote(target: InstructionLayerTarget, diff?: WriteConsentDiff): string {
  return `${effectText(target)} Nothing is written until you allow it. The diff, verbatim:\n${diffText(diff)}`
}

/**
 * The effect sentence of one target: what loads, and in which future chats.
 * @param target - the classification of the target.
 * @returns the sentence, ending with a full stop.
 */
function effectText(target: InstructionLayerTarget): string {
  switch (target.kind) {
    case 'skill':
      // A custom root is a directory a deployment configured for its skill provider, so its files load like any other
      // skill's: in every future chat, not in one project's.
      return target.root === 'project'
        ? 'A model-authored write to a skill of this project: its instructions load in every future chat in this project.'
        : 'A model-authored write to a skill: its instructions load in every future chat.'
    case 'preset':
      return presetEffectText(target.layer)
    case 'instructions':
      return target.scope === 'global'
        ? 'A model-authored write to the home AGENTS.md: these instructions load in every future chat.'
        : 'A model-authored write to AGENTS.md: these instructions load in every future chat that works in this folder.'
  }
}

/**
 * The effect sentence of a composition file, by the layer it supplies.
 * @param layer - the composition layer.
 * @returns the sentence, ending with a full stop.
 */
function presetEffectText(layer: CompositionLayer): string {
  switch (layer) {
    case 'bundle':
      return 'A model-authored write to a bundle\'s preset declarations: the presets and instructions it declares load in every future chat of every profile that selects the bundle.'
    case 'profile':
      return 'A model-authored write to this profile\'s own patch layer: the presets and instructions it declares load in every future chat of this profile.'
    case 'home':
      return 'A model-authored write to the home patch layer: the presets and instructions it declares load in every future chat of every profile.'
  }
}

/**
 * Render the tool's diff representation verbatim: an `apply_patch` patch as
 * the text it carries, an `edit` as its literal old and new texts, a `write`
 * as the full new content beside the note that the tool does not carry the
 * previous text.
 * @param diff - the tool's diff representation, omitted when the tool carries none.
 * @returns the diff text the note shows.
 */
export function diffText(diff: WriteConsentDiff | undefined): string {
  if (diff === undefined) return '(the tool carries no diff)'
  if (typeof diff === 'string') return diff
  const old = diff.old === null ? '(the write tool does not carry the previous text)' : diff.old
  return `--- old ---\n${old}\n--- new ---\n${diff.new}`
}

/**
 * Resolve one target: where a write reaches through a final link, where the link itself sits when the last name is
 * one, and the spellings the name rules read.
 * @param path - the target path.
 * @param probe - the case-sensitivity probe.
 * @returns the resolved target; a path that is not absolute has no locations and its one spelling compares exactly.
 */
function resolveTarget(path: string, probe: CaseProbe): Target {
  if (!isAbsolute(path)) return { locations: [], spellings: [{ path, fold: false }] }
  const reached = locatePath(path, probe)
  const locations = [reached]
  // A missing tail means the last name does not resolve; a write there replaces the name itself, which `reached` is.
  if (reached.tail.length === 0 && lstatSync(path).isSymbolicLink()) {
    const parent = locatePath(dirname(path), probe)
    locations.push({ ...parent, tail: [...parent.tail, basename(path)] })
  }
  const spellings = locations.map(location => ({ path: locationPath(location), fold: location.fold }))
  return { locations, spellings: [...spellings, { path, fold: reached.fold }] }
}

/**
 * Resolve one absolute path to its existing real ancestors and its missing tail.
 * @param path - an absolute path.
 * @param probe - the case-sensitivity probe, asked about the directory that holds the first missing name.
 * @returns the location.
 * @throws the filesystem error when a component fails to resolve for a reason other than absence.
 */
function locatePath(path: string, probe: CaseProbe): Location {
  const tail: string[] = []
  let current = path
  let real = existingRealPath(current)
  while (real === undefined) {
    /* v8 ignore next -- a POSIX filesystem root always resolves; only an absent Windows drive root does not. */
    if (dirname(current) === current) throw new Error(`no ancestor of "${path}" exists`)
    tail.unshift(basename(current))
    current = dirname(current)
    real = existingRealPath(current)
  }
  const first = lstatSync(real, { bigint: true })
  const chain: [Node, ...Node[]] = [{ path: real, dev: first.dev, ino: first.ino }]
  for (let node = real; dirname(node) !== node;) {
    node = dirname(node)
    const info = lstatSync(node, { bigint: true })
    chain.push({ path: node, dev: info.dev, ino: info.ino })
  }
  return { chain, tail, fold: probe(first.isDirectory() ? real : dirname(real)) }
}

/**
 * The path one location names.
 * @param location - the location.
 * @returns the existing real path joined with the missing tail.
 */
function locationPath(location: Location): string {
  return location.tail.length === 0 ? location.chain[0].path : join(location.chain[0].path, ...location.tail)
}

/**
 * The real path of one path, or undefined when the path or one of its directories does not exist.
 * @param path - an absolute path.
 * @returns the real path, or undefined on `ENOENT` and `ENOTDIR`.
 * @throws the filesystem error for any other failure.
 */
function existingRealPath(path: string): string | undefined {
  try {
    return realpathSync.native(path)
  } catch (error) {
    if (error instanceof Error && 'code' in error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) return undefined
    throw error
  }
}

/**
 * Whether one target is the same location as a root, or lies inside it. One of the target's existing ancestors must be
 * the root's existing part by device and inode; the names from there to the target must then begin with the root's
 * missing tail, compared as text that folds case when either side's directory folds.
 * @param root - the resolved root.
 * @param target - the resolved target.
 * @param relation - `'same'` for the root itself, `'inside'` for a path below it.
 * @returns whether one of the target's locations stands in that relation.
 */
function matches(root: Location, target: Target, relation: 'same' | 'inside'): boolean {
  const anchor = root.chain[0]
  return target.locations.some((location) => {
    const index = location.chain.findIndex(node => node.dev === anchor.dev && node.ino === anchor.ino)
    if (index < 0) return false
    const names = [...location.chain.slice(0, index).map(node => basename(node.path)).reverse(), ...location.tail]
    const fold = root.fold || location.fold
    if (!root.tail.every((name, offset) => equal(name, names[offset] ?? '', fold))) return false
    return relation === 'same' ? names.length === root.tail.length : names.length > root.tail.length
  })
}

/**
 * Probe whether the volume holding one existing directory compares names case-insensitively: the first entry of the
 * directory whose name holds an ASCII letter answers by whether its case-flipped spelling names the same inode. A
 * directory without such an entry answers case-insensitive, the answer that asks more often.
 * @param directory - an existing directory, as a real path.
 * @returns true when the case-flipped spelling names the same entry, or when no entry can tell.
 */
export function probeCaseInsensitive(directory: string): boolean {
  const entry = firstLetteredEntry(directory)
  return entry === undefined || flippedIsSame(directory, entry)
}

/**
 * A case-sensitivity probe that remembers each directory's answer, so a long-lived review probes a directory once.
 * It forgets every answer after {@link CASE_PROBE_CACHE_LIMIT} directories and probes again.
 * @returns the remembering probe.
 */
export function createCaseProbe(): CaseProbe {
  const answers = new Map<string, boolean>()
  return (directory) => {
    const known = answers.get(directory)
    if (known !== undefined) return known
    if (answers.size >= CASE_PROBE_CACHE_LIMIT) answers.clear()
    const answer = probeCaseInsensitive(directory)
    answers.set(directory, answer)
    return answer
  }
}

/**
 * The first entry of a directory whose name holds an ASCII letter.
 * @param directory - an existing directory.
 * @returns the entry name, or undefined when no entry has one.
 */
function firstLetteredEntry(directory: string): string | undefined {
  const handle = opendirSync(directory)
  try {
    for (let entry = handle.readSync(); entry !== null; entry = handle.readSync()) {
      if (hasLetter(entry.name)) return entry.name
    }
    return undefined
  } finally {
    handle.closeSync()
  }
}

/**
 * Whether the case-flipped spelling of one entry names the same inode as the entry.
 * @param directory - the directory holding the entry.
 * @param name - the entry name, holding at least one ASCII letter.
 * @returns true when both spellings name one inode on one device.
 */
function flippedIsSame(directory: string, name: string): boolean {
  const original: BigIntStats = lstatSync(join(directory, name), { bigint: true })
  const flipped = lstatSync(join(directory, flipCase(name)), { bigint: true, throwIfNoEntry: false })
  return flipped !== undefined && flipped.dev === original.dev && flipped.ino === original.ino
}

/**
 * Whether a name holds an ASCII letter, the letters whose case every case-insensitive volume folds.
 * @param name - the name.
 * @returns whether flipping its case changes it.
 */
function hasLetter(name: string): boolean {
  return /[A-Za-z]/u.test(name)
}

/**
 * Flip the case of every ASCII letter of a name.
 * @param name - the name.
 * @returns the name with each ASCII letter in the other case.
 */
function flipCase(name: string): string {
  return name.replace(/[A-Za-z]/gu, letter => letter === letter.toUpperCase() ? letter.toLowerCase() : letter.toUpperCase())
}

/**
 * Whether two names or paths are equal.
 * @param left - one name.
 * @param right - the other name.
 * @param fold - whether the comparison folds letter case.
 * @returns whether they are equal, lower-cased first when folding.
 */
function equal(left: string, right: string, fold: boolean): boolean {
  return fold ? left.toLowerCase() === right.toLowerCase() : left === right
}

/**
 * Whether one spelling holds a run of directory names in order, so
 * `/w/.dsh/skills/x/SKILL.md` holds `['.dsh', 'skills']`.
 * @param spelling - the spelling.
 * @param names - the directory names in order.
 * @returns whether the names appear as consecutive directory segments.
 */
function hasSegments(spelling: Spelling, names: readonly string[]): boolean {
  const parts = spelling.path.split(sep)
  return parts.some((_, index) => names.every((name, offset) => equal(parts[index + offset] ?? '', name, spelling.fold)))
}
