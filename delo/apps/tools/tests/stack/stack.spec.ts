import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createCertificationRequest, installNetworkGuard, requestOverTls, startStandInStack, type CtIssuance, type NetworkGuard, type StandInStack, type ValidationTarget } from '../../src/stack/index.ts'
import { startAlpnResponder, TestAcmeClient, type AlpnResponder } from './acme-client.ts'
import { authorize, checkIdToken, exchange, keySet, REDIRECT_URI } from './c14-relying-party.ts'

const NAME = 'studio.example.com'

let guard: NetworkGuard
let stack: StandInStack
const targets = new Map<string, ValidationTarget>()
const responders: AlpnResponder[] = []

beforeAll(async () => {
  // Installed before anything listens or connects, so every socket of the stack passes through it.
  guard = installNetworkGuard()
  stack = await startStandInStack({ acme: { tlsAlpnTarget: name => targets.get(name) } })
})

afterAll(async () => {
  await Promise.all(responders.map(async responder => responder.close()))
  await stack.close()
  guard.uninstall()
})

describe('the stand-in stack under the network guard', () => {
  it('signs in at issuer A', async () => {
    const client = stack.issuerA.registerClient([REDIRECT_URI])
    const flow = await authorize(stack.issuerA, client)
    const body = (await exchange(stack.issuerA, client, flow.callback.get('code') ?? '', flow.verifier)).json() as { id_token: string }
    expect(await checkIdToken(body.id_token, { issuer: stack.issuerA.issuer, clientId: client.clientId, nonce: flow.nonce, jwks: await keySet(stack.issuerA) })).toHaveProperty('claims')
    expect(stack.issuerB.issuer).not.toBe(stack.issuerA.issuer)
  })

  it('issues a certificate whose issuance the transparency log then answers, and reports its revocation', async () => {
    const client = new TestAcmeClient(stack.acme.directoryUrl, stack.acme.ca)
    await client.start()
    await client.createAccount()
    const order = (await client.post(client.endpoint('newOrder'), { identifiers: [{ type: 'dns', value: NAME }] })).json() as { finalize: string, authorizations: string[] }
    const challenges = ((await client.post(order.authorizations[0] ?? '', '')).json() as { challenges: { type: string, url: string, token: string }[] }).challenges
    const challenge = challenges.find(candidate => candidate.type === 'tls-alpn-01')
    const responder = await startAlpnResponder(NAME, await client.keyAuthorization(challenge?.token ?? ''))
    responders.push(responder)
    targets.set(NAME, responder)
    expect((await client.post(challenge?.url ?? '', {})).json()).toMatchObject({ status: 'valid' })
    const csr = await createCertificationRequest([NAME])
    expect((await client.post(order.finalize, { csr: csr.der.toString('base64url') })).json()).toMatchObject({ status: 'valid' })

    const issued = stack.acme.issuances[0]
    const search = async (): Promise<CtIssuance[]> => (await requestOverTls(stack.transparency.sourceUrl.replace('<domain>', 'example.com'), { ca: stack.authority.certificate.pem })).json() as CtIssuance[]
    expect((await search()).map(issuance => [issuance.cert_sha256, issuance.dns_names, issuance.revoked])).toEqual([[issued?.certificate.sha256, [NAME], false]])

    const unrequested = await stack.acme.issueUnrequested(['*.example.com'])
    stack.acme.revoke(unrequested.certificate.sha256)
    expect((await search()).map(issuance => [issuance.dns_names, issuance.revoked])).toEqual([[[NAME], false], [['*.example.com'], true]])
  })

  it('sees no connection leave loopback', () => {
    expect(guard.connections.length).toBeGreaterThan(0)
    expect(guard.connections.filter(connection => !connection.loopback)).toEqual([])
    expect(guard.refusals).toEqual([])
  })
})
