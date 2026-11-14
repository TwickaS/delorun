import { DEFAULT_CT_SOURCE } from '@delorun/contract-relay-protocol'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createTestAuthority, requestOverTls, startCtStandIn, type CtIssuance, type CtStandIn, type IssuedCertificate, type TestAuthority } from '../../src/stack/index.ts'

let authority: TestAuthority
let ct: CtStandIn
let exact: IssuedCertificate
let wildcard: IssuedCertificate
let multiName: IssuedCertificate
let sibling: IssuedCertificate
let unrelated: IssuedCertificate

beforeAll(async () => {
  authority = await createTestAuthority('ct spec TLS')
  ct = await startCtStandIn(authority)
  const issuer = await createTestAuthority('ct spec issuing CA')
  exact = await issuer.issue({ dnsNames: ['studio.example.com'] })
  wildcard = await issuer.issue({ dnsNames: ['*.example.com'] })
  multiName = await issuer.issue({ dnsNames: ['mail.other.example', 'studio.example.com', 'shop.other.example'] })
  sibling = await issuer.issue({ dnsNames: ['www.example.com'] })
  unrelated = await issuer.issue({ dnsNames: ['example.org'] })
  for (const certificate of [exact, wildcard, multiName, sibling, unrelated]) ct.log(certificate)
})

afterAll(async () => {
  await ct.close()
})

async function search(query: string): Promise<{ readonly status: number, readonly body: unknown }> {
  const response = await requestOverTls(`${new URL(ct.sourceUrl).origin}/v1/issuances?${query}`, { ca: ct.ca })
  return { status: response.status, body: response.json() }
}

async function hashes(query: string): Promise<string[]> {
  return ((await search(query)).body as CtIssuance[]).map(issuance => issuance.cert_sha256)
}

describe('the Certificate Transparency stand-in', () => {
  it('serves the contract default source path, with <domain> left for the home to fill', () => {
    expect(ct.sourceUrl).toBe(DEFAULT_CT_SOURCE.replace('https://api.certspotter.com', new URL(ct.sourceUrl).origin))
  })

  it('answers an exact search with certificates naming the domain itself', async () => {
    expect(await hashes('domain=studio.example.com&expand=dns_names')).toEqual([exact.sha256, multiName.sha256])
  })

  it('answers a wildcard search with the wildcard that covers the name', async () => {
    expect(await hashes('domain=studio.example.com&match_wildcards=true')).toEqual([exact.sha256, wildcard.sha256, multiName.sha256])
  })

  it('answers the contract query for the registrable domain with exact, wildcard and multi-name certificates', async () => {
    const response = await requestOverTls(ct.sourceUrl.replace('<domain>', 'example.com'), { ca: ct.ca })
    const issuances = response.json() as CtIssuance[]
    expect(issuances.map(issuance => issuance.dns_names)).toEqual([['studio.example.com'], ['*.example.com'], ['mail.other.example', 'studio.example.com', 'shop.other.example'], ['www.example.com']])
    expect(issuances.every(issuance => !('cert_der' in issuance) && !('revocation' in issuance))).toBe(true)
    expect(issuances[0]).toMatchObject({ id: expect.any(String), tbs_sha256: expect.stringMatching(/^[0-9a-f]{64}$/), pubkey_sha256: expect.stringMatching(/^[0-9a-f]{64}$/), not_before: expect.any(String), not_after: expect.any(String), revoked: false })
  })

  it('leaves dns_names out unless expanded, and pages with after', async () => {
    const [first] = (await search('domain=studio.example.com')).body as Record<string, unknown>[]
    expect(first).not.toHaveProperty('dns_names')
    const page = (await search(`domain=example.com&include_subdomains=true&after=${String(first?.id)}`)).body as CtIssuance[]
    expect(page.map(issuance => issuance.cert_sha256)).toEqual([wildcard.sha256, multiName.sha256, sibling.sha256])
  })

  it('holds a certificate until a log includes it, and reports revocation when expanded', async () => {
    const issuer = await createTestAuthority('ct spec late CA')
    const late = await issuer.issue({ dnsNames: ['late.example.net'] })
    ct.log(late, { included: false })
    expect(await hashes('domain=late.example.net')).toEqual([])
    ct.include(late.sha256)
    expect(await hashes('domain=late.example.net')).toEqual([late.sha256])
    ct.revoke(late.sha256, 1)
    const [revoked] = (await search('domain=late.example.net&expand=revocation&expand=cert_der')).body as CtIssuance[]
    expect(revoked).toMatchObject({ revoked: true, revocation: { reason: 1 }, cert_der: late.der.toString('base64') })
  })

  it('answers errors in Cert Spotter form', async () => {
    expect(await search('include_subdomains=true')).toEqual({ status: 400, body: { code: 'missing_field', message: 'domain is required', field: 'domain' } })
    expect((await search('domain=example.com&include_subdomains=maybe')).status).toBe(400)
    ct.nextError(429, 'rate_limited')
    expect(await search('domain=example.com')).toMatchObject({ status: 429, body: { code: 'rate_limited' } })
    expect(ct.searches.at(-1)).toEqual({ query: 'domain=example.com', status: 429 })
  })
})
