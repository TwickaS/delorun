/**
 * A Certificate Transparency search stand-in on loopback HTTPS that answers Cert Spotter's
 * `GET /v1/issuances` as the default source of contract C6 does: `domain`, `include_subdomains`,
 * `match_wildcards`, `after` and repeated `expand`, issuances in discovery order with `id`,
 * `tbs_sha256`, `cert_sha256`, `pubkey_sha256`, `not_before`, `not_after` and `revoked`, and
 * `dns_names`, `cert_der` and `revocation` when expanded. Errors use Cert Spotter's
 * `{ code, message }` body.
 *
 * Certificates enter the log through {@link CtStandIn.log}: the stack logs every certificate the
 * ACME stand-in issues, and a spec logs fixtures such as a `*.example.com` or a multi-name
 * certificate. A logged certificate can wait for inclusion, which models a log's delay, and can
 * be marked revoked.
 *
 * @module @delorun/tools/stack/certificate-transparency
 */
import { X509Certificate } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { DEFAULT_CT_SOURCE } from '@delorun/contract-relay-protocol'
import { certificateDnsNames, certificateHashes, type IssuedCertificate, type TestAuthority } from './certificates.ts'
import { listenHttps, sendJson, type LoopbackServer } from './loopback.ts'

/** The search path, taken from the contract's default source. */
export const CT_SEARCH_PATH = new URL(DEFAULT_CT_SOURCE.replace('<domain>', 'example.com')).pathname

/** Most issuances one response returns; a client pages with `after`. */
export const CT_PAGE_SIZE = 100

/** One issuance as the search answers it, with every optional field. */
export interface CtIssuance {
  readonly id: string
  readonly tbs_sha256: string
  readonly cert_sha256: string
  readonly pubkey_sha256: string
  readonly not_before: string
  readonly not_after: string
  readonly revoked: boolean
  readonly dns_names: readonly string[]
  readonly cert_der: string
  readonly revocation: { readonly time: string, readonly reason: number, readonly checked_at: string } | null
}

/** How to log a certificate. */
export interface CtLogOptions {
  /** Whether searches see it at once; false holds it until {@link CtStandIn.include}. True when absent. */
  readonly included?: boolean
}

/** One search the stand-in answered. */
export interface CtSearch {
  /** The query string as received. */
  readonly query: string
  readonly status: number
}

/** A running Certificate Transparency stand-in. */
export interface CtStandIn {
  /** The search URL in the form of the contract's `certificates.ctSource` row, with `<domain>` left in place. */
  readonly sourceUrl: string
  /** The PEM certificate of the authority a client trusts for this stand-in. */
  readonly ca: string
  /**
   * Log a certificate.
   * @param certificate - the certificate, or its DER bytes.
   * @param options - whether searches see it at once.
   * @returns the issuance as searches report it.
   */
  readonly log: (certificate: IssuedCertificate | Uint8Array, options?: CtLogOptions) => CtIssuance
  /**
   * Make a logged certificate visible to searches.
   * @param sha256 - its `cert_sha256`.
   */
  readonly include: (sha256: string) => void
  /**
   * Mark a logged certificate revoked.
   * @param sha256 - its `cert_sha256`.
   * @param reason - the CRL reason code; 0 (unspecified) when absent.
   */
  readonly revoke: (sha256: string, reason?: number) => void
  /**
   * Answer the next search with a Cert Spotter error.
   * @param status - the HTTP status, such as 429 or 500.
   * @param code - the error code, such as `rate_limited`.
   */
  readonly nextError: (status: number, code: string) => void
  /** Every search answered, in order. */
  readonly searches: readonly CtSearch[]
  /** Stop listening. */
  readonly close: () => Promise<void>
}

interface Entry {
  issuance: CtIssuance
  included: boolean
}

const EXPANDABLE = new Set(['dns_names', 'cert_der', 'revocation'])

function covers(dnsName: string, domain: string, includeSubdomains: boolean, matchWildcards: boolean): boolean {
  const name = dnsName.toLowerCase()
  if (name === domain) return true
  if (includeSubdomains && name.endsWith(`.${domain}`)) return true
  if (!name.startsWith('*.')) return false
  const base = name.slice(2)
  // `*.example.com` covers `www.example.com`, the wildcard match; with subdomains, also anything under the domain.
  if (matchWildcards && domain.endsWith(`.${base}`) && domain.split('.').length === base.split('.').length + 1) return true
  return includeSubdomains && (base === domain || base.endsWith(`.${domain}`))
}

