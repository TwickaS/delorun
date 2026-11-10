/**
 * A minimal RFC 8555 client for the stand-in specs: an ES256 account key, nonce handling,
 * POST and POST-as-GET, and a TLS-ALPN-01 responder on loopback. It drives the ACME stand-in
 * the way a home's ACME client would, and lets a spec send malformed requests on purpose.
 *
 * @module @delo/tools/tests/stack/acme-client
 */
import { createServer, type Server } from 'node:tls'
import type { AddressInfo } from 'node:net'
import { calculateJwkThumbprint, exportJWK, FlattenedSign, generateKeyPair, type JWK } from 'jose'
import { ACME_TLS_ALPN_PROTOCOL, acmeIdentifierExtension, createSelfSigned, LOOPBACK_HOST, requestOverTls, type TlsResponse } from '../../src/stack/index.ts'

/** Changes to one request's protected header or signature, for refusal cases. */
export interface Tamper {
  readonly nonce?: string
  readonly url?: string
  readonly alg?: string
  readonly kid?: string
  readonly flipSignature?: boolean
}

/** A test ACME client bound to one directory. */
export class TestAcmeClient {
  accountUrl: string | undefined
  private directory: Record<string, string> = {}
  private nonce: string | undefined
  private keys: { readonly privateKey: CryptoKey, readonly jwk: JWK } | undefined

  readonly directoryUrl: string
  readonly ca: string

  constructor(directoryUrl: string, ca: string) {
    this.directoryUrl = directoryUrl
    this.ca = ca
  }

  /**
   * Fetch the directory and make the account key.
   * @returns the directory.
   */
  async start(): Promise<Record<string, unknown>> {
    const pair = await generateKeyPair('ES256', { extractable: true })
    this.keys = { privateKey: pair.privateKey, jwk: await exportJWK(pair.publicKey) }
    const directory = (await requestOverTls(this.directoryUrl, { ca: this.ca })).json() as Record<string, string>
    this.directory = directory
    return directory
  }

  /**
   * The endpoint URL of a directory entry.
   * @param name - the entry, such as `newOrder`.
   * @returns its URL.
   */
  endpoint(name: string): string {
    const value = this.directory[name]
    if (value === undefined) throw new Error(`no ${name} in the directory`)
    return value
  }

  /**
   * The key authorization of a challenge token.
   * @param token - the token.
   * @returns `<token>.<thumbprint>`.
   */
  async keyAuthorization(token: string): Promise<string> {
    return `${token}.${await calculateJwkThumbprint(this.requireKeys().jwk)}`
  }

  /**
   * POST a JWS to a URL; an empty string payload is a POST-as-GET.
   * @param url - the resource.
   * @param payload - the payload object, or `''`.
   * @param tamper - header or signature changes.
   * @returns the response.
   */
  async post(url: string, payload: unknown, tamper: Tamper = {}): Promise<TlsResponse> {
    const nonce = tamper.nonce ?? await this.freshNonce()
    const keys = this.requireKeys()
    const kid = tamper.kid ?? this.accountUrl
    const key = kid === undefined ? { jwk: keys.jwk } : { kid }
    const body = payload === '' ? new Uint8Array() : new TextEncoder().encode(JSON.stringify(payload))
    const header = { alg: 'ES256', nonce, url: tamper.url ?? url, ...key }
    const jws = await new FlattenedSign(body).setProtectedHeader(header).sign(keys.privateKey)
    // Another algorithm is written into the header after signing, so the stand-in sees it before any signature check.
    if (tamper.alg !== undefined) jws.protected = Buffer.from(JSON.stringify({ ...header, alg: tamper.alg })).toString('base64url')
    if (tamper.flipSignature === true) {
      const bytes = Buffer.from(jws.signature, 'base64url')
      bytes[0] = (bytes[0] ?? 0) ^ 0xff
      jws.signature = bytes.toString('base64url')
    }
    const response = await requestOverTls(url, { ca: this.ca, method: 'POST', headers: { 'content-type': 'application/jose+json' }, body: JSON.stringify(jws) })
    const next = response.headers['replay-nonce']
    this.nonce = typeof next === 'string' ? next : undefined
    return response
  }

  /**
   * Create the account, agreeing to the terms.
   * @returns the account URL.
   */
  async createAccount(): Promise<string> {
    const response = await this.post(this.endpoint('newAccount'), { termsOfServiceAgreed: true })
    if (response.status !== 201 && response.status !== 200) throw new Error(`newAccount: ${response.body.toString()}`)
    this.accountUrl = String(response.headers.location)
    return this.accountUrl
  }

  /**
   * A nonce from the newNonce endpoint, unless the last response left one.
   * @returns the nonce.
   */
  async freshNonce(): Promise<string> {
    const kept = this.nonce
    this.nonce = undefined
    if (kept !== undefined) return kept
    const response = await requestOverTls(this.endpoint('newNonce'), { ca: this.ca, method: 'HEAD' })
    return String(response.headers['replay-nonce'])
  }

  private requireKeys(): { readonly privateKey: CryptoKey, readonly jwk: JWK } {
    if (this.keys === undefined) throw new Error('start the client first')
    return this.keys
  }
}

/** A loopback TLS-ALPN-01 responder. */
export interface AlpnResponder {
  readonly host: string
  readonly port: number
  readonly close: () => Promise<void>
}

/**
 * Serve a TLS-ALPN-01 challenge certificate on loopback, as a home's reach listener does.
 * @param name - the identifier.
 * @param keyAuthorization - the key authorization whose digest the certificate carries.
 * @param alpn - the ALPN protocols to offer; `acme-tls/1` when absent.
 * @returns the responder's address.
 */
export async function startAlpnResponder(name: string, keyAuthorization: string, alpn: readonly string[] = [ACME_TLS_ALPN_PROTOCOL]): Promise<AlpnResponder> {
  const certificate = await createSelfSigned({ dnsNames: [name], extensions: [acmeIdentifierExtension(keyAuthorization)] })
  const server: Server = createServer({ key: certificate.keyPem, cert: certificate.pem, ALPNProtocols: [...alpn] }, socket => { socket.end() })
  await new Promise<void>(resolve => { server.listen(0, LOOPBACK_HOST, resolve) })
  return {
    host: LOOPBACK_HOST,
    port: (server.address() as AddressInfo).port,
    close: async () => new Promise<void>(resolve => { server.close(() => { resolve() }) }),
  }
}
