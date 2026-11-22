import { describe, expect, it } from 'vitest'
import { MAX_REASON_LENGTH, readDeclaredAccess } from '../../../src/compat-bench/privacy/access.ts'

describe('dsh.access', () => {
  it('is empty when the manifest has no block', () => {
    for (const manifest of [undefined, null, 'x', {}, { dsh: {} }, { dsh: 5 }]) expect(readDeclaredAccess(manifest)).toEqual({ declared: {}, problems: [] })
  })

  it('reads reasons for the eight marker keys', () => {
    const result = readDeclaredAccess({ dsh: { access: { sendsOut: ' Fetches   pages. ', actsForYou: 'Runs git.' } } })
    expect(result).toEqual({ declared: { sendsOut: 'Fetches pages.', actsForYou: 'Runs git.' }, problems: [] })
  })

  it('names what is wrong without dropping the good keys', () => {
    const result = readDeclaredAccess({ dsh: { access: { sendsOut: '', network: 'x', code: 4, chats: 'Reads the chat to summarise it.' } } })
    expect(result.declared).toEqual({ chats: 'Reads the chat to summarise it.' })
    expect(result.problems).toEqual([
      'dsh.access.sendsOut needs a short reason as a string',
      'dsh.access.network is not one of: code, chats, modelKeys, otherSecrets, sendsOut, actsForYou, opensADoor, leavesBehind',
      'dsh.access.code needs a short reason as a string',
    ])
  })

  it('cuts a long reason and says so', () => {
    const result = readDeclaredAccess({ dsh: { access: { code: 'x'.repeat(MAX_REASON_LENGTH + 50) } } })
    expect(result.declared.code).toHaveLength(MAX_REASON_LENGTH)
    expect(result.problems).toHaveLength(1)
  })

  it('refuses a block that is not an object', () => {
    expect(readDeclaredAccess({ dsh: { access: ['sendsOut'] } }).problems).toEqual(['dsh.access is not an object'])
    expect(readDeclaredAccess({ dsh: { access: 'all' } }).problems).toEqual(['dsh.access is not an object'])
  })
})
