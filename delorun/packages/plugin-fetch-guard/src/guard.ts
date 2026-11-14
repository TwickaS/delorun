/**
 * The fetch guard's refusal logic, kept free of Cordis so the classifier and
 * the typed refusal are testable without a mounted plugin. The provider seam
 * (`HttpFetchProvider`) resolves a hop's hostname before it calls the guard, so
 * the classifier always sees the addresses the connection would actually use —
 * never just the name.
 *
 * The refusal matrix is Delorun's contract: loopback, link-local, RFC1918 private,
 * unique-local, shared (carrier-grade NAT), multicast and reserved destinations,
 * and the unspecified address, are refused; every other address is allowed. An
 * IPv6 destination that reaches an IPv4 address — mapped, compatible, NAT64,
 * 6to4 or Teredo — is classified as that IPv4 address, so the translator or
 * tunnel is no way around the matrix. An address the classifier cannot parse is refused too — a guard that
 * cannot tell where a connection would go must not wave it through.
 *
 * @module @delorun/plugin-fetch-guard/guard
 */

/** Why the guard refused a destination. */
export type FetchGuardRefusalCode =
  /** A loopback address: `127.0.0.0/8` or `::1`. */
  | 'loopback'
  /** A link-local address: `169.254.0.0/16` or `fe80::/10`. */
  | 'link-local'
  /** An RFC1918 private address, `10/8`, `172.16/12` or `192.168/16`, or a deprecated IPv6 site-local address, `fec0::/10`. */
  | 'private'
  /** An IPv6 unique-local address: `fc00::/7`. */
  | 'unique-local'
  /** A shared (carrier-grade NAT) address: `100.64.0.0/10`, which carries a tailnet and its API. */
  | 'shared'
  /** A multicast address: `224.0.0.0/4` or `ff00::/8`. */
  | 'multicast'
  /**
   * A reserved address: `240.0.0.0/4`, which holds the broadcast address `255.255.255.255`, or an IPv6
   * IPv4-translated address, `::ffff:0:0:0/96`.
   */
  | 'reserved'
  /** The unspecified address, `0.0.0.0` or `::`, which names no destination at all. */
  | 'unspecified'
  /** An address the classifier could not parse, refused rather than allowed. */
  | 'unclassifiable'

/**
 * The typed refusal the model reads verbatim. It names the destination host and
 * the reason, and no resolved address beyond them, so a refusal can be quoted
 * into a tool result without leaking anything but what was asked for.
 */
export class FetchGuardRefusedError extends Error {
  /** Why the destination is refused. */
  readonly code: FetchGuardRefusalCode
  /** The refused hop's host, as the request spells it. */
  readonly host: string

  /**
   * @param code - why the destination is refused.
   * @param host - the refused hop's host, as the request spells it.
   * @param reason - the refusal, in words the model reads.
   */
  constructor(code: FetchGuardRefusalCode, host: string, reason: string) {
    super(reason)
    this.code = code
    this.host = host
    this.name = 'FetchGuardRefusedError'
  }
}

/** The reason phrase of each refusal code, as the message reads. */
const REASONS: Record<FetchGuardRefusalCode, string> = {
  loopback: 'a loopback address',
  'link-local': 'a link-local address',
  private: 'a private-network address',
  'unique-local': 'an IPv6 unique-local address',
  shared: 'a shared (carrier-grade NAT) address',
  multicast: 'a multicast address',
  reserved: 'a reserved address',
  unspecified: 'the unspecified address (0.0.0.0 or ::)',
  unclassifiable: 'an address the fetch guard could not classify',
}

/**
 * The refusal message for one refused host. It names the host and the reason
 * and nothing else: no resolved address, no interface, no other candidate.
 * @param code - why the host is refused.
 * @param host - the refused hop's host, as the request spells it.
 * @returns the message the model reads.
 */
export function refusalMessage(code: FetchGuardRefusalCode, host: string): string {
  return `web fetch refused: the host ${JSON.stringify(host)} is ${REASONS[code]}, which web_fetch does not fetch`
}

/**
 * Parse one dotted-quad IPv4 address into its four octets.
 * @param address - the candidate literal.
 * @returns the octets, or undefined when the spelling is not a strict dotted quad.
 */
function parseIpv4(address: string): readonly [number, number, number, number] | undefined {
  const groups = address.split('.')
  if (groups.length !== 4) return undefined
  const octets: number[] = []
  for (const group of groups) {
    // A leading zero is not a valid dotted-quad octet spelling: what `http://127.0.0.01/`
    // means is a parser's guess, and a guard never guesses.
    if (!/^\d{1,3}$/u.test(group) || (group.length > 1 && group.startsWith('0'))) return undefined
    const value = Number(group)
    if (!Number.isInteger(value) || value > 255) return undefined
    octets.push(value)
  }
  return [octets[0] ?? 0, octets[1] ?? 0, octets[2] ?? 0, octets[3] ?? 0] as const
}

