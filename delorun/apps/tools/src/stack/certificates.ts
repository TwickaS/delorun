/**
 * X.509 material for the stand-in stack, made in memory with pkijs over Node's Web Crypto:
 * a test certificate authority that issues server certificates for loopback stand-ins and
 * for ACME orders, self-signed certificates such as a TLS-ALPN-01 challenge response,
 * PKCS #10 requests, and readers for the names, extensions and hashes of a certificate.
 * Every key is ECDSA P-256 unless a request supplies its own public key. Nothing is
 * written to disk; a consumer that needs a file writes the PEM it receives.
 *
 * @module @delorun/tools/stack/certificates
 */
import { createHash, randomBytes, webcrypto } from 'node:crypto'
import { isIP } from 'node:net'
import * as asn1js from 'asn1js'
import * as pkijs from 'pkijs'

/** OID of the TLS-ALPN-01 `acmeIdentifier` extension (RFC 8737 §3). */
export const ACME_IDENTIFIER_OID = '1.3.6.1.5.5.7.1.31'

const OID = {
  commonName: '2.5.4.3',
  subjectAltName: pkijs.id_SubjectAltName,
  basicConstraints: pkijs.id_BasicConstraints,
  extKeyUsage: pkijs.id_ExtKeyUsage,
  serverAuth: '1.3.6.1.5.5.7.3.1',
  extensionRequest: '1.2.840.113549.1.9.14',
} as const

const EC_P256 = { name: 'ECDSA', namedCurve: 'P-256' } as const
const DNS_NAME = 2
const IP_ADDRESS = 7
const DAY_MS = 24 * 60 * 60 * 1000
const SERIAL_BYTES = 16

// pkijs selects Node's global Web Crypto when it loads.
const engine = pkijs.getCrypto(true)

/** An extension given as its OID, criticality and DER-encoded value. */
export interface RawExtension {
  readonly oid: string
  readonly critical: boolean
  /** The DER encoding that the extension's OCTET STRING wraps. */
  readonly value: Uint8Array
}

/** What a certificate names and how long it lasts. */
export interface CertificateRequest {
  /** Subject common name; the first DNS name, else the first IP address, when absent. */
  readonly commonName?: string
  readonly dnsNames?: readonly string[]
  /** IPv4 or IPv6 literals for `iPAddress` subject alternative names. */
  readonly ipAddresses?: readonly string[]
  /** Start of validity; the current time minus one minute when absent. */
  readonly notBefore?: Date
  /** End of validity; `notBefore` plus 90 days when absent. */
  readonly notAfter?: Date
  /** Further extensions, appended after the subject alternative names. */
  readonly extensions?: readonly RawExtension[]
  /** The subject's public key as SubjectPublicKeyInfo DER; a new P-256 key is made when absent. */
  readonly publicKeyInfo?: Uint8Array
}

/** A certificate and, when this module made its key, the key. */
export interface IssuedCertificate {
  readonly der: Buffer
  readonly pem: string
  /** Lowercase hex SHA-256 of the DER certificate. */
  readonly sha256: string
  /** Lowercase hex serial number. */
  readonly serial: string
  readonly notBefore: Date
  readonly notAfter: Date
  /** PKCS #8 PEM of the subject key, present only when this module generated it. */
  readonly keyPem?: string
}

/** An in-memory certificate authority that signs with its own P-256 key. */
export interface TestAuthority {
  /** The authority's common name. */
  readonly name: string
  /** Its self-signed certificate, which a client trusts as `ca`. */
  readonly certificate: IssuedCertificate
  /**
   * Issue a server certificate signed by this authority, with extended key usage `serverAuth`.
   * @param request - the names, validity, extensions and optional subject key.
   * @returns the certificate, and its key when the request supplied none.
   */
  readonly issue: (request: CertificateRequest) => Promise<IssuedCertificate>
}

/** A PKCS #10 request read and verified by {@link readCertificationRequest}. */
export interface CertificationRequestContents {
  /** The request's DNS subject alternative names, in order. */
  readonly dnsNames: readonly string[]
  /** The subject's public key as SubjectPublicKeyInfo DER. */
  readonly publicKeyInfo: Uint8Array
}

