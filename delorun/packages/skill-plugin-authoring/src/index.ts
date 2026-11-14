/**
 * The `delorun-plugin-authoring` skill: it teaches the agent to make or change a Delorun plugin in the chat's workspace with
 * `delorun plugin new`, to test it with `delorun plugin dev`, and to leave turning it on to the person at their
 * computer. The skill is text; it grants nothing, and the agent's file writes and commands follow the chat's normal
 * approvals.
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

/** The skill's name, as the agent loads it. */
export const SKILL_NAME = 'delorun-plugin-authoring'

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
 * Register the skill.
 * @param ctx - the context carrying the skill registry.
 */
export function apply(ctx: Context): void {
  const directory = fileURLToPath(new URL(`../assets/${SKILL_NAME}/`, import.meta.url))
  if (!isAbsolute(directory)) throw new Error('skill-plugin-authoring: the assets directory is not absolute')
  const path = `${directory}SKILL.md`
  const { description } = parseSkill(readFileSync(path, 'utf8'), path)
  const candidate: SkillCandidate = {
    name: SKILL_NAME, description,
    invocation: { modelInvocable: true, userInvocable: true },
    provider: PROVIDER, source: 'bundled', rank: BUNDLED_SKILL_RANK,
    resourceBase: { kind: 'directory', path: directory.split(sep).join('/') }, locator: path,
  }
  const provider: SkillProvider = {
    name: PROVIDER,
    list: () => Promise.resolve([candidate]),
    get(chosen) {
      const { rank: _rank, locator, ...summary } = chosen
      return Promise.resolve({ ...summary, content: parseSkill(readFileSync(locator as string, 'utf8'), locator as string).content })
    },
  }
  ctx.skills.registerProvider(() => provider)
}
