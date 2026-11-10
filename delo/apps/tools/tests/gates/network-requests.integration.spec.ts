/**
 * The network test's allowlist (`delo/apps/tools/src/checks/network-requests.json`): the requests Delorun makes without
 * being asked, each with its hosts, purpose, the switch that turns it off and where it is disclosed, and the requests it
 * makes only when the person asks. Every source file of the shipped code (`delo/packages/*` and the `cli`, `install` and
 * `npm-launcher` apps, browser halves excepted) that uses an outgoing network primitive must be listed, so a new request
 * in a new file fails here until it is entered. What this does not catch: a new request added to a file the list
 * already names, and a request made through a helper of another package, such as upstream's model client.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { PARITY_SWITCHES } from '@delo/contract-parity-composition'

const ROOT = join(import.meta.dirname, '../../../../..')
const LIST = 'delo/apps/tools/src/checks/network-requests.json'

/** An outgoing network primitive: fetch, an HTTPS, HTTP/2, TLS, UDP, undici or WebSocket import, or a socket connection. */
export const NETWORK_PRIMITIVE = /globalThis\.fetch|^import (?!type)[^\n]*from '(node:)?(https|http2|tls|dgram|undici|ws)'|\bnet\.(connect|createConnection)\(|\bnew (Socket|WebSocket)\(|\btls\.connect\(/mu

/** The shipped code the list governs. */
const SCOPES = ['delo/packages/*/src/**', 'delo/apps/cli/src/**', 'delo/apps/install/src/**', 'delo/apps/npm-launcher/src/**']

interface Unasked {
  readonly id: string
  readonly purpose: string
  readonly hosts: readonly string[]
  readonly when: string
  readonly sends: string
  readonly switch: { readonly kind: 'c16', readonly id: string } | { readonly kind: 'none', readonly reason: string }
  readonly disclosure: readonly string[]
  readonly sources: readonly string[]
}

interface NetworkRequests {
  readonly schema: string
  readonly unasked: readonly Unasked[]
  readonly asked: readonly { readonly id: string, readonly purpose: string, readonly sources: readonly string[] }[]
  readonly local: readonly { readonly source: string, readonly reason: string }[]
}

const list = JSON.parse(readFileSync(join(ROOT, LIST), 'utf8')) as NetworkRequests

/**
 * The shipped source files that use an outgoing network primitive.
 * @returns their repository paths.
 */
function networkFiles(): string[] {
  const files = execFileSync('git', ['ls-files', '--', ...SCOPES], { cwd: ROOT, encoding: 'utf8', timeout: 30_000 }).split('\n')
    .filter(path => /\.tsx?$/u.test(path) && !path.includes('/client/') && !path.includes('/tests/'))
  return files.filter(path => NETWORK_PRIMITIVE.test(readFileSync(join(ROOT, path), 'utf8')))
}

/**
 * Every source the list names.
 * @param requests - the list.
 * @returns the paths.
 */
function listed(requests: NetworkRequests): Set<string> {
  return new Set([...requests.unasked.flatMap(entry => entry.sources), ...requests.asked.flatMap(entry => entry.sources), ...requests.local.map(entry => entry.source)])
}

describe('the network test\'s allowlist', () => {
  it('lists every shipped source file that opens a network request', () => {
    const names = listed(list)
    expect(list.schema).toBe('delo.network-requests/1')
    expect(networkFiles().filter(path => !names.has(path))).toEqual([])
  })

  it('names only files that exist', () => {
    expect([...listed(list)].filter(path => !existsSync(join(ROOT, path)))).toEqual([])
  })

  it('gives each request made without asking its hosts, purpose, what it sends, a switch that exists, and a disclosure that exists', () => {
    const switches = new Set<string>(PARITY_SWITCHES.map(entry => entry.id))
    expect(list.unasked.length).toBeGreaterThan(0)
    for (const entry of list.unasked) {
      expect(entry.hosts.length, entry.id).toBeGreaterThan(0)
      for (const text of [entry.purpose, entry.when, entry.sends]) expect(text.trim(), entry.id).not.toBe('')
      if (entry.switch.kind === 'c16') expect(switches.has(entry.switch.id), `${entry.id}: switch ${entry.switch.id}`).toBe(true)
      else expect(entry.switch.reason.trim(), entry.id).not.toBe('')
      expect(entry.disclosure.length, entry.id).toBeGreaterThan(0)
      for (const path of entry.disclosure) expect(existsSync(join(ROOT, path)), `${entry.id}: ${path}`).toBe(true)
    }
  })

  it('fails a new request in a file the list does not name', () => {
    const without: NetworkRequests = { ...list, unasked: list.unasked.filter(entry => entry.id !== 'update-check'), asked: list.asked.filter(entry => !entry.sources.includes('delo/apps/cli/src/update/notice.ts')) }
    const names = listed(without)
    expect(networkFiles().filter(path => !names.has(path))).toContain('delo/apps/cli/src/update/notice.ts')
    expect(NETWORK_PRIMITIVE.test('const answer = await globalThis.fetch(url)')).toBe(true)
    expect(NETWORK_PRIMITIVE.test("import { request } from 'node:https'")).toBe(true)
    expect(NETWORK_PRIMITIVE.test("import type { Agent } from 'node:https'")).toBe(false)
  })
})
