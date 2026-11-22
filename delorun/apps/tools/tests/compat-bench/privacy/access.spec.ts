import { describe, expect, it } from 'vitest'
import { MAX_REASON_LENGTH, readDeclaredAccess } from '../../../src/compat-bench/privacy/access.ts'

describe('dsh.access', () => {
  it('is empty when the manifest has no block', () => {
    for (const manifest of [undefined, null, 'x', {}, { dsh: {} }, { dsh: 5 }]) expect(readDeclaredAccess(manifest)).toEqual({ declared: {}, problems: [] })
  })

  it('reads false and objects with a why for the eight marker keys', () => {
    const result = readDeclaredAccess({ dsh: { access: { version: 1, sendsOut: { why: ' Fetches   pages. ', hosts: [{ host: 'Example.com', carries: ['none'], why: 'x' }, { host: 'model-provider' }] }, actsForYou: { actions: ['runs-commands'], why: 'Runs git.' }, opensADoor: false } } })
    expect(result).toEqual({
      declared: {
        sendsOut: { does: true, why: 'Fetches pages.', hosts: ['example.com', 'model-provider'] },
        actsForYou: { does: true, why: 'Runs git.' },
        opensADoor: { does: false, why: '' },
      },
      problems: [],
    })
  })

  it('names what is wrong without dropping the good keys', () => {
    const result = readDeclaredAccess({ dsh: { access: { version: 1, sendsOut: '', network: { why: 'x' }, code: { read: true }, chats: { why: 'Reads the chat to summarise it.' }, leavesBehind: true } } })
    expect(result.declared).toEqual({ chats: { does: true, why: 'Reads the chat to summarise it.' } })
    expect(result.problems).toEqual([
      'dsh.access.sendsOut is false or an object with a short "why" as a string',
      'dsh.access.network is not one of: code, chats, modelKeys, otherSecrets, sendsOut, actsForYou, opensADoor, leavesBehind',
      'dsh.access.code is false or an object with a short "why" as a string',
      'dsh.access.leavesBehind is false or an object with a short "why" as a string',
    ])
  })

  it('cuts a long why and says so', () => {
    const result = readDeclaredAccess({ dsh: { access: { version: 1, code: { why: 'x'.repeat(MAX_REASON_LENGTH + 50) } } } })
    expect(result.declared.code?.why).toHaveLength(MAX_REASON_LENGTH)
    expect(result.problems).toHaveLength(1)
  })

  it('notes a missing version and ignores a version it does not read', () => {
    expect(readDeclaredAccess({ dsh: { access: { code: false } } })).toEqual({ declared: { code: { does: false, why: '' } }, problems: ['dsh.access.version is missing (it is 1)'] })
    const other = readDeclaredAccess({ dsh: { access: { version: 2, code: false } } })
    expect(other.declared).toEqual({})
    expect(other.problems).toEqual(['dsh.access.version is 2; the bench reads version 1 only, so the block is ignored'])
  })

  it('notes a malformed host list', () => {
    expect(readDeclaredAccess({ dsh: { access: { version: 1, sendsOut: { why: 'x', hosts: 'a.com' } } } }).problems).toEqual(['dsh.access.sendsOut.hosts is not a list'])
    const result = readDeclaredAccess({ dsh: { access: { version: 1, sendsOut: { why: 'x', hosts: [{ why: 'no host' }] } } } })
    expect(result.declared.sendsOut?.hosts).toEqual([])
    expect(result.problems).toEqual(['dsh.access.sendsOut.hosts has an entry with no "host" name'])
  })

  it('refuses a block that is not an object', () => {
    expect(readDeclaredAccess({ dsh: { access: ['sendsOut'] } }).problems).toEqual(['dsh.access is not an object'])
    expect(readDeclaredAccess({ dsh: { access: 'all' } }).problems).toEqual(['dsh.access is not an object'])
  })
})
