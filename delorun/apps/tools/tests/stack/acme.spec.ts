import { X509Certificate } from 'node:crypto'
import { NAMED_CA } from '@delorun/contract-reach-providers'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  ACME_CHALLENGE_TYPES, createCertificationRequest, createTestAuthority, pemDecode, startAcmeStandIn,
  type AcmeIssuance, type AcmeStandIn, type AcmeStandInOptions, type CaaZone, type TestAuthority, type ValidationTarget,
} from '../../src/stack/index.ts'
import { startAlpnResponder, TestAcmeClient, type AlpnResponder } from './acme-client.ts'

const NAME = 'studio.example.com'

let authority: TestAuthority
let acme: AcmeStandIn | undefined
let responders: AlpnResponder[]
let targets: Map<string, ValidationTarget>
let issued: AcmeIssuance[]
let revoked: AcmeIssuance[]

beforeEach(async () => {
  authority ??= await createTestAuthority('acme spec TLS')
  responders = []
  targets = new Map()
  issued = []
  revoked = []
})

afterEach(async () => {
  await acme?.close()
  acme = undefined
  await Promise.all(responders.map(async responder => responder.close()))
})

async function start(options: Partial<AcmeStandInOptions> = {}): Promise<{ readonly acme: AcmeStandIn, readonly client: TestAcmeClient }> {
  await acme?.close()
  const started = await startAcmeStandIn({
    authority,
    tlsAlpnTarget: name => targets.get(name),
    onIssued: issuance => { issued.push(issuance) },
    onRevoked: issuance => { revoked.push(issuance) },
    ...options,
  })
  acme = started
  const client = new TestAcmeClient(started.directoryUrl, started.ca)
  await client.start()
  await client.createAccount()
  return { acme: started, client }
}

interface Challenge { readonly type: string, readonly url: string, readonly token: string, readonly status: string }

async function orderFor(client: TestAcmeClient, names: readonly string[]): Promise<{ readonly url: string, readonly finalize: string, readonly authorizations: readonly string[] }> {
  const response = await client.post(client.endpoint('newOrder'), { identifiers: names.map(value => ({ type: 'dns', value })) })
  expect(response.status).toBe(201)
  const body = response.json() as { finalize: string, authorizations: string[] }
  return { url: String(response.headers.location), finalize: body.finalize, authorizations: body.authorizations }
}

async function challengesOf(client: TestAcmeClient, authorization: string): Promise<Challenge[]> {
  return ((await client.post(authorization, '')).json() as { challenges: Challenge[] }).challenges
}

// Answer the TLS-ALPN-01 challenge of each authorization through a loopback responder.
async function proveByTlsAlpn(client: TestAcmeClient, name: string, authorization: string): Promise<Record<string, unknown>> {
  const challenge = (await challengesOf(client, authorization)).find(candidate => candidate.type === 'tls-alpn-01')
  if (challenge === undefined) throw new Error('no tls-alpn-01 challenge')
  const responder = await startAlpnResponder(name, await client.keyAuthorization(challenge.token))
  responders.push(responder)
  targets.set(name, responder)
  return (await client.post(challenge.url, {})).json() as Record<string, unknown>
}

async function finalize(client: TestAcmeClient, finalizeUrl: string, names: readonly string[]): Promise<{ readonly status: number, readonly body: Record<string, unknown>, readonly keyPem: string }> {
  const request = await createCertificationRequest(names)
  const response = await client.post(finalizeUrl, { csr: request.der.toString('base64url') })
  return { status: response.status, body: response.json() as Record<string, unknown>, keyPem: request.keyPem }
}