function present(issuance: CtIssuance, expand: ReadonlySet<string>): Record<string, unknown> {
  const { dns_names: dnsNames, cert_der: certDer, revocation, ...base } = issuance
  return {
    ...base,
    ...(expand.has('dns_names') ? { dns_names: dnsNames } : {}),
    ...(expand.has('cert_der') ? { cert_der: certDer } : {}),
    ...(expand.has('revocation') ? { revocation } : {}),
  }
}

/**
 * Start a Certificate Transparency search stand-in on `127.0.0.1`.
 * @param authority - the stack's test authority, which signs the server certificate.
 * @returns the running stand-in.
 */
export async function startCtStandIn(authority: TestAuthority): Promise<CtStandIn> {
  const entries: Entry[] = []
  const searches: CtSearch[] = []
  const errors: { readonly status: number, readonly code: string }[] = []
  let nextId = 1

  const find = (sha256: string): Entry => {
    const entry = entries.find(candidate => candidate.issuance.cert_sha256 === sha256)
    if (entry === undefined) throw new Error(`no logged certificate ${sha256}`)
    return entry
  }
  const fail = (response: ServerResponse, query: string, status: number, code: string, message: string, field?: string): void => {
    searches.push({ query, status })
    sendJson(response, status, { code, message, ...(field === undefined ? {} : { field }) })
  }

  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const url = new URL(request.url ?? '/', 'https://stand-in')
    const query = url.search.replace(/^\?/, '')
    if (url.pathname !== CT_SEARCH_PATH) {
      fail(response, query, 404, 'not_found', 'no such endpoint')
      return
    }
    if (request.method !== 'GET') {
      fail(response, query, 405, 'method_not_allowed', 'use GET')
      return
    }
    const injected = errors.shift()
    if (injected !== undefined) {
      fail(response, query, injected.status, injected.code, 'injected by the stand-in')
      return
    }
    const domain = (url.searchParams.get('domain') ?? '').toLowerCase().replace(/\.$/, '')
    if (domain === '') {
      fail(response, query, 400, 'missing_field', 'domain is required', 'domain')
      return
    }
    const flag = (name: string): boolean | undefined => {
      const value = url.searchParams.get(name)
      return value === null ? false : value === 'true' ? true : value === 'false' ? false : undefined
    }
    const includeSubdomains = flag('include_subdomains')
    const matchWildcards = flag('match_wildcards')
    if (includeSubdomains === undefined || matchWildcards === undefined) {
      fail(response, query, 400, 'invalid_value', 'include_subdomains and match_wildcards take true or false')
      return
    }
    const expand = new Set(url.searchParams.getAll('expand'))
    const unknown = [...expand].find(field => !EXPANDABLE.has(field))
    if (unknown !== undefined) {
      fail(response, query, 400, 'invalid_value', `the stand-in cannot expand ${unknown}`, 'expand')
      return
    }
    const after = Number(url.searchParams.get('after') ?? '0')
    const found = entries
      .filter(entry => entry.included && Number(entry.issuance.id) > after)
      .filter(entry => entry.issuance.dns_names.some(name => covers(name, domain, includeSubdomains, matchWildcards)))
      .slice(0, CT_PAGE_SIZE)
      .map(entry => present(entry.issuance, expand))
    searches.push({ query, status: 200 })
    sendJson(response, 200, found)
  }

  const server: LoopbackServer = await listenHttps(authority, [], handle)

  return {
    sourceUrl: DEFAULT_CT_SOURCE.replace(/^https:\/\/[^/]+/, server.origin),
    ca: authority.certificate.pem,
    log: (certificate, logOptions = {}) => {
      const der = certificate instanceof Uint8Array ? Buffer.from(certificate) : certificate.der
      const parsed = new X509Certificate(der)
      const hashes = certificateHashes(der)
      const issuance: CtIssuance = {
        id: String(nextId),
        tbs_sha256: hashes.tbsSha256,
        cert_sha256: parsed.fingerprint256.replaceAll(':', '').toLowerCase(),
        pubkey_sha256: hashes.pubkeySha256,
        not_before: new Date(parsed.validFrom).toISOString(),
        not_after: new Date(parsed.validTo).toISOString(),
        revoked: false,
        dns_names: certificateDnsNames(der),
        cert_der: der.toString('base64'),
        revocation: null,
      }
      nextId += 1
      entries.push({ issuance, included: logOptions.included ?? true })
      return issuance
    },
    include: sha256 => { find(sha256).included = true },
    revoke: (sha256, reason = 0) => {
      const entry = find(sha256)
      const now = new Date().toISOString()
      entry.issuance = { ...entry.issuance, revoked: true, revocation: { time: now, reason, checked_at: now } }
    },
    nextError: (status, code) => { errors.push({ status, code }) },
    searches,
    close: async () => server.close(),
  }
}
