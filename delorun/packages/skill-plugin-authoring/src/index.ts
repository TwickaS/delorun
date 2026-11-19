/**
 * Two skills for changing what the person's Delorun runs. `delorun-plugin-authoring` teaches the agent to make or change a
 * Delorun plugin in the chat's workspace with `delorun plugin new`, to test it with `delorun plugin dev`, and to leave
 * turning it on to the person at their computer. `delorun-harness-copy` points the agent at the person's copy of
 * Delorun (`delorun changes edit-harness`), the only place Delorun's own files change, and leaves every decision to the
 * person; it says that it works only in a chat with full access, since a confined chat cannot write the Delorun home.
 * The skills are text; they grant nothing, and the agent's file writes and commands follow the chat's normal approvals.
 *
 * @module @delorun/skill-plugin-authoring
 */
import { readFileSync } from 'node:fs'
import { isAbsolute, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import { BUNDLED_SKILL_RANK, type SkillCandidate, type SkillProvider } from '@deepseek-ai/dsh-skill'

/** The plugin's name in the loader's diagnostics. */
export const name = 'skill-plugin-authoring'

/** The plugin skill's name, as the agent loads it. */
export const SKILL_NAME = 'delorun-plugin-authoring'

/** The harness-copy skill's name, as the agent loads it. */
export const HARNESS_SKILL_NAME = 'delorun-harness-copy'

/** Every skill the provider lists, in order; each is `assets/<name>/SKILL.md`. */
export const SKILL_NAMES = [SKILL_NAME, HARNESS_SKILL_NAME] as const

/** The skill registry the provider registers with. */
export const inject = ['skills']

/** The provider's name on the skill candidates. */
export const PROVIDER = 'delorun-plugin-authoring'

/**
 * Split a skill file into its description and its body.
 * @param raw - the file's text.
 * @param path - the file, for the error.
 * @returns the description and the body.
 * @throws {Error} when the file has no frontmatter or no description line.
 */
export function parseSkill(raw: string, path: string): { readonly description: string, readonly content: string } {
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(raw)
  if (frontmatter?.[1] === undefined) throw new Error(`skill-plugin-authoring: ${path} has no frontmatter`)
  const description = /^description:\s*(.+)$/mu.exec(frontmatter[1])?.[1]?.trim()
  if (description === undefined || description === '') throw new Error(`skill-plugin-authoring: ${path} has no description`)
  return { description, content: raw.slice(frontmatter[0].length).trim() }
}

/**
 * The candidate for one bundled skill.
 * @param skill - the skill's name, which names its assets directory.
 * @returns the candidate.
 * @throws {Error} when the assets directory is not absolute, or the skill file has no frontmatter or description.
 */
function candidateOf(skill: string): SkillCandidate {
  const directory = fileURLToPath(new URL(`../assets/${skill}/`, import.meta.url))
  if (!isAbsolute(directory)) throw new Error('skill-plugin-authoring: the assets directory is not absolute')
  const path = `${directory}SKILL.md`
  const { description } = parseSkill(readFileSync(path, 'utf8'), path)
  return {
    name: skill, description,
    invocation: { modelInvocable: true, userInvocable: true },
    provider: PROVIDER, source: 'bundled', rank: BUNDLED_SKILL_RANK,
    resourceBase: { kind: 'directory', path: directory.split(sep).join('/') }, locator: path,
  }
}

/**
 * Register the skills.
 * @param ctx - the context carrying the skill registry.
 */
export function apply(ctx: Context): void {
  const candidates = SKILL_NAMES.map(candidateOf)
  const provider: SkillProvider = {
    name: PROVIDER,
    list: () => Promise.resolve(candidates),
    get(chosen) {
      const { rank: _rank, locator, ...summary } = chosen
      return Promise.resolve({ ...summary, content: parseSkill(readFileSync(locator as string, 'utf8'), locator as string).content })
    },
  }
  ctx.skills.registerProvider(() => provider)
}
