/**
 * The `delorun-report-problem` skill: the triage playbook behind "Help me report this". It teaches the agent to ask what
 * went wrong, read the version and recent logs through the CLI, draft a GitHub issue in the bug form's sections and hand
 * it to the person without posting it. The skill is text; it grants nothing, and the agent's commands follow the chat's
 * normal approvals.
 *
 * @module @delorun/skill-report-problem
 */
import { readFileSync } from 'node:fs'
import { isAbsolute, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import { BUNDLED_SKILL_RANK, type SkillCandidate, type SkillProvider } from '@deepseek-ai/dsh-skill'

/** The plugin's name in the loader's diagnostics. */
export const name = 'skill-report-problem'

/** The skill's name, as the agent loads it. */
export const SKILL_NAME = 'delorun-report-problem'

/** The skill registry the provider registers with. */
export const inject = ['skills']

/** The provider's name on the skill candidates. */
export const PROVIDER = 'delorun-report-problem'

/**
 * Split a skill file into its description and its body.
 * @param raw - the file's text.
 * @param path - the file, for the error.
 * @returns the description and the body.
 * @throws {Error} when the file has no frontmatter or no description line.
 */
export function parseSkill(raw: string, path: string): { readonly description: string, readonly content: string } {
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(raw)
  if (frontmatter?.[1] === undefined) throw new Error(`skill-report-problem: ${path} has no frontmatter`)
  const description = /^description:\s*(.+)$/mu.exec(frontmatter[1])?.[1]?.trim()
  if (description === undefined || description === '') throw new Error(`skill-report-problem: ${path} has no description`)
  return { description, content: raw.slice(frontmatter[0].length).trim() }
}

/**
 * Register the skill.
 * @param ctx - the context carrying the skill registry.
 */
export function apply(ctx: Context): void {
  const directory = fileURLToPath(new URL(`../assets/${SKILL_NAME}/`, import.meta.url))
  if (!isAbsolute(directory)) throw new Error('skill-report-problem: the assets directory is not absolute')
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
