import { describe, expect, it } from 'vitest'
import { decideCaa, type CaaQuestion } from '../../src/stack/index.ts'

const ACCOUNT = 'https://127.0.0.1:1/acct/home'
const QUESTION: CaaQuestion = { name: 'studio.example.com', issuerDomain: 'letsencrypt.org', accountUri: ACCOUNT, validationMethod: 'tls-alpn-01' }
const REQUIRED = `letsencrypt.org; accounturi=${ACCOUNT}; validationmethods=tls-alpn-01`

describe('the CAA decision', () => {
  it('permits issuance without any record set, and with a set that restricts no issuer', () => {
    expect(decideCaa({}, QUESTION).permitted).toBe(true)
    expect(decideCaa({ 'example.com': [{ flags: 0, tag: 'iodef', value: 'mailto:security@example.com' }] }, QUESTION).permitted).toBe(true)
  })

  it('uses the closest set when climbing towards the root', () => {
    const zone = { 'studio.example.com': [{ flags: 0, tag: 'issue', value: REQUIRED }], 'example.com': [{ flags: 0, tag: 'issue', value: 'other-ca.example' }] }
    expect(decideCaa(zone, QUESTION)).toMatchObject({ permitted: true, relevantName: 'studio.example.com' })
    expect(decideCaa(zone, { ...QUESTION, name: 'www.example.com' })).toMatchObject({ permitted: false, relevantName: 'example.com' })
  })

  it('refuses another account, another method, another issuer and an unknown critical property', () => {
    const at = (value: string, flags = 0, tag = 'issue'): ReturnType<typeof decideCaa> => decideCaa({ 'example.com': [{ flags, tag, value }] }, QUESTION)
    expect(at(REQUIRED).permitted).toBe(true)
    expect(at('letsencrypt.org; accounturi=https://127.0.0.1:1/acct/other').permitted).toBe(false)
    expect(at('letsencrypt.org; validationmethods=http-01,dns-01').permitted).toBe(false)
    expect(at('other-ca.example').permitted).toBe(false)
    expect(at(';').permitted).toBe(false)
    expect(decideCaa({ 'example.com': [{ flags: 0, tag: 'issue', value: REQUIRED }, { flags: 128, tag: 'tbs', value: 'x' }] }, QUESTION).permitted).toBe(false)
  })

  it('reads issuewild for a wildcard when present, and issue otherwise', () => {
    const zone = { 'example.com': [{ flags: 0, tag: 'issue', value: REQUIRED }, { flags: 0, tag: 'issuewild', value: ';' }] }
    expect(decideCaa(zone, QUESTION).permitted).toBe(true)
    expect(decideCaa(zone, { ...QUESTION, name: '*.example.com' }).permitted).toBe(false)
    expect(decideCaa({ 'example.com': [{ flags: 0, tag: 'issue', value: REQUIRED }] }, { ...QUESTION, name: '*.example.com' }).permitted).toBe(true)
  })
})
