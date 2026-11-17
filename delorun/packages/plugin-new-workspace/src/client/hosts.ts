/**
 * The allowlist text of the safety screen: one site per line, checked as host names before it is sent. The Host checks
 * again and refuses what this check lets through, such as an address inside the private network.
 * @module @delorun/plugin-new-workspace/client/hosts
 */

/** The most sites an allowlist holds, as the Host's network store accepts. */
export const MAX_HOSTS = 200

/** One DNS label: letters, digits and hyphens, not starting or ending with a hyphen. */
const LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/u

/** Why the allowlist text cannot be used. */
export type HostsProblem =
  | { readonly kind: 'empty' }
  | { readonly kind: 'too-many' }
  | { readonly kind: 'invalid', readonly host: string }

/**
 * Whether one entry is a host name the Host takes: at least two labels, optionally led by `*.` and ended by `:port`.
 * @param entry - the entry in lower case, trimmed.
 * @returns true when the entry is a host name.
 */
function isHostEntry(entry: string): boolean {
  if (/[/?#@\\\s]/u.test(entry)) return false
  const colon = entry.lastIndexOf(':')
  let host = entry
  if (colon !== -1) {
    const port = entry.slice(colon + 1)
    if (!/^[1-9]\d{0,4}$/u.test(port) || Number(port) > 65_535) return false
    host = entry.slice(0, colon)
  }
  if (host.length > 253) return false
  const labels = (host.startsWith('*.') ? host.slice(2) : host).split('.')
  return labels.length >= 2 && labels.every(label => LABEL.test(label))
}

/**
 * Read the allowlist text.
 * @param text - the hosts, one per line.
 * @returns the hosts in the form the Host stores (lower case, without duplicates, sorted), or the first problem.
 */
export function parseHosts(text: string): { readonly hosts: readonly string[] } | { readonly problem: HostsProblem } {
  const entries = text.split('\n').map(line => line.trim().toLowerCase()).filter(line => line !== '')
  if (entries.length === 0) return { problem: { kind: 'empty' } }
  const invalid = entries.find(entry => !isHostEntry(entry))
  if (invalid !== undefined) return { problem: { kind: 'invalid', host: invalid } }
  const hosts = [...new Set(entries)].sort()
  return hosts.length > MAX_HOSTS ? { problem: { kind: 'too-many' } } : { hosts }
}
