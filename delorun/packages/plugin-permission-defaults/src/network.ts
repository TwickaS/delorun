/**
 * A workspace's network setting for sandboxed commands, and the host names its allowlist holds. The setting is one of
 * three accesses: `open`, the host's network as stock gives it; `allowlist`, the named hosts only, through Delorun's
 * egress proxy; and `off`, no network at all. The module is free of Cordis, so the setting's validation, its order
 * and the host matching are testable without a mounted plugin.
 *
 * @module @delorun/plugin-permission-defaults/network
 */
import { isIP } from 'node:net'
import { classifyAddress } from '@delorun/plugin-fetch-guard/guard'

/** The three network accesses, most restrictive first. */
export const NETWORK_ACCESSES = ['off', 'allowlist', 'open'] as const

/** One of {@link NETWORK_ACCESSES}. */
export type NetworkAccess = (typeof NETWORK_ACCESSES)[number]

/** The most entries an allowlist holds. */
export const MAX_ALLOWED_HOSTS = 200

/** A workspace's network setting: its access, and the hosts `allowlist` admits, which the other accesses keep for later. */
export interface WorkspaceNetwork {
  readonly access: NetworkAccess
  /** Normalized host entries ({@link normalizeHostEntry}), sorted and without duplicates. */
  readonly hosts: readonly string[]
}

/** The network a workspace without a setting of its own gets, and every workspace gets in the parity composition. */
export const OPEN_NETWORK: WorkspaceNetwork = { access: 'open', hosts: [] }

/**
 * Whether a value names one of {@link NETWORK_ACCESSES}.
 * @param value - the value.
 * @returns true for `off`, `allowlist` and `open`.
 */
export function isNetworkAccess(value: unknown): value is NetworkAccess {
  return typeof value === 'string' && (NETWORK_ACCESSES as readonly string[]).includes(value)
}

/** One DNS label as an allowlist accepts it: letters, digits and inner hyphens, at most 63 characters. */
const LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/u

/** The ports an entry that names no port admits: HTTP's and HTTPS's. */
export const DEFAULT_PORTS: readonly number[] = [80, 443]

/** One allowlist entry split into its host and the port it names, if any. */
export interface HostEntryParts {
  /** The host: a name, a `*.` name or an IP address without brackets. */
  readonly host: string
  /** The one port the entry admits, or `undefined` for {@link DEFAULT_PORTS}. */
  readonly port: number | undefined
}

/**
 * Split an entry into its host and port: `[v6]:port` and `name:port` name a port; an IPv6 address without brackets,
 * like any entry without a colon, names none.
 * @param entry - the entry, as {@link normalizeHostEntry} returns it.
 * @returns the parts, or `undefined` when the entry names a port that is not a decimal number from 1 to 65535.
 */
export function hostEntryParts(entry: string): HostEntryParts | undefined {
  const bracketed = /^\[([^\]]*)\](?::(.*))?$/u.exec(entry)
  const [host, portText] = bracketed !== null
    ? [bracketed[1] ?? '', bracketed[2]]
    : isIP(entry) === 6 || !entry.includes(':') ? [entry, undefined] : [entry.slice(0, entry.lastIndexOf(':')), entry.slice(entry.lastIndexOf(':') + 1)]
  if (portText === undefined) return { host, port: undefined }
  if (!/^[1-9]\d{0,4}$/u.test(portText) || Number(portText) > 65_535) return undefined
  return { host, port: Number(portText) }
}

/**
 * Why an allowlist entry is refused, or nothing for an entry it accepts. An entry is a host name of at least two
 * labels, such as `registry.npmjs.org`; a name whose first label is `*`, such as `*.npmjs.org`, which matches every
 * name below that domain and not the domain itself, with at least two labels after the `*`; or a public IP address.
 * An entry admits ports 80 and 443; one that ends in `:port`, such as `github.com:22` or `[2001:db8::1]:8443`, admits
 * that port instead. Names are ASCII, so an internationalized name is written in its `xn--` form, and an entry names no
 * scheme or path. An address the fetch guard refuses, such as a private-network or loopback address, is refused here
 * too, because the proxy never connects to one.
 * @param entry - the entry, as {@link normalizeHostEntry} returns it.
 * @returns the reason, or `undefined` when the entry is accepted.
 */
