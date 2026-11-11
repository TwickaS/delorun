/**
 * Specs of a workspace's network setting free of Cordis: which allowlist entries are accepted and why others are
 * refused, how an entry and a request's host compare, and which changes loosen the network and so need the person's
 * confirmation. Also the network store's format, its refusals and its round trip.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  entryAdmits, hostAllowed, hostEntryProblem, isNetworkAccess, loosens, MAX_ALLOWED_HOSTS, normalizeHostEntry, parseHostList,
  type WorkspaceNetwork,
} from '../src/network.ts'
import { networkStorePath, parseNetworkStore, readNetworkStore, serializeNetworkStore, writeNetworkStore } from '../src/network-store.ts'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('allowlist entries', () => {
  it.each(['registry.npmjs.org', '*.npmjs.org', 'xn--bcher-kva.example', '203.0.113.7', '2001:db8::1111', 'a-b.c-d.example'])('accepts %s', (entry) => {
    expect(hostEntryProblem(entry)).toBeUndefined()
  })

  it.each([
    ['', 'empty'],
    ['https://registry.npmjs.org', 'not a host name'],
    ['registry.npmjs.org:443', 'not a host name'],
    ['registry.npmjs.org/path', 'not a host name'],
    ['bücher.example', 'not a host name'],
    ['-bad.example', 'not a host name'],
    ['*', 'not a host name'],
    ['*.com', 'top-level domain'],
    ['localhost', 'single-label'],
    ['a.*.example', 'not a host name'],
    ['10.0.0.1', 'private address'],
    ['127.0.0.1', 'loopback address'],
    ['169.254.169.254', 'link-local address'],
    ['::1', 'loopback address'],
    [`${'a'.repeat(250)}.example`, 'longer than a host name'],
  ])('refuses %j: %s', (entry, reason) => {
    expect(hostEntryProblem(entry)).toContain(reason)
  })

  it('normalizes case, surrounding space, one trailing dot and IPv6 brackets', () => {
    expect(normalizeHostEntry('  Registry.NPMJS.org. ')).toBe('registry.npmjs.org')
    expect(normalizeHostEntry('[2001:db8::1]')).toBe('2001:db8::1')
  })

  it('parses a list into sorted, unique entries, or names its first problem', () => {
    expect(parseHostList(['b.example', 'A.example', 'a.example.'])).toEqual({ hosts: ['a.example', 'b.example'] })
    expect(parseHostList(['ok.example', 'http://bad'])).toEqual({ problem: expect.stringContaining('"http://bad"') as string })
    const many = Array.from({ length: MAX_ALLOWED_HOSTS + 1 }, (_, index) => `h${index}.example`)
    expect(parseHostList(many)).toEqual({ problem: expect.stringContaining(`at most ${MAX_ALLOWED_HOSTS}`) as string })
  })

  it('knows the three accesses', () => {
    expect(['off', 'allowlist', 'open'].every(isNetworkAccess)).toBe(true)
    expect(isNetworkAccess('closed')).toBe(false)
    expect(isNetworkAccess(1)).toBe(false)
  })
})

describe('host matching', () => {
  it('admits the same name, and for a wildcard every name below its domain but not the domain itself', () => {
    expect(entryAdmits('registry.npmjs.org', 'registry.npmjs.org')).toBe(true)
    expect(entryAdmits('*.npmjs.org', 'registry.npmjs.org')).toBe(true)
    expect(entryAdmits('*.npmjs.org', 'a.b.npmjs.org')).toBe(true)
    expect(entryAdmits('*.npmjs.org', 'npmjs.org')).toBe(false)
    expect(entryAdmits('*.npmjs.org', 'evilnpmjs.org')).toBe(false)
    expect(entryAdmits('*.npmjs.org', 'npmjs.org.evil.example')).toBe(false)
  })

  it('never lets a wildcard admit an address literal', () => {
    expect(entryAdmits('*.0.0.1', '10.0.0.1')).toBe(false)
  })

  it('normalizes the requested host before comparing', () => {
    expect(hostAllowed(['registry.npmjs.org'], 'REGISTRY.npmjs.org.')).toBe(true)
    expect(hostAllowed(['registry.npmjs.org'], 'registry.npmjs.org.evil.example')).toBe(false)
    expect(hostAllowed([], 'registry.npmjs.org')).toBe(false)
  })
})

describe('which changes loosen the network', () => {
  const off: WorkspaceNetwork = { access: 'off', hosts: [] }
  const open: WorkspaceNetwork = { access: 'open', hosts: [] }
  const list = (...hosts: string[]): WorkspaceNetwork => ({ access: 'allowlist', hosts })

  it('ranks off below allowlist below open', () => {
    expect(loosens(off, list())).toBe(true)
    expect(loosens(list('a.example'), open)).toBe(true)
    expect(loosens(off, open)).toBe(true)
    expect(loosens(open, list('a.example'))).toBe(false)
    expect(loosens(list('a.example'), off)).toBe(false)
    expect(loosens(open, off)).toBe(false)
  })

  it('counts an added host the old list did not admit, and nothing else, as loosening', () => {
    expect(loosens(list('a.example'), list('a.example', 'b.example'))).toBe(true)
    expect(loosens(list('a.example', 'b.example'), list('a.example'))).toBe(false)
    expect(loosens(list('*.example.com'), list('www.example.com'))).toBe(false)
    expect(loosens(list('*.example.com'), list('*.a.example.com'))).toBe(false)
    expect(loosens(list('*.a.example.com'), list('*.example.com'))).toBe(true)
    expect(loosens(list('www.example.com'), list('*.example.com'))).toBe(true)
  })

  it('keeps a change between the same restrictive accesses, hosts aside, from loosening', () => {
    expect(loosens({ access: 'off', hosts: ['a.example'] }, { access: 'off', hosts: ['b.example'] })).toBe(false)
    expect(loosens(open, { access: 'open', hosts: ['b.example'] })).toBe(false)
  })
})

describe('the network store', () => {
  /** A fresh home with the store's directory. */
  function home(): string {
    const root = mkdtempSync(join(tmpdir(), 'delo-network-store-'))
    roots.push(root)
    return root
  }

  it('lives beside the permission store in the home\'s secrets', () => {
    expect(networkStorePath('/h')).toBe(join('/h', 'secrets', 'permission-defaults', 'network.json'))
  })

  it('round-trips its entries, sorted by workspace, at mode 0600', async () => {
    const path = networkStorePath(home())
    const entries = new Map<string, WorkspaceNetwork>([['/w/b', { access: 'off', hosts: [] }], ['/w/a', { access: 'allowlist', hosts: ['a.example'] }]])
    await writeNetworkStore(path, entries)
    expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(Object.keys((JSON.parse(readFileSync(path, 'utf8')) as { workspaces: object }).workspaces)).toEqual(['/w/a', '/w/b'])
    expect(await readNetworkStore(path)).toEqual({ kind: 'readable', entries: new Map([['/w/a', entries.get('/w/a')], ['/w/b', entries.get('/w/b')]]) })
  })

  it('reads a missing store as absent', async () => {
    expect(await readNetworkStore(networkStorePath(home()))).toEqual({ kind: 'absent' })
  })

  it('refuses a store laxer than 0600 or reached through a link', async () => {
    const root = home()
    const path = networkStorePath(root)
    mkdirSync(join(path, '..'), { recursive: true, mode: 0o700 })
    writeFileSync(path, serializeNetworkStore(new Map()), { mode: 0o644 })
    expect((await readNetworkStore(path)).kind).toBe('refused')
    rmSync(path)
    writeFileSync(join(root, 'real.json'), serializeNetworkStore(new Map()), { mode: 0o600 })
    symlinkSync(join(root, 'real.json'), path)
    expect((await readNetworkStore(path)).kind).toBe('refused')
  })

  it.each([
    ['not json', 'no JSON document'],
    ['[]', 'not a JSON object'],
    ['{"v":2,"workspaces":{}}', 'version is 2'],
    ['{"v":1,"workspaces":{},"x":1}', 'sets x'],
    ['{"v":1}', 'workspaces object'],
    ['{"v":1,"workspaces":{"":{"access":"off","hosts":[]}}}', 'empty workspace key'],
    ['{"v":1,"workspaces":{"/w":1}}', 'not an object'],
    ['{"v":1,"workspaces":{"/w":{"access":"off","hosts":[],"y":1}}}', 'sets y'],
    ['{"v":1,"workspaces":{"/w":{"access":"closed","hosts":[]}}}', 'access off, allowlist or open'],
    ['{"v":1,"workspaces":{"/w":{"access":"off","hosts":[1]}}}', 'list of hosts'],
    ['{"v":1,"workspaces":{"/w":{"access":"allowlist","hosts":["10.0.0.1"]}}}', 'private address'],
  ])('refuses %s', (text, reason) => {
    expect(() => parseNetworkStore(text)).toThrow(reason)
  })

  it('refuses a store whose text is not this format through the read', async () => {
    const path = networkStorePath(home())
    mkdirSync(join(path, '..'), { recursive: true, mode: 0o700 })
    writeFileSync(path, '{"v":1}', { mode: 0o600 })
    expect(await readNetworkStore(path)).toEqual({ kind: 'refused', problem: 'the store does not hold a workspaces object' })
  })
})