describe('the ACME stand-in', () => {
  it('lists its endpoints and the named CA as its CAA identity', async () => {
    const { client } = await start()
    const directory = await new TestAcmeClient(client.directoryUrl, client.ca).start()
    expect(directory).toMatchObject({ newNonce: expect.any(String), newAccount: expect.any(String), newOrder: expect.any(String), revokeCert: expect.any(String), meta: { caaIdentities: [NAMED_CA.caaIssuerDomain] } })
  })

  it('issues for a test name after a TLS-ALPN-01 challenge answered on loopback', async () => {
    const { acme: standIn, client } = await start()
    const order = await orderFor(client, [NAME])
    const challenges = await challengesOf(client, order.authorizations[0] ?? '')
    expect(challenges.map(challenge => challenge.type).sort()).toEqual([...ACME_CHALLENGE_TYPES].sort())
    expect(await proveByTlsAlpn(client, NAME, order.authorizations[0] ?? '')).toMatchObject({ type: 'tls-alpn-01', status: 'valid' })
    expect((await client.post(order.url, '')).json()).toMatchObject({ status: 'ready' })

    const finalized = await finalize(client, order.finalize, [NAME])
    expect(finalized.status).toBe(200)
    expect(finalized.body).toMatchObject({ status: 'valid', certificate: expect.any(String) })
    const download = await client.post(String(finalized.body.certificate), '')
    expect(download.headers['content-type']).toBe('application/pem-certificate-chain')
    const leaf = new X509Certificate(pemDecode(download.body.toString('utf8')))
    expect(leaf.subjectAltName).toBe(`DNS:${NAME}`)
    expect(leaf.verify(new X509Certificate(standIn.issuerCertificate).publicKey)).toBe(true)
    expect(leaf.checkPrivateKey((await import('node:crypto')).createPrivateKey(finalized.keyPem))).toBe(true)

    expect(standIn.challengesStarted).toEqual([{ type: 'tls-alpn-01', identifier: NAME, account: client.accountUrl }])
    expect(issued.map(issuance => [issuance.account, issuance.dnsNames])).toEqual([[client.accountUrl, [NAME]]])
  })

  it('records an HTTP-01 start and fails it when no responder is named', async () => {
    const { acme: standIn, client } = await start()
    const order = await orderFor(client, [NAME])
    const http = (await challengesOf(client, order.authorizations[0] ?? '')).find(challenge => challenge.type === 'http-01')
    expect((await client.post(http?.url ?? '', {})).json()).toMatchObject({ status: 'invalid', error: { type: 'urn:ietf:params:acme:error:connection' } })
    expect(standIn.challengesStarted.map(challenge => challenge.type)).toEqual(['http-01'])
    expect((await client.post(order.url, '')).json()).toMatchObject({ status: 'invalid' })
  })

  it('validates DNS-01, the only challenge of a wildcard, against the supplied TXT records', async () => {
    let txt: string[] = []
    const { client } = await start({ dnsTxt: () => txt })
    const order = await orderFor(client, ['*.example.com'])
    const challenges = await challengesOf(client, order.authorizations[0] ?? '')
    expect(challenges.map(challenge => challenge.type)).toEqual(['dns-01'])
    const { createHash } = await import('node:crypto')
    txt = [createHash('sha256').update(await client.keyAuthorization(challenges[0]?.token ?? '')).digest('base64url')]
    expect((await client.post(challenges[0]?.url ?? '', {})).json()).toMatchObject({ status: 'valid' })
  })

  it('fails TLS-ALPN-01 when the responder proves another key authorization or does not speak acme-tls/1', async () => {
    const { client } = await start()
    const order = await orderFor(client, [NAME, 'www.example.com'])
    const [first = '', second = ''] = order.authorizations
    const wrong = await startAlpnResponder(NAME, 'another.authorization')
    const plain = await startAlpnResponder('www.example.com', await client.keyAuthorization((await challengesOf(client, second)).find(candidate => candidate.type === 'tls-alpn-01')?.token ?? ''), ['h2'])
    responders.push(wrong, plain)
    targets.set(NAME, wrong)
    targets.set('www.example.com', plain)
    for (const [authorization, detail] of [[first, /acmeIdentifier/], [second, /acme-tls\/1|validation connection failed/]] as const) {
      const challenge = (await challengesOf(client, authorization)).find(candidate => candidate.type === 'tls-alpn-01')
      const result = (await client.post(challenge?.url ?? '', {})).json() as { status: string, error: { detail: string } }
      expect(result.status).toBe('invalid')
      expect(result.error.detail).toMatch(detail)
    }
  })

  it('refuses a reused nonce, another URL, an unknown account, a broken signature and an HMAC algorithm', async () => {
    const { client } = await start()
    const newOrder = client.endpoint('newOrder')
    const payload = { identifiers: [{ type: 'dns', value: NAME }] }
    const used = await client.freshNonce()
    expect((await client.post(newOrder, payload, { nonce: used })).status).toBe(201)
    const cases = [
      [{ nonce: used }, 'badNonce'],
      [{ url: `${newOrder}?other` }, 'unauthorized'],
      [{ kid: `${String(client.accountUrl)}-unknown` }, 'accountDoesNotExist'],
      [{ flipSignature: true }, 'unauthorized'],
      [{ alg: 'HS256' }, 'badSignatureAlgorithm'],
    ] as const
    for (const [tamper, type] of cases) {
      const response = await client.post(newOrder, payload, tamper)
      expect.soft(response.json(), JSON.stringify(tamper)).toMatchObject({ type: `urn:ietf:params:acme:error:${type}` })
    }
  })

  it('refuses a CSR whose names differ from the order', async () => {
    const { client } = await start()
    const order = await orderFor(client, [NAME])
    await proveByTlsAlpn(client, NAME, order.authorizations[0] ?? '')
    const finalized = await finalize(client, order.finalize, [NAME, 'extra.example.com'])
    expect(finalized.body).toMatchObject({ type: 'urn:ietf:params:acme:error:badCSR' })
    expect(issued).toEqual([])
  })

  describe('CAA', () => {
    async function issueUnder(zone: (account: string) => CaaZone): Promise<Record<string, unknown>> {
      // The stand-in reads the records at finalization, after the account URL they name exists.
      const records: Record<string, CaaZone[string]> = {}
      const { client } = await start({ caa: records })
      Object.assign(records, zone(client.accountUrl ?? ''))
      const order = await orderFor(client, [NAME])
      await proveByTlsAlpn(client, NAME, order.authorizations[0] ?? '')
      return (await finalize(client, order.finalize, [NAME])).body
    }

    it('issues when the relevant set names the CA with this account and tls-alpn-01', async () => {
      expect(await issueUnder(account => ({ 'example.com': [{ flags: 0, tag: 'issue', value: `letsencrypt.org; accounturi=${account}; validationmethods=tls-alpn-01` }] }))).toMatchObject({ status: 'valid' })
    })

    it('refuses when the relevant set names another account, another method or another CA', async () => {
      for (const value of ['letsencrypt.org; accounturi=https://127.0.0.1/acct/other', 'letsencrypt.org; validationmethods=http-01', 'other-ca.example']) {
        issued.length = 0
        expect(await issueUnder(() => ({ [NAME]: [{ flags: 0, tag: 'issue', value }] }))).toMatchObject({ type: 'urn:ietf:params:acme:error:caa' })
        expect(issued).toEqual([])
      }
    })
  })

  it('revokes for the ordering account, refuses another account, and revokes as the CA', async () => {
    const { acme: standIn, client } = await start()
    const order = await orderFor(client, [NAME])
    await proveByTlsAlpn(client, NAME, order.authorizations[0] ?? '')
    await finalize(client, order.finalize, [NAME])
    const der = issued[0]?.certificate.der.toString('base64url')

    const stranger = new TestAcmeClient(standIn.directoryUrl, standIn.ca)
    await stranger.start()
    await stranger.createAccount()
    expect((await stranger.post(stranger.endpoint('revokeCert'), { certificate: der })).json()).toMatchObject({ type: 'urn:ietf:params:acme:error:unauthorized' })
    expect((await client.post(client.endpoint('revokeCert'), { certificate: der })).status).toBe(200)
    expect(revoked.map(issuance => issuance.certificate.sha256)).toEqual([issued[0]?.certificate.sha256])

    const unrequested = await standIn.issueUnrequested(['*.example.com'])
    expect(unrequested.account).toBeUndefined()
    standIn.revoke(unrequested.certificate.sha256)
    expect(revoked).toHaveLength(2)
  })

  it('answers the next request to an endpoint with an injected problem', async () => {
    const { acme: standIn, client } = await start()
    standIn.nextProblem('newOrder', { type: 'rateLimited', status: 429, detail: 'too many orders' })
    const refused = await client.post(client.endpoint('newOrder'), { identifiers: [{ type: 'dns', value: NAME }] })
    expect(refused.status).toBe(429)
    expect(refused.json()).toMatchObject({ type: 'urn:ietf:params:acme:error:rateLimited' })
    expect((await client.post(client.endpoint('newOrder'), { identifiers: [{ type: 'dns', value: NAME }] })).status).toBe(201)
  })
})