export function hostEntryProblem(entry: string): string | undefined {
  if (entry === '') return 'an entry is empty'
  const notHost = `${JSON.stringify(entry)} is not a host name: write a name such as registry.npmjs.org or *.npmjs.org, with no scheme or path, and a port only after a colon`
  if (/[/?#@\\\s]/u.test(entry)) return notHost
  const parts = hostEntryParts(entry)
  if (parts === undefined) return `${JSON.stringify(entry)} names a port that is not a number from 1 to 65535`
  const { host } = parts
  if (isIP(host) !== 0) {
    const refusal = classifyAddress(host)
    return refusal === undefined ? undefined : `${JSON.stringify(entry)} is a ${refusal} address, which the proxy never connects to`
  }
  if (host.length > 253) return `${JSON.stringify(entry.slice(0, 40))}… is longer than a host name can be`
  const wildcard = host.startsWith('*.')
  const labels = (wildcard ? host.slice(2) : host).split('.')
  if (!labels.every(label => LABEL.test(label))) return notHost
  if (labels.length < 2) {
    return wildcard
      ? `${JSON.stringify(entry)} would match every name under a top-level domain; name the domain, such as *.npmjs.org`
      : `${JSON.stringify(entry)} is a single-label name; name a full host, such as registry.npmjs.org`
  }
  return undefined
}

/**
 * The form a host is compared in: trimmed, lower case, without its brackets when it is an IPv6 address, and without
 * one trailing dot.
 * @param host - the host as a request or an entry names it, without a port.
 * @returns the normalized host.
 */
export function normalizeHost(host: string): string {
  const lower = host.trim().toLowerCase()
  const bare = lower.startsWith('[') && lower.endsWith(']') ? lower.slice(1, -1) : lower
  return bare.endsWith('.') ? bare.slice(0, -1) : bare
}

/**
 * The form an allowlist entry is compared and stored in: its host in {@link normalizeHost} form, followed by `:port`
 * when it names one, an IPv6 address with a port in brackets.
 * @param entry - the entry as the person or a configuration wrote it.
 * @returns the normalized entry; an entry whose port does not read is returned trimmed and in lower case, for
 *   {@link hostEntryProblem} to refuse.
 */
export function normalizeHostEntry(entry: string): string {
  const lower = entry.trim().toLowerCase()
  const parts = hostEntryParts(lower)
  if (parts === undefined) return lower
  const host = normalizeHost(parts.host)
  if (parts.port === undefined) return host
  return `${isIP(host) === 6 ? `[${host}]` : host}:${String(parts.port)}`
}

/**
 * Normalize and check a whole allowlist.
 * @param entries - the entries as written.
 * @returns the normalized entries, sorted and without duplicates, or the first problem.
 */
export function parseHostList(entries: readonly string[]): { readonly hosts: readonly string[] } | { readonly problem: string } {
  const hosts = [...new Set(entries.map(normalizeHostEntry))].sort()
  if (hosts.length > MAX_ALLOWED_HOSTS) return { problem: `an allowlist holds at most ${MAX_ALLOWED_HOSTS} hosts, and this one holds ${hosts.length}` }
  for (const host of hosts) {
    const problem = hostEntryProblem(host)
    if (problem !== undefined) return { problem }
  }
  return { hosts }
}

/**
 * Whether one entry's host admits a host: the same name or address, or for a `*.` entry a name below its domain.
 * @param pattern - a normalized entry's host.
 * @param host - a normalized host.
 * @returns whether the pattern admits the host.
 */
function hostAdmits(pattern: string, host: string): boolean {
  if (pattern.startsWith('*.')) return isIP(host) === 0 && host.endsWith(pattern.slice(1))
  return pattern === host
}

/**
 * Whether one allowlist entry admits a host on a port: its host admits the host, and the port is the entry's own or,
 * for an entry that names none, one of {@link DEFAULT_PORTS}.
 * @param entry - a normalized entry.
 * @param host - a normalized host as a request names it.
 * @param port - the port the request names.
 * @returns whether the entry admits the destination.
 */
export function entryAdmits(entry: string, host: string, port: number): boolean {
  const parts = hostEntryParts(entry)
  if (parts === undefined || !hostAdmits(parts.host, host)) return false
  return parts.port === undefined ? DEFAULT_PORTS.includes(port) : parts.port === port
}

/**
 * Whether an allowlist admits a host on a port.
 * @param hosts - the normalized entries.
 * @param host - the host as a request names it, normalized here.
 * @param port - the port the request names.
 * @returns whether any entry admits the destination.
 */
export function hostAllowed(hosts: readonly string[], host: string, port: number): boolean {
  const normalized = normalizeHost(host)
  return hosts.some(entry => entryAdmits(entry, normalized, port))
}

/**
 * Whether an allowlist admits a host on some port, for a refusal that tells a refused port from an unlisted host.
 * @param hosts - the normalized entries.
 * @param host - a normalized host.
 * @returns whether any entry's host admits it.
 */
export function hostListed(hosts: readonly string[], host: string): boolean {
  return hosts.some(entry => hostAdmits(hostEntryParts(entry)?.host ?? '', host))
}

/**
 * Whether an old entry reaches every destination a new one does: its host admits each host the new one admits, and
 * its ports include the new one's.
 * @param old - a normalized entry in effect.
 * @param entry - a normalized requested entry.
 * @returns whether the old entry covers the new one.
 */
function covers(old: string, entry: string): boolean {
  const before = hostEntryParts(old)
  const after = hostEntryParts(entry)
  if (before === undefined || after === undefined) return false
  const hosts = after.host.startsWith('*.')
    ? before.host.startsWith('*.') && after.host.endsWith(before.host.slice(1))
    : hostAdmits(before.host, after.host)
  if (!hosts) return false
  if (before.port === undefined) return after.port === undefined || DEFAULT_PORTS.includes(after.port)
  return after.port === before.port
}

/**
 * Whether a change of a workspace's network reaches anything the old setting did not: a less restrictive access, or
 * under `allowlist` an entry no old entry admits. Such a change needs the person to confirm it; any other change,
 * tightening or keeping the reach, applies at once.
 * @param previous - the setting in effect.
 * @param next - the requested setting.
 * @returns whether the change loosens the network.
 */
export function loosens(previous: WorkspaceNetwork, next: WorkspaceNetwork): boolean {
  const rank = (access: NetworkAccess): number => NETWORK_ACCESSES.indexOf(access)
  if (rank(next.access) !== rank(previous.access)) return rank(next.access) > rank(previous.access)
  if (next.access !== 'allowlist') return false
  return next.hosts.some(entry => !previous.hosts.some(old => covers(old, entry)))
}
