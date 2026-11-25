import { describe, expect, it } from 'vitest'
import { compareRequests, normaliseText, signatureOf } from '../../../src/compat-bench/privacy/requests.ts'

const request = (system: string, tools: string[], user: string, model = 'm1') => JSON.stringify({ model, system, tools: tools.map(name => ({ name })), messages: [{ role: 'user', content: [{ type: 'text', text: user }] }] })

describe('model request comparison', () => {
  it('ignores the chat word, numbers, ids and paths that differ between runs', () => {
    const base = signatureOf(request('Today is 2026-11-22 in /home/bench/ws. Session 0a1b2c3d4e5f.', ['read'], 'hello quokka-aaa-11'), 'quokka-aaa-11')
    const run = signatureOf(request('Today is 2026-11-23 in /home/bench/other. Session ffeeddccbbaa.', ['read'], 'hello quokka-bbb-22'), 'quokka-bbb-22')
    expect(base).toBeDefined()
    expect(compareRequests(run!, base!)).toEqual([])
  })

  it('says a tool was added and the system prompt grew, with an excerpt of what was added', () => {
    const base = signatureOf(request('You are helpful.', ['read'], 'hi'), 'quokka-w-1')!
    const run = signatureOf(request('You are helpful. Always call remember_all first.', ['read', 'remember_all'], 'hi'), 'quokka-w-1')!
    expect(compareRequests(run, base)).toEqual([
      'the system prompt added 32 characters (" Always call remember_all first.")',
      'a tool was added (remember_all)',
    ])
  })

  it('says a message was rewritten and when more requests were made', () => {
    const base = signatureOf(request('s', [], 'hi there'), 'quokka-w-1')!
    const run = signatureOf(`${request('s', [], 'hi there, with extra context')}\n${request('s', [], 'again')}`, 'quokka-w-1')!
    expect(compareRequests(run, base)).toEqual(['message 1 (user) differs: added 20 characters (", with extra context")', '1 more model request was made'])
  })

  it('returns no signature for an empty log and skips torn lines', () => {
    expect(signatureOf('', 'quokka-w-1')).toBeUndefined()
    expect(signatureOf(`{"model":\n${request('s', [], 'x')}`, 'quokka-w-1')?.count).toBe(1)
  })

  it('normalises text', () => {
    expect(normaliseText('see /a/b/c at 12:30 quokka-x', 'quokka-x')).toBe('see <path> at #:# <chat>')
  })
})
