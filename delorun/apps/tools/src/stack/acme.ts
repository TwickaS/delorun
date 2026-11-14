/**
 * An ACME (RFC 8555) certificate authority stand-in on loopback HTTPS, standing in for the
 * named CA of contract C7. It serves the directory, nonces, accounts, orders, authorizations,
 * challenges, finalization, certificate download and revocation, and verifies every request's
 * JWS, nonce and URL. Each authorization offers `http-01`, `dns-01` and `tls-alpn-01`, as the
 * named CA does, and records every challenge a client starts. It validates TLS-ALPN-01 (RFC 8737)
 * by a TLS connection to the target its caller names for the identifier, HTTP-01 by an HTTP
 * request to that target and DNS-01 against TXT records its caller supplies; it opens no other
 * connection. Before issuing it applies the CAA records its caller supplies (RFC 8659, 8657).
 *
 * Hooks: a certificate issued for another account (an unrequested certificate), revocation by
 * the CA, and a problem document in place of the next answer of an endpoint. Issued and revoked
 * certificates are reported to callbacks, which the stack connects to its transparency log.
 *
 * @module @delorun/tools/stack/acme
 */
import { createHash, randomBytes, X509Certificate } from 'node:crypto'
import { request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http'
import { connect as tlsConnect } from 'node:tls'
import { NAMED_CA } from '@delorun/contract-reach-providers'
import { calculateJwkThumbprint, flattenedVerify, importJWK, type FlattenedJWSInput, type JWK } from 'jose'
import { decideCaa, type CaaZone } from './caa.ts'
import {
  ACME_IDENTIFIER_OID, certificateDnsNames, certificateExtension, createTestAuthority, readCertificationRequest,
  type IssuedCertificate, type TestAuthority,
} from './certificates.ts'
import { listenHttps, readBody, sendJson, type LoopbackServer } from './loopback.ts'

/** The challenge types each authorization offers. */
export const ACME_CHALLENGE_TYPES = ['http-01', 'dns-01', 'tls-alpn-01'] as const

/** One challenge type of {@link ACME_CHALLENGE_TYPES}. */
export type AcmeChallengeType = (typeof ACME_CHALLENGE_TYPES)[number]

/** JWS algorithms the stand-in accepts on requests. */
export const ACME_JWS_ALGORITHMS = ['ES256', 'ES384', 'RS256', 'EdDSA'] as const

/** The ALPN protocol of TLS-ALPN-01. */
export const ACME_TLS_ALPN_PROTOCOL = 'acme-tls/1'

/** How long a validation connection may take, in milliseconds. */
export const VALIDATION_TIMEOUT_MS = 10_000

/** An RFC 8555 problem the stand-in answers with. */
export interface AcmeProblem {
  /** The error name after `urn:ietf:params:acme:error:`, such as `rateLimited`. */
  readonly type: string
  readonly status: number
  readonly detail: string
}

/** Endpoints {@link AcmeStandIn.nextProblem} can fail. */
export type AcmeEndpoint = 'newAccount' | 'newOrder' | 'challenge' | 'finalize' | 'certificate' | 'revokeCert'

/** A challenge a client started. */
export interface StartedChallenge {
  readonly type: AcmeChallengeType
  readonly identifier: string
  readonly account: string
}

/** A certificate the stand-in issued. */
export interface AcmeIssuance {
  /** The account URL that ordered it, or undefined for one issued through {@link AcmeStandIn.issueUnrequested}. */
  readonly account: string | undefined
  readonly dnsNames: readonly string[]
  readonly certificate: IssuedCertificate
  revoked: boolean
}

/** Where a validation connects for an identifier. */
export interface ValidationTarget {
  readonly host: string
  readonly port: number
}

/** How to start the stand-in. */
export interface AcmeStandInOptions {
  /** The stack's test authority, which signs the stand-in's own HTTPS certificate. */
  readonly authority: TestAuthority
  /** Where TLS-ALPN-01 connects for an identifier; without it, or when it returns undefined, the challenge fails. */
  readonly tlsAlpnTarget?: (identifier: string) => ValidationTarget | undefined
  /** Where HTTP-01 connects for an identifier; without it, or when it returns undefined, the challenge fails. */
  readonly httpTarget?: (identifier: string) => ValidationTarget | undefined
  /** The TXT records of `_acme-challenge.<identifier>`; without it the challenge fails. */
  readonly dnsTxt?: (identifier: string) => readonly string[]
  /** CAA records by owner name; absent means no CAA record anywhere. */
  readonly caa?: CaaZone
  /** The issuer domain CAA records must name; the named CA's when absent. */
  readonly caaIdentity?: string
  /** Validity of an issued certificate, in days; 90 when absent. */
  readonly certificateDays?: number
  /** Called with each certificate the stand-in issues. */
  readonly onIssued?: (issuance: AcmeIssuance) => void
  /** Called with each certificate the stand-in revokes. */
  readonly onRevoked?: (issuance: AcmeIssuance) => void
}

/** A running ACME stand-in. */
export interface AcmeStandIn {
  /** The directory URL a client starts from. */
  readonly directoryUrl: string
  /** The PEM certificate of the authority a client trusts for the stand-in's HTTPS. */
  readonly ca: string
  /** The PEM certificate of the CA that signs issued certificates. */
  readonly issuerCertificate: string
  /** Every challenge a client started, in order. */
  readonly challengesStarted: readonly StartedChallenge[]
  /** Every certificate issued, in order. */
  readonly issuances: readonly AcmeIssuance[]
  /** The account URLs created, in order. */
  readonly accounts: () => readonly string[]
  /**
   * Answer the next request to an endpoint with a problem.
   * @param endpoint - the endpoint.
   * @param problem - the problem document.
   */
  readonly nextProblem: (endpoint: AcmeEndpoint, problem: AcmeProblem) => void
  /**
   * Issue a certificate for names without any order, as a CA does for another account; it reaches `onIssued` like any other.
   * @param dnsNames - the names, such as `*.example.com`.
   * @returns the issuance, with its key.
   */
  readonly issueUnrequested: (dnsNames: readonly string[]) => Promise<AcmeIssuance>
  /**
   * Revoke a certificate as the CA, without a client request.
   * @param sha256 - the certificate's lowercase hex SHA-256.
   */
  readonly revoke: (sha256: string) => void
  /** Stop listening. */
  readonly close: () => Promise<void>
}

interface Account {
  readonly url: string
  readonly jwk: JWK
  readonly thumbprint: string
}

interface Challenge {
  readonly id: string
  readonly type: AcmeChallengeType
  readonly token: string
  status: 'pending' | 'processing' | 'valid' | 'invalid'
  error?: { readonly type: string, readonly detail: string }
  validated?: string
}

interface Authorization {
  readonly id: string
  readonly account: string
  readonly identifier: string
  readonly wildcard: boolean
  readonly challenges: Challenge[]
  status: 'pending' | 'valid' | 'invalid'
}

interface Order {
  readonly id: string
  readonly account: string
  readonly identifiers: readonly string[]
  readonly authorizations: readonly Authorization[]
  status: 'pending' | 'ready' | 'valid' | 'invalid'
  certificate?: AcmeIssuance
  error?: { readonly type: string, readonly detail: string }
}

class ProblemError extends Error {
  readonly problem: AcmeProblem

  constructor(problem: AcmeProblem) {
    super(problem.detail)
    this.problem = problem
  }
}

function problem(type: string, status: number, detail: string): ProblemError {
  return new ProblemError({ type, status, detail })
}

const DNS_NAME = /^(?:\*\.)?(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/

function id(): string {
  return randomBytes(12).toString('base64url')
}

function parseObject(text: string, what: string): Record<string, unknown> {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    // JSON.parse throws SyntaxError for text that is not JSON; that is a malformed request.
    if (error instanceof SyntaxError) throw problem('malformed', 400, `${what} is not JSON`)
    throw error
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw problem('malformed', 400, `${what} is not an object`)
  return parsed as Record<string, unknown>
}

async function validateTlsAlpn(target: ValidationTarget, identifier: string, keyAuthorization: string): Promise<string | undefined> {
  const expected = createHash('sha256').update(keyAuthorization).digest()
  return new Promise(resolve => {
    const socket = tlsConnect({ host: target.host, port: target.port, servername: identifier, ALPNProtocols: [ACME_TLS_ALPN_PROTOCOL], rejectUnauthorized: false, timeout: VALIDATION_TIMEOUT_MS })
    const finish = (failure: string | undefined): void => {
      socket.destroy()
      resolve(failure)
    }
    socket.once('timeout', () => { finish('the validation connection timed out') })
    socket.once('error', error => { finish(`the validation connection failed: ${error.message}`) })
    socket.once('secureConnect', () => {
      if (socket.alpnProtocol !== ACME_TLS_ALPN_PROTOCOL) {
        finish(`the responder did not negotiate ${ACME_TLS_ALPN_PROTOCOL}`)
        return
      }
      const der = socket.getPeerX509Certificate()?.raw
      if (der === undefined) {
        finish('the responder presented no certificate')
        return
      }
      const names = certificateDnsNames(der)
      if (names.length !== 1 || names[0]?.toLowerCase() !== identifier.toLowerCase()) {
        finish(`the certificate names ${names.join(', ')}, not exactly ${identifier}`)
        return
      }
      const extension = certificateExtension(der, ACME_IDENTIFIER_OID)
      // The extension wraps an OCTET STRING of 32 bytes: tag 0x04, length 0x20, digest.
      const digest = extension?.value.subarray(2)
      if (extension === undefined || !extension.critical || extension.value[0] !== 0x04 || extension.value[1] !== 0x20 || digest === undefined || !expected.equals(digest)) {
        finish('the acmeIdentifier extension is missing, not critical or wrong')
        return
      }
      finish(undefined)
    })
  })
}

async function validateHttp(target: ValidationTarget, identifier: string, token: string, keyAuthorization: string): Promise<string | undefined> {
  return new Promise(resolve => {
    const sent = httpRequest({ host: target.host, port: target.port, path: `/.well-known/acme-challenge/${token}`, headers: { host: identifier }, timeout: VALIDATION_TIMEOUT_MS }, response => {
      let body = ''
      response.setEncoding('utf8').on('data', (chunk: string) => { body += chunk })
      response.on('end', () => { resolve(response.statusCode === 200 && body.trim() === keyAuthorization ? undefined : 'the HTTP response is not the key authorization') })
    })
    sent.once('timeout', () => { sent.destroy(new Error('timed out')) })
    sent.once('error', error => { resolve(`the validation request failed: ${error.message}`) })
    sent.end()
  })
}

/**
 * Start an ACME stand-in on `127.0.0.1`, with a new issuing CA of its own.
 * @param options - the HTTPS authority, validation targets, CAA records, validity and callbacks.
 * @returns the running stand-in.
 */
export async function startAcmeStandIn(options: AcmeStandInOptions): Promise<AcmeStandIn> {
  const issuer = await createTestAuthority('Delorun stand-in ACME CA')
  const caaIdentity = options.caaIdentity ?? NAMED_CA.caaIssuerDomain
  const certificateDays = options.certificateDays ?? 90
  const nonces = new Set<string>()
  const accounts = new Map<string, Account>()
  const accountsByThumbprint = new Map<string, Account>()
  const orders = new Map<string, Order>()
  const authorizations = new Map<string, Authorization>()
  const challenges = new Map<string, { readonly challenge: Challenge, readonly authorization: Authorization }>()
  const certificates = new Map<string, AcmeIssuance>()
  const challengesStarted: StartedChallenge[] = []
  const issuances: AcmeIssuance[] = []
  const problems = new Map<AcmeEndpoint, AcmeProblem[]>()
  let origin = ''

  const url = (path: string): string => `${origin}${path}`
  const newNonce = (): string => {
    const nonce = randomBytes(16).toString('base64url')
    nonces.add(nonce)
    return nonce
  }
  const headers = (extra: Record<string, string> = {}): Record<string, string> => ({ 'replay-nonce': newNonce(), link: `<${url('/directory')}>;rel="index"`, ...extra })
  const injected = (endpoint: AcmeEndpoint): void => {
    const next = problems.get(endpoint)?.shift()
    if (next !== undefined) throw new ProblemError(next)
  }

  const record = (issuance: AcmeIssuance): AcmeIssuance => {
    issuances.push(issuance)
    certificates.set(issuance.certificate.sha256, issuance)
    options.onIssued?.(issuance)
    return issuance
  }
  const issue = async (dnsNames: readonly string[], account: string | undefined, publicKeyInfo?: Uint8Array): Promise<AcmeIssuance> => {
    const notBefore = new Date(Date.now() - 60_000)
    const certificate = await issuer.issue({ dnsNames, notBefore, notAfter: new Date(notBefore.getTime() + certificateDays * 86_400_000), ...(publicKeyInfo === undefined ? {} : { publicKeyInfo }) })
    return record({ account, dnsNames: [...dnsNames], certificate, revoked: false })
  }
  const revoke = (issuance: AcmeIssuance): void => {
    if (issuance.revoked) throw problem('alreadyRevoked', 400, 'the certificate is already revoked')
    issuance.revoked = true
    options.onRevoked?.(issuance)
  }

  // Verify the JWS of a POST and return its payload and the signing account, or the new account's key.
  const verified = async (request: IncomingMessage, path: string, keyMode: 'jwk' | 'kid' | 'either'): Promise<{ readonly payload: string, readonly account?: Account, readonly jwk?: JWK }> => {
    if (request.headers['content-type'] !== 'application/jose+json') throw problem('malformed', 415, 'the content type is not application/jose+json')
    const body = parseObject((await readBody(request)).toString('utf8'), 'the request body')
    if (typeof body.protected !== 'string' || typeof body.payload !== 'string' || typeof body.signature !== 'string') throw problem('malformed', 400, 'the body is not a flattened JWS')
    const jws: FlattenedJWSInput = { protected: body.protected, payload: body.payload, signature: body.signature }
    const header = parseObject(Buffer.from(jws.protected ?? '', 'base64url').toString('utf8'), 'the protected header')
    if (typeof header.alg !== 'string' || !(ACME_JWS_ALGORITHMS as readonly string[]).includes(header.alg)) throw problem('badSignatureAlgorithm', 400, `algorithm ${String(header.alg)} is not accepted`)
    if (header.url !== url(path)) throw problem('unauthorized', 401, 'the JWS url does not equal the request URL')
    if (typeof header.nonce !== 'string' || !nonces.delete(header.nonce)) throw problem('badNonce', 400, 'the nonce is unknown or used')
    const hasJwk = typeof header.jwk === 'object' && header.jwk !== null
    const hasKid = typeof header.kid === 'string'
    if (hasJwk === hasKid) throw problem('malformed', 400, 'the header needs exactly one of jwk and kid')
    if (keyMode === 'jwk' && !hasJwk) throw problem('malformed', 400, 'this request needs a jwk')
    if (keyMode === 'kid' && !hasKid) throw problem('malformed', 400, 'this request needs a kid')
    let account: Account | undefined
    let jwk: JWK
    if (hasKid) {
      account = accounts.get(String(header.kid))
      if (account === undefined) throw problem('accountDoesNotExist', 400, 'the kid names no account')
      jwk = account.jwk
    } else {
      jwk = header.jwk as JWK
    }
    try {
      const result = await flattenedVerify(jws, await importJWK(jwk, header.alg), { algorithms: [...ACME_JWS_ALGORITHMS] })
      return { payload: Buffer.from(result.payload).toString('utf8'), ...(account === undefined ? { jwk } : { account }) }
    } catch (error) {
      // jose throws for a key that does not import or a signature that does not verify; both are unauthorized.
      throw problem('unauthorized', 401, `the JWS does not verify: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  const payloadObject = (payload: string): Record<string, unknown> => parseObject(payload, 'the payload')
  const owned = <T extends { readonly account: string | undefined }>(value: T | undefined, account: Account | undefined): T => {
    if (value === undefined) throw problem('malformed', 404, 'no such resource')
    if (value.account !== account?.url) throw problem('unauthorized', 403, 'the resource belongs to another account')
    return value
  }

  const challengeJson = (challenge: Challenge): Record<string, unknown> => ({
    type: challenge.type, url: url(`/chall/${challenge.id}`), token: challenge.token, status: challenge.status,
    ...(challenge.validated === undefined ? {} : { validated: challenge.validated }),
    ...(challenge.error === undefined ? {} : { error: challenge.error }),
  })
  const authorizationJson = (authorization: Authorization): Record<string, unknown> => ({
    status: authorization.status,
    expires: new Date(Date.now() + 7 * 86_400_000).toISOString(),
    identifier: { type: 'dns', value: authorization.identifier.replace(/^\*\./, '') },
    challenges: authorization.challenges.map(challengeJson),
    ...(authorization.wildcard ? { wildcard: true } : {}),
  })
  const orderJson = (order: Order): Record<string, unknown> => ({
    status: order.status,
    expires: new Date(Date.now() + 7 * 86_400_000).toISOString(),
    identifiers: order.identifiers.map(value => ({ type: 'dns', value })),
    authorizations: order.authorizations.map(authorization => url(`/authz/${authorization.id}`)),
    finalize: url(`/order/${order.id}/finalize`),
    ...(order.certificate === undefined ? {} : { certificate: url(`/cert/${order.certificate.certificate.sha256}`) }),
    ...(order.error === undefined ? {} : { error: order.error }),
  })

  const validate = async (challenge: Challenge, authorization: Authorization, account: Account): Promise<string | undefined> => {
    const keyAuthorization = `${challenge.token}.${account.thumbprint}`
    const name = authorization.identifier.replace(/^\*\./, '')
    switch (challenge.type) {
      case 'tls-alpn-01': {
        const target = options.tlsAlpnTarget?.(name)
        return target === undefined ? 'no TLS-ALPN-01 responder for this name' : validateTlsAlpn(target, name, keyAuthorization)
      }
      case 'http-01': {
        const target = options.httpTarget?.(name)
        return target === undefined ? 'no HTTP-01 responder for this name' : validateHttp(target, name, challenge.token, keyAuthorization)
      }
      case 'dns-01': {
        const expected = createHash('sha256').update(keyAuthorization).digest('base64url')
        return (options.dnsTxt?.(name) ?? []).includes(expected) ? undefined : 'no matching TXT record'
      }
      default: {
        const unknownType: never = challenge.type
        throw new Error(`unknown challenge type ${String(unknownType)}`)
      }
    }
  }

  const routes = async (request: IncomingMessage, response: ServerResponse, path: string): Promise<void> => {
    const method = request.method ?? ''
    if (path === '/directory' && method === 'GET') {
      sendJson(response, 200, {
        newNonce: url('/new-nonce'), newAccount: url('/new-account'), newOrder: url('/new-order'), revokeCert: url('/revoke-cert'),
        meta: { caaIdentities: [caaIdentity] },
      }, headers())
      return
    }
    if (path === '/new-nonce' && (method === 'HEAD' || method === 'GET')) {
      response.writeHead(method === 'HEAD' ? 200 : 204, { 'cache-control': 'no-store', ...headers() })
      response.end()
      return
    }
    if (method !== 'POST') throw problem('malformed', 405, 'ACME resources take POST')

    if (path === '/new-account') {
      const { payload, jwk } = await verified(request, path, 'jwk')
      injected('newAccount')
      if (jwk === undefined) throw problem('malformed', 400, 'no jwk')
      const fields = payloadObject(payload)
      const thumbprint = await calculateJwkThumbprint(jwk)
      const existing = accountsByThumbprint.get(thumbprint)
      if (existing !== undefined) {
        sendJson(response, 200, { status: 'valid', orders: `${existing.url}/orders` }, headers({ location: existing.url }))
        return
      }
      if (fields.onlyReturnExisting === true) throw problem('accountDoesNotExist', 400, 'no account for this key')
      if (fields.termsOfServiceAgreed !== true) throw problem('userActionRequired', 403, 'the terms of service must be agreed')
      const account: Account = { url: url(`/acct/${id()}`), jwk, thumbprint }
      accounts.set(account.url, account)
      accountsByThumbprint.set(thumbprint, account)
      sendJson(response, 201, { status: 'valid', orders: `${account.url}/orders` }, headers({ location: account.url }))
      return
    }

    if (path === '/revoke-cert') {
      const { payload, account, jwk } = await verified(request, path, 'either')
      injected('revokeCert')
      const fields = payloadObject(payload)
      const der = typeof fields.certificate === 'string' ? Buffer.from(fields.certificate, 'base64url') : Buffer.alloc(0)
      const issuance = certificates.get(createHash('sha256').update(der).digest('hex'))
      if (issuance === undefined) throw problem('malformed', 404, 'the certificate was not issued here')
      const byOwner = account !== undefined && account.url === issuance.account
      const byKey = jwk !== undefined && await calculateJwkThumbprint(jwk) === await calculateJwkThumbprint(new X509Certificate(issuance.certificate.der).publicKey)
      if (!byOwner && !byKey) throw problem('unauthorized', 403, 'only the ordering account or the certificate key may revoke')
      revoke(issuance)
      response.writeHead(200, headers())
      response.end()
      return
    }

    const { payload, account } = await verified(request, path, 'kid')
    if (account === undefined) throw problem('accountDoesNotExist', 400, 'no account')

    if (path === '/new-order') {
      injected('newOrder')
      const fields = payloadObject(payload)
      const identifiers: unknown[] = Array.isArray(fields.identifiers) ? fields.identifiers : []
      if (identifiers.length === 0) throw problem('malformed', 400, 'an order needs identifiers')
      const names = identifiers.map(identifier => {
        const entry = typeof identifier === 'object' && identifier !== null ? identifier as Record<string, unknown> : {}
        if (entry.type !== 'dns') throw problem('unsupportedIdentifier', 400, 'only dns identifiers are supported')
        const value = String(entry.value).toLowerCase()
        if (!DNS_NAME.test(value)) throw problem('rejectedIdentifier', 400, `${value} is not a DNS name`)
        return value
      })
      const order: Order = {
        id: id(),
        account: account.url,
        identifiers: names,
        authorizations: names.map(name => {
          const wildcard = name.startsWith('*.')
          const authorization: Authorization = {
            id: id(), account: account.url, identifier: name, wildcard, status: 'pending',
            // A wildcard is validated only by DNS-01, as at the named CA.
            challenges: (wildcard ? ['dns-01' as const] : ACME_CHALLENGE_TYPES).map(type => ({ id: id(), type, token: randomBytes(32).toString('base64url'), status: 'pending' as const })),
          }
          authorizations.set(authorization.id, authorization)
          for (const challenge of authorization.challenges) challenges.set(challenge.id, { challenge, authorization })
          return authorization
        }),
        status: 'pending',
      }
      orders.set(order.id, order)
      sendJson(response, 201, orderJson(order), headers({ location: url(`/order/${order.id}`) }))
      return
    }

    const segments = path.split('/').filter(segment => segment !== '')
    if (segments[0] === 'authz' && segments.length === 2) {
      sendJson(response, 200, authorizationJson(owned(authorizations.get(segments[1] ?? ''), account)), headers())
      return
    }
    if (segments[0] === 'chall' && segments.length === 2) {
      const entry = challenges.get(segments[1] ?? '')
      const { challenge, authorization } = owned(entry === undefined ? undefined : { ...entry, account: entry.authorization.account }, account)
      injected('challenge')
      if (payload !== '' && challenge.status === 'pending' && authorization.status === 'pending') {
        challengesStarted.push({ type: challenge.type, identifier: authorization.identifier, account: account.url })
        challenge.status = 'processing'
        const failure = await validate(challenge, authorization, account)
        if (failure === undefined) {
          challenge.status = 'valid'
          challenge.validated = new Date().toISOString()
          authorization.status = 'valid'
        } else {
          challenge.status = 'invalid'
          challenge.error = { type: `urn:ietf:params:acme:error:${challenge.type === 'dns-01' ? 'dns' : challenge.type === 'http-01' ? 'connection' : 'tls'}`, detail: failure }
          authorization.status = 'invalid'
        }
        for (const order of orders.values()) {
          if (!order.authorizations.includes(authorization) || order.status !== 'pending') continue
          if (order.authorizations.some(candidate => candidate.status === 'invalid')) order.status = 'invalid'
          else if (order.authorizations.every(candidate => candidate.status === 'valid')) order.status = 'ready'
        }
      }
      sendJson(response, 200, challengeJson(challenge), headers({ link: `<${url(`/authz/${authorization.id}`)}>;rel="up"` }))
      return
    }
    if (segments[0] === 'order' && segments.length === 2) {
      sendJson(response, 200, orderJson(owned(orders.get(segments[1] ?? ''), account)), headers({ location: url(path) }))
      return
    }
    if (segments[0] === 'order' && segments[2] === 'finalize' && segments.length === 3) {
      const order = owned(orders.get(segments[1] ?? ''), account)
      injected('finalize')
      if (order.status !== 'ready') throw problem('orderNotReady', 403, `the order is ${order.status}`)
      const fields = payloadObject(payload)
      let contents
      try {
        contents = await readCertificationRequest(Buffer.from(typeof fields.csr === 'string' ? fields.csr : '', 'base64url'))
      } catch (error) {
        // pkijs throws for a request that does not parse, and the reader for one whose signature fails.
        throw problem('badCSR', 400, error instanceof Error ? error.message : String(error))
      }
      const requested = [...new Set(contents.dnsNames.map(name => name.toLowerCase()))].sort()
      if (requested.join(',') !== [...order.identifiers].sort().join(',')) throw problem('badCSR', 400, 'the CSR names differ from the order identifiers')
      for (const authorization of order.authorizations) {
        const method = authorization.challenges.find(challenge => challenge.status === 'valid')?.type ?? ''
        const decision = decideCaa(options.caa ?? {}, { name: authorization.identifier, issuerDomain: caaIdentity, accountUri: account.url, validationMethod: method })
        if (!decision.permitted) {
          order.status = 'invalid'
          order.error = { type: 'urn:ietf:params:acme:error:caa', detail: decision.reason }
          throw problem('caa', 403, decision.reason)
        }
      }
      order.certificate = await issue(order.identifiers, account.url, contents.publicKeyInfo)
      order.status = 'valid'
      sendJson(response, 200, orderJson(order), headers({ location: url(`/order/${order.id}`) }))
      return
    }
    if (segments[0] === 'cert' && segments.length === 2) {
      const issuance = owned(certificates.get(segments[1] ?? ''), account)
      injected('certificate')
      const chain = `${issuance.certificate.pem}${issuer.certificate.pem}`
      response.writeHead(200, { 'content-type': 'application/pem-certificate-chain', ...headers() })
      response.end(chain)
      return
    }
    throw problem('malformed', 404, 'no such resource')
  }

  const server: LoopbackServer = await listenHttps(options.authority, [], async (request, response) => {
    const path = new URL(request.url ?? '/', 'https://stand-in').pathname
    try {
      await routes(request, response, path)
    } catch (error) {
      if (!(error instanceof ProblemError)) throw error
      sendJson(response, error.problem.status, { type: `urn:ietf:params:acme:error:${error.problem.type}`, detail: error.problem.detail }, { 'content-type': 'application/problem+json', ...headers() })
    }
  })
  origin = server.origin

  return {
    directoryUrl: url('/directory'),
    ca: options.authority.certificate.pem,
    issuerCertificate: issuer.certificate.pem,
    challengesStarted,
    issuances,
    accounts: () => [...accounts.keys()],
    nextProblem: (endpoint, next) => {
      const queue = problems.get(endpoint) ?? []
      queue.push(next)
      problems.set(endpoint, queue)
    },
    issueUnrequested: async dnsNames => issue(dnsNames, undefined),
    revoke: sha256 => {
      const issuance = certificates.get(sha256)
      if (issuance === undefined) throw new Error(`no certificate ${sha256}`)
      revoke(issuance)
    },
    close: async () => server.close(),
  }
}
