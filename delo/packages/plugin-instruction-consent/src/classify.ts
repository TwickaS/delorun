/**
 * The instruction-layer classifier of `@delo/plugin-instruction-consent`, free
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
 * profile launcher reads — never a restatement of them. It compares both the
 * spelling the tool received and the physical path the local filesystem
 * backend writes: the real path of the nearest existing ancestor plus the
 * missing tail, the resolution `@deepseek-ai/dsh-fs-local` uses for its target
 * key. Every root is resolved the same way, so a link on either side cannot
 * move a write out of the comparison. A comparison folds letter case when the
 * directory holding the target or the root sits on a case-insensitive volume,
 * which a probe of that directory decides; the platform decides nothing.
 *
 * The classification reads the filesystem when the review runs. A link
 * created or swapped between the review and the write is outside what one
 * review can see.
 *
 * @module @delo/plugin-instruction-consent/classify
 */
import { type BigIntStats, lstatSync, opendirSync, realpathSync, statSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, sep } from 'node:path'
import { DEFAULT_INSTRUCTION_FILE_NAMES } from '@deepseek-ai/dsh-agent-instructions'
import { resolveAgentsHome, resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { HOME_SKILL_DIR, PROJECT_SKILL_DIRS } from '@deepseek-ai/dsh-skill-filesystem'
import type { WriteConsentDiff } from '@deepseek-ai/dsh-tool-fs/src/consent.ts'

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

/** The environment the homes resolve from, the roots the mounted loaders name, and the case-sensitivity probe. */
export interface ClassifyOptions {
  /** The environment read for `DSH_HOME` and `DSH_AGENTS_HOME`; defaults to `process.env`. */
  readonly env?: Readonly<Record<string, string | undefined>>
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

/** One spelling of a path, and whether a comparison against it folds letter case. */
interface Spelling {
  readonly path: string
  readonly fold: boolean
}

/**
 * Classify one write target as an instruction-layer file.
 * @param path - the target path, absolute as the consent seam resolves it; a path that is not absolute (a remote
 *   backend's display path) is compared as spelled, without resolution or case folding.
 * @param options - the environment the homes resolve from, the roots the mounted loaders name, and the case probe.
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
  const spell = (candidate: string): Spelling[] => spellings(candidate, probe)
  const target = spell(path)
  const homes: readonly [string, string] = [resolveDshHome(undefined, env), resolveAgentsHome(undefined, env)]
  const skill = classifySkill(target, homes, options.skillRoots ?? [], spell)
  if (skill !== undefined) return skill
  const composition = (options.compositionFiles ?? []).find(file => same(spell(file.path), target))
  if (composition !== undefined) return { kind: 'preset', layer: composition.layer }
  return classifyInstructions(target, homes, spell)
}

/**
 * Classify a skill target: a file below the skill store of the harness home or
 * of the shared agent root (the provider's `HOME_SKILL_DIR` in each), below a project's `.dsh/skills` or `.agents/skills`
 * directory, or below a configured skill root — the roots the skill provider reads.
 * @param target - the target's spellings.
 * @param homes - the harness home and the shared agent root, as configured.
 * @param configuredRoots - the roots the mounted providers resolved from their configuration.
 * @param spell - resolves one root into its spellings.
 * @returns the skill target with the root it sits in, or undefined.
 */
function classifySkill(
  target: readonly Spelling[],
  homes: readonly [string, string],
  configuredRoots: readonly string[],
  spell: (path: string) => Spelling[],
): InstructionLayerTarget | undefined {
  const [dshHome, agentsHome] = homes
  if (within(spell(join(dshHome, HOME_SKILL_DIR)), target)) return { kind: 'skill', root: 'home' }
  if (within(spell(join(agentsHome, HOME_SKILL_DIR)), target)) return { kind: 'skill', root: 'shared' }
  const project = target.some(spelling => PROJECT_SKILLS_DIRS.some(directory => hasSegments(spelling, directory.split('/'))))
  if (project) return { kind: 'skill', root: 'project' }
  if (configuredRoots.some(root => within(spell(root), target))) return { kind: 'skill', root: 'custom' }
  return undefined
}

/**
 * Classify an instruction file target. A file with a name the workspace instruction loader reads by default directly in
 * a home, or the file such a path resolves to wherever it lives, is the user-global instruction file whose text loads
 * in every future chat (the loader reads the home's `AGENTS.md`). Any other file with one of those names is a folder's
 * standing instructions, which load in every future chat that works in that folder.
 * @param target - the target's spellings.
 * @param homes - the harness home and the shared agent root, as configured.
 * @param spell - resolves one home file into its spellings.
 * @returns the instructions target with its scope, or undefined.
 */
function classifyInstructions(
  target: readonly Spelling[],
  homes: readonly string[],
  spell: (path: string) => Spelling[],
): InstructionLayerTarget | undefined {
  const homeFiles = homes.flatMap(home => INSTRUCTION_FILE_NAMES.map(name => join(home, name)))
  if (homeFiles.some(file => same(spell(file), target))) return { kind: 'instructions', scope: 'global' }
  const named = target.some(spelling => INSTRUCTION_FILE_NAMES.some(name => equal(name, basename(spelling.path), spelling.fold)))
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
function diffText(diff: WriteConsentDiff | undefined): string {
  if (diff === undefined) return '(the tool carries no diff)'
  if (typeof diff === 'string') return diff
  const old = diff.old === null ? '(the write tool does not carry the previous text)' : diff.old
  return `--- old ---\n${old}\n--- new ---\n${diff.new}`
}

/**
 * The spellings one path is compared under: its physical path first, then the spelling as given when that differs.
 * Both fold letter case when the directory holding the physical path is case-insensitive.
 * @param path - the path.
 * @param probe - the case-sensitivity probe.
 * @returns the spellings; a path that is not absolute keeps its one spelling and compares exactly.
 */
function spellings(path: string, probe: CaseProbe): Spelling[] {
  if (!isAbsolute(path)) return [{ path, fold: false }]
  const physical = resolvePhysical(path)
  const fold = probe(physical.directory)
  return physical.path === path ? [{ path, fold }] : [{ path: physical.path, fold }, { path, fold }]
}

/**
 * Resolve the physical path a write to `path` reaches: the real path of the whole path when it exists, otherwise the
 * real path of the nearest existing ancestor joined with the missing tail.
 * @param path - an absolute path.
 * @returns the physical path, and the existing directory whose volume holds it.
 * @throws the filesystem error when a component fails to resolve for a reason other than absence.
 */
function resolvePhysical(path: string): { path: string; directory: string } {
  const missing: string[] = []
  for (let current = path; ; current = dirname(current)) {
    const real = existingRealPath(current)
    if (real !== undefined) {
      const directory = statSync(real).isDirectory() ? real : dirname(real)
      return { path: missing.length === 0 ? real : join(real, ...missing), directory }
    }
    /* v8 ignore next -- a POSIX filesystem root always resolves; only an absent Windows drive root does not. */
    if (dirname(current) === current) throw new Error(`no ancestor of "${path}" exists`)
    missing.unshift(basename(current))
  }
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
 * Probe whether the volume holding one existing directory compares names case-insensitively. The probe takes the
 * first entry of the directory whose name holds an ASCII letter, or, in a directory without one, the nearest name on
 * the path that holds one, and asks whether its case-flipped spelling names the same inode. A volume where no name up
 * to its root holds a letter reports case-insensitive, the answer that asks more often.
 * @param directory - an existing directory, as a real path.
 * @returns true when the case-flipped spelling names the same entry.
 */
export function probeCaseInsensitive(directory: string): boolean {
  const device = lstatSync(directory, { bigint: true }).dev
  const entry = firstLetteredEntry(directory)
  if (entry !== undefined) return flippedIsSame(directory, entry)
  for (let current = directory; ; current = dirname(current)) {
    const parent = dirname(current)
    /* v8 ignore next -- needs a volume on which every name from the directory up to the volume root is letterless. */
    if (parent === current || lstatSync(parent, { bigint: true }).dev !== device) return true
    const name = basename(current)
    if (hasLetter(name)) return flippedIsSame(parent, name)
  }
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
 * The comparison key of one path.
 * @param path - the path.
 * @param fold - whether the comparison folds letter case.
 * @returns the path, lower-cased when folding.
 */
function comparable(path: string, fold: boolean): string {
  return fold ? path.toLowerCase() : path
}

/**
 * Whether two paths name the same location.
 * @param left - one path.
 * @param right - the other path.
 * @param fold - whether the comparison folds letter case.
 * @returns whether the comparison keys are equal.
 */
function equal(left: string, right: string, fold: boolean): boolean {
  return comparable(left, fold) === comparable(right, fold)
}

/**
 * Whether any spelling of the target names the same location as any spelling of a file.
 * @param file - the file's spellings.
 * @param target - the target's spellings.
 * @returns whether one pair is equal, folding when either side's volume folds.
 */
function same(file: readonly Spelling[], target: readonly Spelling[]): boolean {
  return file.some(left => target.some(right => equal(left.path, right.path, left.fold || right.fold)))
}

/**
 * Whether any spelling of the target lies below any spelling of a directory.
 * @param directory - the directory's spellings.
 * @param target - the target's spellings.
 * @returns whether one pair nests, folding when either side's volume folds.
 */
function within(directory: readonly Spelling[], target: readonly Spelling[]): boolean {
  return directory.some(root => target.some(spelling => under(root.path, spelling.path, root.fold || spelling.fold)))
}

/**
 * Whether one path lies below a directory.
 * @param directory - the directory, absolute.
 * @param path - the candidate path.
 * @param fold - whether the comparison folds letter case.
 * @returns whether `path` is a path inside `directory`.
 */
function under(directory: string, path: string, fold: boolean): boolean {
  const base = directory.endsWith(sep) ? directory : `${directory}${sep}`
  return comparable(path, fold).startsWith(comparable(base, fold))
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
  return parts.some((_, index) => names.every((name, offset) => {
    const part = parts[index + offset]
    return part !== undefined && equal(part, name, spelling.fold)
  }))
}
