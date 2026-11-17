/**
 * The delorun-plugin-authoring and delorun-harness-copy skills: registered with the skill registry, and their text states
 * the rules they teach.
 */
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
 * @param index - which listed candidate; the plugin skill by default.
 * @returns the candidate and its body.
 */
async function load(provider: SkillProvider, index = 0): Promise<{ readonly candidate: SkillCandidate, readonly content: string }> {
  const candidate = (await provider.list({} as never) as readonly SkillCandidate[])[index]
  const skill = await provider.get(candidate!, {} as never)
  return { candidate: candidate!, content: skill!.content }
}

it('lists two model-invocable bundled skills and returns each body without the frontmatter', async () => {
  const provider = await registered()
  expect((await provider.list({} as never) as readonly SkillCandidate[]).map(candidate => candidate.name)).toEqual(['delorun-plugin-authoring', 'delorun-harness-copy'])
  const { candidate, content } = await load(provider)
  expect(candidate).toMatchObject({ name: 'delorun-plugin-authoring', provider: 'delorun-plugin-authoring', source: 'bundled', invocation: { modelInvocable: true } })
  expect(content.startsWith('# Making a Delorun plugin')).toBe(true)
  const harness = await load(provider, 1)
  expect(harness.candidate).toMatchObject({ name: 'delorun-harness-copy', source: 'bundled', invocation: { modelInvocable: true } })
  expect(harness.candidate.description).toContain('Works only in a chat with full access.')
  expect(harness.content.startsWith('# Changing Delorun itself')).toBe(true)
})

it('points the agent at the copy, says it needs full access, and leaves every decision to the person', async () => {
  const { content } = await load(await registered(), 1)
  expect(content).toContain('delorun changes edit-harness')
  expect(content).toContain('Make my copy')
  expect(content).toMatch(/does not have full access, tell the person and stop/u)
  expect(content).toMatch(/Never write in the installed release/u)
  expect(content).toMatch(/Never run `delorun changes apply`, `undo`, `discard`, `edit-harness --discard` or `protection`/u)
  expect(content).toContain('delorun-plugin-authoring')
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
