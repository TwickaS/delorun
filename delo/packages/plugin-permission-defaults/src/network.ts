/**
 * A workspace's network setting for sandboxed commands, and the host names its allowlist holds. The setting is one of
 * three accesses: `open`, the host's network as stock gives it; `allowlist`, the named hosts only, through Delo's
 * egress proxy; and `off`, no network at all. The module is free of Cordis, so the setting's validation, its order
 * and the host matching are testable without a mounted plugin.
 *
 * @module @delo/plugin-permission-defaults/network
 */
import { isIP } from 'node:net'
import { classifyAddress } from '@delo/plugin-fetch-guard/guard'

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

/**
 * Why an allowlist entry is refused, or nothing for an entry it accepts. An entry is a host name of at least two
 * labels, such as `registry.npmjs.org`; a name whose first label is `*`, such as `*.npmjs.org`, which matches every
 * name below that domain and not the domain itself, with at least two labels after the `*`; or a public IP address.
 * Names are ASCII, so an internationalized name is written in its `xn--` form, and an entry names no scheme, port or
 * path. An address the fetch guard refuses, such as a private-network or loopback address, is refused here too,
 * because the proxy never connects to one.
 * @param entry - the entry, as {@link normalizeHostEntry} returns it.
 * @returns the reason, or `undefined` when the entry is accepted.
 */
export function hostEntryProblem(entry: string): string | undefined {
  if (entry === '') return 'an entry is empty'
  if (isIP(entry) !== 0) {
    const refusal = classifyAddress(entry)
    return refusal === undefined ? undefined : `${JSON.stringify(entry)} is a ${refusal} address, which the proxy never connects to`
  }
  if (entry.length > 253) return `${JSON.stringify(entry.slice(0, 40))}… is longer than a host name can be`
  const wildcard = entry.startsWith('*.')
  const labels = (wildcard ? entry.slice(2) : entry).split('.')
  if (!labels.every(label => LABEL.test(label))) {
    return `${JSON.stringify(entry)} is not a host name: write a name such as registry.npmjs.org or *.npmjs.org, with no scheme, port or path`
  }
  if (labels.length < 2) {
    return wildcard
      ? `${JSON.stringify(entry)} would match every name under a top-level domain; name the domain, such as *.npmjs.org`
      : `${JSON.stringify(entry)} is a single-label name; name a full host, such as registry.npmjs.org`
  }
  return undefined
}

/**
 * The form an allowlist entry is compared in: trimmed, lower case, without one trailing dot, and an IPv6 address
 * without its brackets.
 * @param entry - the entry as the person or a configuration wrote it.
 * @returns the normalized entry.
 */
export function normalizeHostEntry(entry: string): string {
  const lower = entry.trim().toLowerCase()
  const bare = lower.startsWith('[') && lower.endsWith(']') ? lower.slice(1, -1) : lower
  return bare.endsWith('.') ? bare.slice(0, -1) : bare
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
 * Whether one allowlist entry admits a host: the same name or address, or for a `*.` entry a name below its domain.
 * @param entry - a normalized entry.
 * @param host - a normalized host as a request names it.
 * @returns whether the entry admits the host.
 */
export function entryAdmits(entry: string, host: string): boolean {
  if (entry.startsWith('*.')) return isIP(host) === 0 && host.endsWith(entry.slice(1))
  return entry === host
}

/**
 * Whether an allowlist admits a host.
 * @param hosts - the normalized entries.
 * @param host - the host as a request names it, normalized here.
 * @returns whether any entry admits it.
 */
export function hostAllowed(hosts: readonly string[], host: string): boolean {
  const normalized = normalizeHostEntry(host)
  return hosts.some(entry => entryAdmits(entry, normalized))
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
  return next.hosts.some(entry => !previous.hosts.some(old => old === entry || (entry.startsWith('*.') ? old.startsWith('*.') && entry.endsWith(old.slice(1)) : entryAdmits(old, entry))))
}