/**
 * Wrap DER in PEM armour.
 * @param label - the PEM label, such as `CERTIFICATE`.
 * @param der - the encoded bytes.
 * @returns the PEM text with a trailing newline.
 */
export function pemEncode(label: string, der: Uint8Array): string {
  const lines = Buffer.from(der).toString('base64').match(/.{1,64}/g) ?? []
  return `-----BEGIN ${label}-----\n${lines.join('\n')}\n-----END ${label}-----\n`
}

/**
 * The DER bytes of the first PEM block in a text.
 * @param pem - PEM text.
 * @returns the decoded bytes.
 * @throws Error when the text holds no PEM block.
 */
export function pemDecode(pem: string): Buffer {
  const match = /-----BEGIN [^-]+-----([\s\S]*?)-----END [^-]+-----/.exec(pem)
  if (match === null) throw new Error('no PEM block')
  return Buffer.from((match[1] ?? '').replace(/\s+/g, ''), 'base64')
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}

function ipBytes(address: string): Uint8Array {
  if (isIP(address) === 4) return Uint8Array.from(address.split('.').map(Number))
  const [head = '', tail = ''] = address.split('::')
  const groups = (part: string): string[] => (part === '' ? [] : part.split(':'))
  const left = groups(head)
  const right = address.includes('::') ? groups(tail) : []
  const all = [...left, ...Array.from({ length: 8 - left.length - right.length }, () => '0'), ...right]
  return Uint8Array.from(all.flatMap(group => {
    const value = Number.parseInt(group, 16)
    return [value >> 8, value & 0xff]
  }))
}

function commonName(name: string): pkijs.RelativeDistinguishedNames {
  return new pkijs.RelativeDistinguishedNames({
    typesAndValues: [new pkijs.AttributeTypeAndValue({ type: OID.commonName, value: new asn1js.Utf8String({ value: name }) })],
  })
}

function subjectAltNames(request: CertificateRequest): pkijs.Extension | undefined {
  const names = [
    ...(request.dnsNames ?? []).map(value => new pkijs.GeneralName({ type: DNS_NAME, value })),
    ...(request.ipAddresses ?? []).map(value => new pkijs.GeneralName({ type: IP_ADDRESS, value: new asn1js.OctetString({ valueHex: toArrayBuffer(ipBytes(value)) }) })),
  ]
  if (names.length === 0) return undefined
  return new pkijs.Extension({ extnID: OID.subjectAltName, critical: false, extnValue: new pkijs.GeneralNames({ names }).toSchema().toBER(false) })
}

function rawExtension(extension: RawExtension): pkijs.Extension {
  return new pkijs.Extension({ extnID: extension.oid, critical: extension.critical, extnValue: toArrayBuffer(extension.value) })
}

async function newKeyPair(): Promise<CryptoKeyPair> {
  return webcrypto.subtle.generateKey(EC_P256, true, ['sign', 'verify']) as Promise<CryptoKeyPair>
}

async function keyPem(key: CryptoKey): Promise<string> {
  return pemEncode('PRIVATE KEY', new Uint8Array(await webcrypto.subtle.exportKey('pkcs8', key)))
}

interface Signer {
  readonly name: pkijs.RelativeDistinguishedNames
  readonly key: CryptoKey
}