/**
 * The refusal of one IPv4 address under the matrix: the unspecified address,
 * the loopback range, the RFC1918 private ranges, the link-local range, the
 * shared (carrier-grade NAT) range, the multicast range and the reserved range
 * — which holds the broadcast address `255.255.255.255` — are refused; every
 * other address is allowed.
 * @param octets - the four octets.
 * @returns the refusal code, or undefined when the address is allowed.
 */
function ipv4Refusal(octets: readonly number[]): FetchGuardRefusalCode | undefined {
  const [first = 0, second = 0] = octets
  if (first === 0 && second === 0 && octets[2] === 0 && octets[3] === 0) return 'unspecified'
  if (first === 127) return 'loopback'
  if (first === 10) return 'private'
  if (first === 172 && (second & 0xf0) === 16) return 'private'
  if (first === 192 && second === 168) return 'private'
  if (first === 169 && second === 254) return 'link-local'
  // 100.64.0.0/10 is shared address space: a carrier-grade NAT range, and the
  // range a Tailscale tailnet and its API address (100.100.100.100) live in.
  if (first === 100 && (second & 0xc0) === 64) return 'shared'
  // 224.0.0.0/4 is multicast; 240.0.0.0/4 is reserved and holds the broadcast
  // address. Neither names a host a fetch could want.
  if ((first & 0xf0) === 0xe0) return 'multicast'
  if ((first & 0xf0) === 0xf0) return 'reserved'
  return undefined
}

/**
 * Parse one IPv6 literal into its 16 bytes. Handles the `::` compression once,
 * hex groups, an embedded dotted-quad tail, and a trailing zone index, which
 * names an interface and is dropped: the zone never changes which network the
 * address is on.
 * @param address - the candidate literal, without its zone index.
 * @returns the 16 bytes, or undefined when the spelling is not valid IPv6.
 */
function parseIpv6(address: string): Uint8Array | undefined {
  const bytes = new Uint8Array(16)
  let head = address
  let tail = ''
  const split = address.indexOf('::')
  if (split >= 0) {
    // One `::` only: a second one makes the address ambiguous, so it is refused.
    if (address.indexOf('::', split + 1) >= 0) return undefined
    head = address.slice(0, split)
    tail = address.slice(split + 2)
  }
  const headGroups = head === '' ? [] : head.split(':')
  const tailGroups = tail === '' ? [] : tail.split(':')
  const groups: string[] = [...headGroups, ...tailGroups]
  // An embedded dotted-quad tail (`::ffff:192.168.0.1`) counts as one group.
  if (groups.some(group => group.includes('.'))) {
    const last = groups.at(-1)
    if (groups.length !== 1 && groups.slice(0, -1).some(group => group.includes('.'))) return undefined
    const octets = last === undefined ? undefined : parseIpv4(last)
    if (octets === undefined) return undefined
    groups.splice(-1, 1, `${((octets[0] ?? 0) * 256 + (octets[1] ?? 0)).toString(16)}`, `${((octets[2] ?? 0) * 256 + (octets[3] ?? 0)).toString(16)}`)
  }
  if (groups.length > 8) return undefined
  if (split < 0 && groups.length !== 8) return undefined
  let write = 0
  for (const [index, group] of groups.entries()) {
    if (!/^[0-9a-f]{1,4}$/u.test(group)) return undefined
    if (index === headGroups.length && split >= 0) write = 16 - 2 * (groups.length - index)
    const value = Number.parseInt(group, 16)
    bytes[write] = value >> 8
    bytes[write + 1] = value & 0xff
    write += 2
  }
  return bytes
}

/**
 * The refusal of one IPv6 address under the matrix: the unspecified address
 * (`::`, including `::0.0.0.0`), `::1`, `fc00::/7`, `fe80::/10`, the deprecated
 * site-local `fec0::/10`, the IPv4-translated `::ffff:0:0:0/96` and `ff00::/8`
 * are refused. A destination that reaches an IPv4 address is classified as that
 * IPv4 address, in hex or dotted quad alike: IPv4-mapped (`::ffff:a.b.c.d`),
 * IPv4-compatible (`::a.b.c.d`), well-known NAT64 (`64:ff9b::/96`) and
 * local-use NAT64 (`64:ff9b:1::/48`) by their low 32 bits, 6to4 (`2002::/16`) by
 * the 32 bits after the prefix, and Teredo (`2001::/32`) by its client address,
 * the inverted low 32 bits. The `::1` check runs first, because `::1` and
 * `::0.0.0.1` are one address and `0.0.0.1` alone would be allowed. Every other
 * address is allowed.
 * @param bytes - the 16 bytes of the address.
 * @returns the refusal code, or undefined when the address is allowed.
 */
