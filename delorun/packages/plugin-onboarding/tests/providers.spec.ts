import { describe, expect, it } from 'vitest'
import { cardsOf, CUSTOM_PROVIDER, deriveKeyRef, KEY_PAGES, routeIdOf, usableKey } from '../src/client/providers.ts'
import type { KeyTestAnswer } from '../src/wire.ts'
import { DIRECTORY } from './directory.fixture.ts'

const answer = (results: Readonly<Record<string, KeyTestAnswer['providers'][number]['result']>>): KeyTestAnswer => ({
  providers: Object.entries(results).map(([provider, result]) => ({ provider, name: provider, result })),
})

describe('the provider cards', () => {
  it('offer the usable routes a key connects, common providers first, and nothing the key test leaves out', () => {
    const cards = cardsOf(answer({ typesafe: 'no-key', openai: 'no-key', 'deepseek-official': 'works', azure: 'no-key', gateway: 'no-key', 'deepseek-account': 'no-key' }), DIRECTORY)
    expect(cards.map(card => card.provider)).toEqual(['deepseek-official', 'openai', 'gateway', 'typesafe', CUSTOM_PROVIDER])
  })

  it('also offer a directory route the key test does not list, unless the row hides it, and an endpoint offer last', () => {
    const cards = cardsOf({ ...answer({ 'deepseek-official': 'works' }), hidden: ['typesafe'] }, DIRECTORY)
    expect(cards.map(card => [card.provider, card.found])).toEqual([['deepseek-official', true], ['openai', false], ['gateway', false], [CUSTOM_PROVIDER, false]])
    expect(cards.at(-1)).toMatchObject({ custom: true, needsBaseURL: true })
  })

  it('name a catalogue route that carries only its id, and list the providers with a key page before the rest', () => {
    const lower = { settingsNs: 'llm-pi-ai', authEnv: [], baseURLEnv: [] }
    const directory = [
      { provider: 'zzz', displayName: 'zzz', settingsPath: ['providers', 'zzz'], ...lower, authEnv: ['ZZZ_API_KEY'] },
      { provider: 'groq', displayName: 'groq', settingsPath: ['providers', 'groq'], ...lower, authEnv: ['GROQ_API_KEY'] },
      { provider: 'aaa', displayName: 'Aaa', settingsPath: ['providers', 'aaa'], ...lower, authEnv: ['AAA_API_KEY'] },
    ]
    const cards = cardsOf(answer({}), directory)
    expect(cards.map(card => card.name)).toEqual(['Groq', 'Aaa', 'zzz', 'OpenAI-compatible endpoint'])
  })

  it('offer no endpoint when the directory has no namespace for declared routes', () => {
    const cards = cardsOf(answer({ 'deepseek-official': 'works' }), DIRECTORY.filter(entry => entry.settingsNs !== 'llm-pi-ai'))
    expect(cards.map(card => card.provider)).toEqual(['deepseek-official'])
  })

  it('make a route id from an endpoint name, with a suffix when it is taken', () => {
    expect(routeIdOf('Company gateway!', () => false)).toBe('company-gateway')
    expect(routeIdOf('Company gateway', id => id === 'company-gateway')).toBe('company-gateway-2')
    expect(routeIdOf('3D', () => false)).toBe('d')
    expect(routeIdOf('###', () => false)).toBeUndefined()
    expect(routeIdOf('x', () => true)).toBeUndefined()
  })

  it('mark a route found when a key is held, whatever its test said, and not when none is', () => {
    const cards = cardsOf(answer({ 'deepseek-official': 'rejected', openai: 'no-key', typesafe: 'untested' }), DIRECTORY)
    expect(Object.fromEntries(cards.map(card => [card.provider, card.found]))).toEqual({ 'deepseek-official': true, 'openai': false, 'typesafe': true, 'gateway': false, [CUSTOM_PROVIDER]: false })
  })

  it('link only to a provider\'s own key page, and ask for a base URL only from a declared route', () => {
    const cards = cardsOf(answer({ openai: 'no-key', typesafe: 'no-key', gateway: 'no-key' }), DIRECTORY)
    const by = Object.fromEntries(cards.map(card => [card.provider, card]))
    expect(by['openai']?.keyPage).toBe('https://platform.openai.com/api-keys')
    expect(by['typesafe']?.keyPage).toBeUndefined()
    expect(by['gateway']?.needsBaseURL).toBe(true)
    expect(by['openai']?.needsBaseURL).toBe(false)
    for (const url of Object.values(KEY_PAGES)) expect(url).toMatch(/^https:\/\//)
  })
})

describe('a typed key', () => {
  it.each([['  sk-abc123  ', 'sk-abc123'], ['', undefined], ['   ', undefined], ['sk abc', undefined], ['OPENAI_API_KEY=sk-abc', undefined]])('reads %j as %j', (typed, expected) => {
    expect(usableKey(typed)).toBe(expected)
  })

  it('derives the conventional credential reference', () => {
    expect(deriveKeyRef('minimax-cn')).toBe('MINIMAX_CN_API_KEY')
  })
})
