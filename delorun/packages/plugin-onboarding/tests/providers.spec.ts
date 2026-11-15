import { describe, expect, it } from 'vitest'
import { cardsOf, deriveKeyRef, KEY_PAGES, usableKey } from '../src/client/providers.ts'
import type { KeyTestAnswer } from '../src/wire.ts'
import { DIRECTORY } from './directory.fixture.ts'

const answer = (results: Readonly<Record<string, KeyTestAnswer['providers'][number]['result']>>): KeyTestAnswer => ({
  providers: Object.entries(results).map(([provider, result]) => ({ provider, name: provider, result })),
})

describe('the provider cards', () => {
  it('offer the usable routes a key connects, common providers first, and nothing the key test leaves out', () => {
    const cards = cardsOf(answer({ typesafe: 'no-key', openai: 'no-key', 'deepseek-official': 'works', azure: 'no-key', gateway: 'no-key', 'deepseek-account': 'no-key' }), DIRECTORY)
    expect(cards.map(card => card.provider)).toEqual(['deepseek-official', 'openai', 'gateway', 'typesafe'])
  })

  it('mark a route found when a key is held, whatever its test said, and not when none is', () => {
    const cards = cardsOf(answer({ 'deepseek-official': 'rejected', openai: 'no-key', typesafe: 'untested' }), DIRECTORY)
    expect(Object.fromEntries(cards.map(card => [card.provider, card.found]))).toEqual({ 'deepseek-official': true, 'openai': false, 'typesafe': true })
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
