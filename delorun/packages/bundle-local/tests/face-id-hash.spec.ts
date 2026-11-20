/**
 * The browser's grant hashes against the home's: the client specs take their expected hashes from the browser helper,
 * so this spec, which runs under Node where the home's `node:crypto` helper loads, holds the two equal.
 */
import { describe, expect, it } from 'vitest'
import { hashArgs as homeHashArgs, hashRequest as homeHashRequest } from '../../home-auth/src/grants.ts'
import { hashArgs, hashRequest } from '../src/client/face-id-hash.ts'

describe('the browser grant hashes', () => {
  it.each([
    ['an empty call', {}],
    ['a plugin install', { id: 'reports', version: '1.2.0' }],
    ['a key save', { ref: 'DEEPSEEK_API_KEY', value: 'sk-new' }],
    ['a terminal create', { sessionId: 's1', request: { id: 'term-1', cols: 80, rows: 24 } }],
    ['a terminal attach', { agentId: 's1', id: 'term-2' }],
    ['a folder list', { path: '/home/me' }],
    ['keys out of order, with an undefined field', { b: 1, a: [true, null, 'x'], c: undefined }],
  ])('hash %s as the home does', async (_name, args) => {
    // A browser hash that differs from the home's leaves every grant for that call refused.
    expect(await hashArgs(args)).toBe(homeHashArgs(args))
  })

  it('hashes a Fetch request as the home does, whatever the body\'s spacing and the method\'s case', async () => {
    const body = '{ "names": ["@delorun/reports"] }'
    const path = '/studio/api/delorunPacks.add?from=card'
    expect(await hashRequest({ method: 'post', path, body })).toBe(homeHashRequest({ method: 'POST', path, body: new TextEncoder().encode(body) }))
    expect(await hashRequest({ method: 'POST', path: '/p', body: { a: 1 } })).toBe(homeHashRequest({ method: 'POST', path: '/p', body: new TextEncoder().encode('{"a":1}') }))
  })
})