function ipv6Refusal(bytes: Uint8Array): FetchGuardRefusalCode | undefined {
  const byte = (at: number): number => bytes[at] ?? 0
  const zero = (from: number, to: number): boolean => bytes.slice(from, to).every(value => value === 0)
  const embedded = (at: number, invert = false): FetchGuardRefusalCode | undefined =>
    ipv4Refusal([0, 1, 2, 3].map(offset => (invert ? ~byte(at + offset) : byte(at + offset)) & 0xff))
  // `::` names no destination, and `::0.0.0.0` spells the same address. The
  // check runs before the IPv4-compatible branch, whose `!zero(12, 16)` test
  // would otherwise let an all-zero low half fall through.
  if (zero(0, 16)) return 'unspecified'
  if (zero(0, 15) && byte(15) === 1) return 'loopback'
  if (zero(0, 10) && byte(10) === 0xff && byte(11) === 0xff) return embedded(12)
  // `::ffff:0:a.b.c.d` is the IPv4-translated form of stateless translation
  // (RFC 2765), which names no host a fetch could reach directly.
  if (zero(0, 8) && byte(8) === 0xff && byte(9) === 0xff && zero(10, 12)) return 'reserved'
  // `64:ff9b::/96` is the well-known NAT64 prefix and `64:ff9b:1::/48` the
  // local-use one (RFC 8215), deployed as a /96 whose low 32 bits are the IPv4
  // address: a v6-only network reaches that address through the translator.
  // Classifying it keeps the translator from being a way around the matrix,
  // while a NAT64 destination to a public address stays reachable, which is
  // how such a network reaches the IPv4 web at all.
  const nat64 = byte(0) === 0x00 && byte(1) === 0x64 && byte(2) === 0xff && byte(3) === 0x9b
  if (nat64 && zero(4, 12)) return embedded(12)
  if (nat64 && byte(4) === 0x00 && byte(5) === 0x01) return embedded(12)
  // 6to4 (`2002::/16`) tunnels to the IPv4 address in the 32 bits after the prefix.
  if (byte(0) === 0x20 && byte(1) === 0x02) return embedded(2)
  // Teredo (`2001::/32`) delivers to the client address, stored inverted in the low 32 bits.
  if (byte(0) === 0x20 && byte(1) === 0x01 && zero(2, 4)) return embedded(12, true)
  if (zero(0, 12) && !zero(12, 16)) return embedded(12)
  if ((byte(0) & 0xfe) === 0xfc) return 'unique-local'
  if (byte(0) === 0xfe && (byte(1) & 0xc0) === 0x80) return 'link-local'
  if (byte(0) === 0xfe && (byte(1) & 0xc0) === 0xc0) return 'private'
  if (byte(0) === 0xff) return 'multicast'
  return undefined
}

/**
 * The refusal of one address literal under the matrix. Zone indexes are
 * dropped; an address that survives neither the IPv4 nor the IPv6 grammar is
 * refused as `unclassifiable` — a guard never waves an address through that it
 * cannot place.
 * @param address - the address literal, as `node:dns` or the URL spelled it.
 * @returns the refusal code, or undefined when the address is allowed.
 */
export function classifyAddress(address: string): FetchGuardRefusalCode | undefined {
  const bare = address.includes('%') && !address.includes('.') ? address.slice(0, address.indexOf('%')) : address
  const octets = parseIpv4(bare)
  if (octets !== undefined) return ipv4Refusal(octets)
  const bytes = parseIpv6(bare)
  if (bytes === undefined) return 'unclassifiable'
  return ipv6Refusal(bytes)
}

/**
 * The refusal of a hop's resolved addresses: the first refused address decides,
 * and an empty list is refused, because the provider only classifies after a
 * resolution that Node answers with at least one address.
 * @param addresses - the hop's resolved address literals.
 * @returns the refusal code, or undefined when every address is allowed.
 */
export function refusalOf(addresses: readonly string[]): FetchGuardRefusalCode | undefined {
  if (addresses.length === 0) return 'unclassifiable'
  for (const address of addresses) {
    const refusal = classifyAddress(address)
    if (refusal !== undefined) return refusal
  }
  return undefined
}
