/** The delorun-report-problem skill: registered with the skill registry, and its text states the rules it teaches. */
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

it('lists one user-invocable bundled skill and returns its body without the frontmatter', async () => {
  const { candidate, content } = await load(await registered())
  expect(candidate).toMatchObject({ name: 'delorun-report-problem', provider: 'delorun-report-problem', source: 'bundled', invocation: { modelInvocable: true, userInvocable: true } })
  expect(content.startsWith('# Helping the person report a problem')).toBe(true)
})

it('drafts the issue in the bug form\'s sections and never posts it', async () => {
  const { content } = await load(await registered())
  expect(content).toContain('You never post it')
  expect(content).toContain('Do not run `gh issue create`')
  expect(content).toContain('delorun --version')
  expect(content).toContain('delorun logs')
  for (const section of ['Version', 'Does stock DeepSeek Harness reproduce it?', 'Steps to reproduce', 'What happened', 'Logs']) expect(content).toContain(`**${section}**`)
  expect(content).toContain('nothing has been sent')
})

it('refuses a skill file with no frontmatter or no description', () => {
  expect(() => plugin.parseSkill('# no frontmatter', 'x')).toThrow('no frontmatter')
  expect(() => plugin.parseSkill('---\nname: a\n---\nbody', 'x')).toThrow('no description')
})
