/** The delo-plugin-authoring skill: registered with the skill registry, and its text states the rules it teaches. */
import { Context } from '@deepseek-ai/cordis'
import type { SkillCandidate, SkillProvider } from '@deepseek-ai/dsh-skill'
import { expect, it } from 'vitest'
import * as plugin from '../src/index.ts'

/**
 * Register the plugin against a stand-in skill registry.
 * @returns the provider it registered.
 */
async function registered(): Promise<SkillProvider> {
  const ctx = new Context()
  let provider: SkillProvider | undefined
  ctx.provide('skills', { registerProvider: (make: () => SkillProvider) => { provider = make(); return () => {} } } as never)
  await ctx.plugin(plugin).await()
  return provider!
}

/**
 * @param provider - the registered provider.
 * @returns its one candidate and that candidate's body.
 */
async function load(provider: SkillProvider): Promise<{ readonly candidate: SkillCandidate, readonly content: string }> {
  const [candidate] = await provider.list({} as never) as readonly SkillCandidate[]
  const skill = await provider.get(candidate!, {} as never)
  return { candidate: candidate!, content: skill!.content }
}

it('lists one model-invocable bundled skill and returns its body without the frontmatter', async () => {
  const { candidate, content } = await load(await registered())
  expect(candidate).toMatchObject({ name: 'delo-plugin-authoring', provider: 'delo-plugin-authoring', source: 'bundled', invocation: { modelInvocable: true } })
  expect(content.startsWith('# Making a Delo plugin')).toBe(true)
})

it('teaches the scaffold in the workspace and leaves turning on to the person', async () => {
  const { content } = await load(await registered())
  expect(content).toContain('delorun plugin new')
  expect(content).toMatch(/delorun plugin dev.*person's loop/u)
  expect(content).toContain('do not run it yourself')
  expect(content).toContain('plugins/<bare name>')
  expect(content).toMatch(/cannot turn a plugin on/u)
  expect(content).toMatch(/at their computer/u)
})

it('refuses a skill file with no frontmatter or no description', () => {
  expect(() => plugin.parseSkill('# no frontmatter', 'x')).toThrow('no frontmatter')
  expect(() => plugin.parseSkill('---\nname: a\n---\nbody', 'x')).toThrow('no description')
})
