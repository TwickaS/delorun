/**
 * The `delorun-real-browser` skill: how the agent works in the person's own Chrome through browse's `execute` tool. It
 * says plainly that the browser is the person's, signed in as them, and teaches reading the page before acting, one
 * short script per step, extracting results at the end and handing sign-ins, codes and payments back to the person
 * with browse's `handoff`. The skill is text; it grants nothing. The plugin waits for the browse driver's service, so
 * the skill is listed only while the driver row is on, and it goes away when the driver does.
 *
 * The browsing practice is adapted from ego (lite)'s MIT-licensed `ego-browser` skill; the notice is in `NOTICE.md`.
 *
 * @module @delorun/skill-real-browser
 */
import { readFileSync } from 'node:fs'
import { isAbsolute, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import { BUNDLED_SKILL_RANK, type SkillCandidate, type SkillProvider } from '@deepseek-ai/dsh-skill'

/** The plugin's name in the loader's diagnostics. */
export const name = 'skill-real-browser'

/** The skill's name, as the agent loads it. */
export const SKILL_NAME = 'delorun-real-browser'

/** The service the browse driver (`@delorun/browser-use-browse`) provides while its row is on. */
export const DRIVER_SERVICE = 'realBrowser'

/** The skill registry the provider registers with, and the driver whose presence lists the skill. */
export const inject = ['skills', DRIVER_SERVICE]

/** The provider's name on the skill candidates. */
export const PROVIDER = 'delorun-real-browser'

/**
 * Split a skill file into its description and its body.
 * @param raw - the file's text.
 * @param path - the file, for the error.
 * @returns the description and the body.
 * @throws {Error} when the file has no frontmatter or no description line.
 */
export function parseSkill(raw: string, path: string): { readonly description: string, readonly content: string } {
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(raw)
  if (frontmatter?.[1] === undefined) throw new Error(`skill-real-browser: ${path} has no frontmatter`)
  const description = /^description:\s*(.+)$/mu.exec(frontmatter[1])?.[1]?.trim()
  if (description === undefined || description === '') throw new Error(`skill-real-browser: ${path} has no description`)
  return { description, content: raw.slice(frontmatter[0].length).trim() }
}

/**
 * Register the skill; cordis runs this only once the driver's service is present and disposes it when the service goes.
 * @param ctx - the context carrying the skill registry and the driver's service.
 */
export function apply(ctx: Context): void {
  const directory = fileURLToPath(new URL(`../assets/${SKILL_NAME}/`, import.meta.url))
  if (!isAbsolute(directory)) throw new Error('skill-real-browser: the assets directory is not absolute')
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
