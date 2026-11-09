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
 * The classifier is lexical: it compares the resolved target path against the
 * directories the harness reads instruction files from — the loader's own list
 * of candidate names and the skill provider's own list of roots, never a
 * restatement of either — and never touches the filesystem, so one review
 * answers at once and cannot race a write.
 *
 * @module @delo/plugin-instruction-consent/classify
 */
import { basename, dirname, join, sep } from 'node:path'
import { READ_EXEMPTIONS } from '@delo/contract-home-layout'
import { DEFAULT_INSTRUCTION_FILE_NAMES } from '@deepseek-ai/dsh-agent-instructions'
import { resolveAgentsHome, resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { PROJECT_SKILL_DIRS } from '@deepseek-ai/dsh-skill-filesystem'
import type { WriteConsentDiff } from '@deepseek-ai/dsh-tool-fs/src/consent.ts'

/**
 * The file names the workspace instruction loader reads as instructions by default: `AGENTS.md`, `CLAUDE.md` and
 * their local overlays. The loader's own exported list is the source, so a default the loader adds is a name this
 * classifier covers without another edit.
 */
export const INSTRUCTION_FILE_NAMES: readonly string[] = DEFAULT_INSTRUCTION_FILE_NAMES

/** The directory of the shipped preset declarations, which the runtime closure verifies at `packages/bundle/web-app/presets`. */
export const PRESETS_DIR = 'presets'

/**
 * The project-scope skill directories the skill provider reads, below a project root. The provider's own exported
 * list is the source, so the classifier and the loader cannot disagree about where a project skill lives.
 */
export const PROJECT_SKILLS_DIRS: readonly string[] = PROJECT_SKILL_DIRS

/**
 * The home-relative directory of the home's own skill store. Contract C1
 * (`@delo/contract-home-layout`) names `skills` a read exemption of the home —
 * the one home directory whose files load as instructions in future chats —
 * and the name is read from that constant, so a contract change that renames
 * the store fails loud here instead of silently classifying nothing.
 */
function homeSkillsDir(): string {
  const entry = READ_EXEMPTIONS.find(name => name === 'skills')
  if (entry === undefined) throw new Error('contract C1 no longer names the home skills directory a read exemption')
  return entry
}

/** One classified instruction-layer target. */
export type InstructionLayerTarget =
  | { readonly kind: 'skill'; readonly root: 'home' | 'shared' | 'project' | 'custom' }
  | { readonly kind: 'preset' }
  | { readonly kind: 'instructions'; readonly scope: 'global' | 'folder' }

/** The environment the homes resolve from; defaults to this process's environment. */
export interface ClassifyOptions {
  /** The environment read for `DSH_HOME` and `DSH_AGENTS_HOME`; defaults to `process.env`. */
  readonly env?: Readonly<Record<string, string | undefined>>
  /**
   * The skill roots the mounted providers resolve without a workspace (`ctx.skills.configuredRoots()`), so a
   * deployment's own skill directory — a `customSkillDirs` entry, say — classifies as a skill. Omitted, the default
   * stores and the project directories alone count.
   */
  readonly skillRoots?: readonly string[]
}

/**
 * Classify one write target as an instruction-layer file.
 * @param path - the target path, absolute as the consent seam resolves it.
 * @param options - the environment the homes resolve from, and the skill roots the mounted providers name.
 * @returns the target's kind and scope, or undefined when the target is no
 *   instruction-layer file and its write needs no consent.
 */
export function classifyTarget(path: string, options: ClassifyOptions = {}): InstructionLayerTarget | undefined {
  if (path === '') return undefined
  const env = options.env ?? process.env
  const skill = classifySkill(path, env, options.skillRoots ?? [])
  if (skill !== undefined) return skill
  if (isPreset(path)) return { kind: 'preset' }
  return classifyInstructions(path, env)
}

/**
 * Classify a skill target: a file below the home's own skill store (the
 * `skills` entry contract C1 names a read exemption), below the shared agent
 * root's skill store, below a configured skill root, or below a project's
 * `.dsh/skills` or `.agents/skills` directory — the roots the skill provider reads.
 * @param path - the target path.
 * @param env - the environment the homes resolve from.
 * @param configuredRoots - the roots the mounted providers resolved from their configuration.
 * @returns the skill target with the root it sits in, or undefined.
 */
function classifySkill(
  path: string,
  env: Readonly<Record<string, string | undefined>>,
  configuredRoots: readonly string[],
): InstructionLayerTarget | undefined {
  const dshHome = resolveDshHome(undefined, env)
  if (under(join(dshHome, homeSkillsDir()), path)) return { kind: 'skill', root: 'home' }
  const agentsHome = resolveAgentsHome(undefined, env)
  if (under(join(agentsHome, homeSkillsDir()), path)) return { kind: 'skill', root: 'shared' }
  if (PROJECT_SKILLS_DIRS.some(directory => hasSegments(path, directory.split('/')))) return { kind: 'skill', root: 'project' }
  if (configuredRoots.some(root => under(root, path))) return { kind: 'skill', root: 'custom' }
  return undefined
}

/**
 * Classify a preset target: a YAML file whose immediate parent directory is
 * the preset directory, the layout the shipped preset declarations keep
 * (`packages/bundle/web-app/presets/*.patch.yml`), where one file declares one
 * preset's composition.
 * @param path - the target path.
 * @returns whether the target is a preset declaration file.
 */
function isPreset(path: string): boolean {
  if (!/\.(?:ya?ml)$/u.test(basename(path))) return false
  return basename(dirname(path)) === PRESETS_DIR
}

/**
 * Classify an instruction file target: any file name the workspace instruction loader reads by default. One directly
 * inside a resolved home — the harness home or the shared agent root — is the user-global instruction file whose text
 * loads in every future chat; any other one is a folder's standing instructions, which load in every future chat that
 * works in that folder.
 * @param path - the target path.
 * @param env - the environment the homes resolve from.
 * @returns the instructions target with its scope, or undefined.
 */
function classifyInstructions(path: string, env: Readonly<Record<string, string | undefined>>): InstructionLayerTarget | undefined {
  if (!INSTRUCTION_FILE_NAMES.includes(basename(path))) return undefined
  const global = dirname(path) === resolveDshHome(undefined, env) || dirname(path) === resolveAgentsHome(undefined, env)
  return { kind: 'instructions', scope: global ? 'global' : 'folder' }
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
      return 'A model-authored write to a preset: its instructions load in every future chat this preset composes.'
    case 'instructions':
      return target.scope === 'global'
        ? 'A model-authored write to the home AGENTS.md: these instructions load in every future chat.'
        : 'A model-authored write to AGENTS.md: these instructions load in every future chat that works in this folder.'
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
 * Whether one path lies at or below a directory.
 * @param directory - the directory, absolute and without a trailing separator.
 * @param path - the candidate path.
 * @returns whether `path` is `directory` or a path inside it.
 */
function under(directory: string, path: string): boolean {
  const base = directory.endsWith(sep) ? directory : `${directory}${sep}`
  return path.startsWith(base)
}

/**
 * Whether one path holds a run of directory names in order, so
 * `hasSegments('/w/.dsh/skills/x/SKILL.md', ['.dsh', 'skills'])` holds.
 * @param path - the path.
 * @param names - the directory names in order.
 * @returns whether the names appear as consecutive directory segments.
 */
function hasSegments(path: string, names: readonly string[]): boolean {
  const parts = path.split(sep)
  return parts.some((_, index) => names.every((name, offset) => parts[index + offset] === name))
}