async function build(request: CertificateRequest, extensions: readonly pkijs.Extension[], signer: Signer | 'self', subjectKeys?: CryptoKeyPair): Promise<IssuedCertificate> {
  const notBefore = request.notBefore ?? new Date(Date.now() - 60_000)
  const notAfter = request.notAfter ?? new Date(notBefore.getTime() + 90 * DAY_MS)
  const subjectName = request.commonName ?? request.dnsNames?.[0] ?? request.ipAddresses?.[0] ?? 'stand-in'
  const serial = randomBytes(SERIAL_BYTES)
  serial[0] = (serial[0] ?? 0) & 0x7f || 0x01
  const certificate = new pkijs.Certificate()
  certificate.version = 2
  certificate.serialNumber = new asn1js.Integer({ valueHex: toArrayBuffer(serial) })
  certificate.subject = commonName(subjectName)
  certificate.notBefore.value = notBefore
  certificate.notAfter.value = notAfter
  let generated: CryptoKeyPair | undefined
  if (subjectKeys !== undefined) {
    await certificate.subjectPublicKeyInfo.importKey(subjectKeys.publicKey, engine)
  } else if (request.publicKeyInfo === undefined) {
    generated = await newKeyPair()
    await certificate.subjectPublicKeyInfo.importKey(generated.publicKey, engine)
  } else {
    certificate.subjectPublicKeyInfo = pkijs.PublicKeyInfo.fromBER(toArrayBuffer(request.publicKeyInfo))
  }
  certificate.issuer = signer === 'self' ? certificate.subject : signer.name
  const san = subjectAltNames(request)
  certificate.extensions = [...extensions, ...(san === undefined ? [] : [san]), ...(request.extensions ?? []).map(rawExtension)]
  const signingKey = signer === 'self' ? (subjectKeys ?? generated)?.privateKey : signer.key
  if (signingKey === undefined) throw new Error('a self-signed certificate needs a generated key')
  await certificate.sign(signingKey, 'SHA-256', engine)
  const der = Buffer.from(certificate.toSchema(true).toBER(false))
  return {
    der,
    pem: pemEncode('CERTIFICATE', der),
    sha256: createHash('sha256').update(der).digest('hex'),
    serial: serial.toString('hex'),
    notBefore,
    notAfter,
    ...(generated === undefined ? {} : { keyPem: await keyPem(generated.privateKey) }),
  }
}

function basicConstraints(ca: boolean): pkijs.Extension {
  return new pkijs.Extension({ extnID: OID.basicConstraints, critical: true, extnValue: new pkijs.BasicConstraints({ cA: ca }).toSchema().toBER(false) })
}

function serverAuth(): pkijs.Extension {
  return new pkijs.Extension({ extnID: OID.extKeyUsage, critical: false, extnValue: new pkijs.ExtKeyUsage({ keyPurposes: [OID.serverAuth] }).toSchema().toBER(false) })
}

/**
 * Create a certificate authority whose self-signed certificate lasts ten years.
 * @param name - the authority's common name, such as `Delorun stand-in TLS`.
 * @returns the authority.
 */
export async function createTestAuthority(name: string): Promise<TestAuthority> {
  const keys = await newKeyPair()
  const subject = commonName(name)
  const notBefore = new Date(Date.now() - 60_000)
  const certificate = await build(
    { commonName: name, notBefore, notAfter: new Date(notBefore.getTime() + 3650 * DAY_MS) },
    [basicConstraints(true)],
    { name: subject, key: keys.privateKey },
    keys,
  )
  return {
    name,
    certificate,
    issue: async request => build(request, [basicConstraints(false), serverAuth()], { name: subject, key: keys.privateKey }),
  }
}

/**
 * Create a self-signed end-entity certificate with a new P-256 key, such as the certificate a
 * TLS-ALPN-01 responder presents.
 * @param request - the names, validity and extensions; `publicKeyInfo` is ignored.
 * @returns the certificate and its key.
 */
export async function createSelfSigned(request: CertificateRequest): Promise<IssuedCertificate & { readonly keyPem: string }> {
  const keys = await newKeyPair()
  const issued = await build(request, [basicConstraints(false)], 'self', keys)
  return { ...issued, keyPem: await keyPem(keys.privateKey) }
}

/**
 * Create a PKCS #10 request for DNS names with a new P-256 key, as an ACME client sends at finalization.
 * @param dnsNames - the names, the first of which is also the subject common name.
 * @returns the DER request and the PKCS #8 PEM of its key.
 */
