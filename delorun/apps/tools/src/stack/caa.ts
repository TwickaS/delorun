/**
 * The CAA decision a certificate authority makes before issuing (RFC 8659), with the RFC 8657
 * `accounturi` and `validationmethods` parameters, over records the caller supplies in place of
 * DNS. The ACME stand-in applies it at finalization, as Let's Encrypt applies its own lookup.
 *
 * @module @delorun/tools/stack/caa
 */

/** One CAA resource record. */
export interface CaaRecord {
  /** The flags octet; 128 marks the property critical. */
  readonly flags: number
  /** The property tag, such as `issue`, `issuewild` or `iodef`. */
  readonly tag: string
  /** The property value, such as `letsencrypt.org; accounturi=https://…; validationmethods=tls-alpn-01`. */
  readonly value: string
}

/** CAA records by owner name, standing in for DNS. */
export type CaaZone = Readonly<Record<string, readonly CaaRecord[]>>

/** What a CA asks the CAA records about one name. */
export interface CaaQuestion {
  /** The DNS identifier, possibly `*.`-prefixed. */
  readonly name: string
  /** The CA's issuer domain name, such as `letsencrypt.org`. */
  readonly issuerDomain: string
  /** The requesting ACME account URL. */
  readonly accountUri: string
  /** The validation method that proved control, such as `tls-alpn-01`. */
  readonly validationMethod: string
}

/** The decision, and the owner name of the relevant record set when there is one. */
export interface CaaDecision {
  readonly permitted: boolean
  readonly relevantName?: string
  readonly reason: string
}

const KNOWN_TAGS = new Set(['issue', 'issuewild', 'iodef', 'issuemail', 'issuevmc'])
const CRITICAL = 128

function parseValue(value: string): { readonly issuer: string, readonly parameters: ReadonlyMap<string, string> } {
  const [issuer = '', ...rest] = value.split(';')
  const parameters = new Map<string, string>()
  for (const part of rest) {
    const separator = part.indexOf('=')
    if (separator > 0) parameters.set(part.slice(0, separator).trim().toLowerCase(), part.slice(separator + 1).trim())
  }
  return { issuer: issuer.trim().toLowerCase(), parameters }
}

/**
 * Decide whether the CA may issue for a name: find the relevant record set by climbing from the
 * name towards the root, then require an `issue` (or, for a wildcard, `issuewild`) property that
 * names the CA and whose `accounturi` and `validationmethods`, when present, admit the request.
 * @param zone - the records by owner name.
 * @param question - the name, the CA's issuer domain, the account and the validation method.
 * @returns whether issuance is permitted, and why.
 */
export function decideCaa(zone: CaaZone, question: CaaQuestion): CaaDecision {
  const wildcard = question.name.startsWith('*.')
  const labels = (wildcard ? question.name.slice(2) : question.name).toLowerCase().replace(/\.$/, '').split('.')
  for (let index = 0; index < labels.length; index += 1) {
    const owner = labels.slice(index).join('.')
    const records = zone[owner] ?? []
    if (records.length === 0) continue
    const unknownCritical = records.find(record => (record.flags & CRITICAL) !== 0 && !KNOWN_TAGS.has(record.tag.toLowerCase()))
    if (unknownCritical !== undefined) return { permitted: false, relevantName: owner, reason: `unknown critical property ${unknownCritical.tag}` }
    const issueWild = records.filter(record => record.tag.toLowerCase() === 'issuewild')
    const properties = wildcard && issueWild.length > 0 ? issueWild : records.filter(record => record.tag.toLowerCase() === 'issue')
    if (properties.length === 0) return { permitted: true, relevantName: owner, reason: 'the relevant set restricts no issuer' }
    for (const property of properties) {
      const { issuer, parameters } = parseValue(property.value)
      if (issuer !== question.issuerDomain.toLowerCase()) continue
      const accountUri = parameters.get('accounturi')
      if (accountUri !== undefined && accountUri !== question.accountUri) continue
      const methods = parameters.get('validationmethods')
      if (methods !== undefined && !methods.split(',').map(method => method.trim()).includes(question.validationMethod)) continue
      return { permitted: true, relevantName: owner, reason: `permitted by ${owner}` }
    }
    return { permitted: false, relevantName: owner, reason: `no property at ${owner} admits ${question.issuerDomain} for this account and method` }
  }
  return { permitted: true, reason: 'no CAA record set' }
}