export async function createCertificationRequest(dnsNames: readonly string[]): Promise<{ readonly der: Buffer, readonly keyPem: string }> {
  const keys = await newKeyPair()
  const request = new pkijs.CertificationRequest()
  request.subject = commonName(dnsNames[0] ?? 'stand-in')
  await request.subjectPublicKeyInfo.importKey(keys.publicKey, engine)
  const san = subjectAltNames({ dnsNames })
  request.attributes = san === undefined
    ? []
    : [new pkijs.Attribute({ type: OID.extensionRequest, values: [new pkijs.Extensions({ extensions: [san] }).toSchema()] })]
  await request.sign(keys.privateKey, 'SHA-256', engine)
  return { der: Buffer.from(request.toSchema(true).toBER(false)), keyPem: await keyPem(keys.privateKey) }
}

function dnsNamesOf(extensions: readonly pkijs.Extension[] | undefined): string[] {
  const san = extensions?.find(extension => extension.extnID === OID.subjectAltName)
  if (san === undefined) return []
  const names = pkijs.GeneralNames.fromBER(san.extnValue.valueBlock.valueHexView.slice().buffer)
  return names.names.filter(name => name.type === DNS_NAME).map(name => String(name.value))
}

/**
 * Parse a PKCS #10 request and verify its self-signature.
 * @param der - the DER request.
 * @returns its DNS names and public key.
 * @throws Error when the request does not parse or its signature does not verify.
 */
export async function readCertificationRequest(der: Uint8Array): Promise<CertificationRequestContents> {
  const request = pkijs.CertificationRequest.fromBER(toArrayBuffer(der))
  if (!(await request.verify(engine))) throw new Error('the request signature does not verify')
  const extensionRequest = request.attributes?.find(attribute => attribute.type === OID.extensionRequest)
  const extensions = extensionRequest?.values[0] === undefined ? undefined : new pkijs.Extensions({ schema: extensionRequest.values[0] }).extensions
  return { dnsNames: dnsNamesOf(extensions), publicKeyInfo: new Uint8Array(request.subjectPublicKeyInfo.toSchema().toBER(false)) }
}

/**
 * The DNS subject alternative names of a certificate.
 * @param der - the DER certificate.
 * @returns the names, in order.
 */
export function certificateDnsNames(der: Uint8Array): string[] {
  return dnsNamesOf(pkijs.Certificate.fromBER(toArrayBuffer(der)).extensions)
}

/**
 * Lowercase hex SHA-256 hashes of a certificate's TBSCertificate and SubjectPublicKeyInfo, as
 * Certificate Transparency monitors report them.
 * @param der - the DER certificate.
 * @returns both hashes.
 */
export function certificateHashes(der: Uint8Array): { readonly tbsSha256: string, readonly pubkeySha256: string } {
  const certificate = pkijs.Certificate.fromBER(toArrayBuffer(der))
  const hash = (bytes: ArrayBuffer | Uint8Array): string => createHash('sha256').update(new Uint8Array(bytes)).digest('hex')
  return { tbsSha256: hash(certificate.tbsView), pubkeySha256: hash(certificate.subjectPublicKeyInfo.toSchema().toBER(false)) }
}

/**
 * One extension of a certificate.
 * @param der - the DER certificate.
 * @param oid - the extension's OID.
 * @returns its criticality and the DER its OCTET STRING wraps, or undefined when absent.
 */
export function certificateExtension(der: Uint8Array, oid: string): RawExtension | undefined {
  const extension = pkijs.Certificate.fromBER(toArrayBuffer(der)).extensions?.find(candidate => candidate.extnID === oid)
  if (extension === undefined) return undefined
  return { oid, critical: extension.critical, value: extension.extnValue.valueBlock.valueHexView.slice() }
}

/**
 * The `acmeIdentifier` extension a TLS-ALPN-01 responder presents: critical, holding the
 * SHA-256 digest of the key authorization as an OCTET STRING (RFC 8737 §3).
 * @param keyAuthorization - `<token>.<account key thumbprint>`.
 * @returns the extension.
 */
export function acmeIdentifierExtension(keyAuthorization: string): RawExtension {
  const digest = createHash('sha256').update(keyAuthorization).digest()
  return { oid: ACME_IDENTIFIER_OID, critical: true, value: new Uint8Array(new asn1js.OctetString({ valueHex: toArrayBuffer(digest) }).toBER(false)) }
}
