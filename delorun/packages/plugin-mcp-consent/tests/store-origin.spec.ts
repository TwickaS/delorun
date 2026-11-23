/**
 * Specs of the acceptance store's origins: a version-7 acceptance keeps the origin it was accepted for, a version-6
 * store is read forward with no origin and rewritten as version 7, an invalid origin refuses the store, and an
 * acceptance covers a server of its own origin only, one with none counting as the unknown origin's.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  AcceptanceStoreError,
  acceptanceCovers,
  acceptanceOfStart,
  acceptanceStorePath,
  parseAcceptanceStore,
  readAcceptanceStore,
  serializeAcceptanceStore,
  writeAcceptanceStore,
  type ServerAcceptance,
  type ServerStart,
} from '../src/store.ts'

const TOOL_FILE = { path: '/usr/bin/tool', sha256: `sha256:${'0'.repeat(64)}` }
const START_DIGEST = `sha256:${'1'.repeat(64)}`

const START: ServerStart = {
  command: 'npx',
  args: ['-y', 'server'],
  cwd: '',
  env: {},
  resolvedCommand: '/usr/bin/tool',
  resolvedCwd: '/home/person',
  files: [TOOL_FILE],
}

/**
 * One acceptance in the store's format, without an origin.
 * @param acceptedAt - the acceptance time.
 * @returns the acceptance, as a store's JSON holds it.
 */
function acceptance(acceptedAt: number) {
  return { command: 'npx', args: ['-y', 'server'], cwd: '', resolvedCommand: '/usr/bin/tool', resolvedCwd: '/home/person', env: {}, files: [TOOL_FILE], acceptedAt }
}

/**
 * A store's text of a version.
 * @param version - the store's version.
 * @param acceptances - the acceptances, by server name.
 * @returns the JSON text.
 */
function storeText(version: number, acceptances: object): string {
  return JSON.stringify({ v: version, acceptances, setAside: { beta: { state: 'revoked', start: START_DIGEST } } }, null, 2)
}

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'delorun-mcp-store-origin-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('the acceptance store origins', () => {
  it('round-trips the origin an acceptance was recorded for, and writes none for one without', () => {
    const store = {
      acceptances: new Map([
        ['plugged', acceptanceOfStart(START, 2, 'plugin:@scope/pack')],
        ['profiled', acceptanceOfStart(START, 1, 'profile')],
        ['plain', acceptanceOfStart(START, 3, undefined)],
      ]),
      setAside: new Map(),
    }
    const text = serializeAcceptanceStore(store)
    expect(JSON.parse(text)).toEqual({
      v: 7,
      acceptances: {
        plain: acceptance(3),
        plugged: { ...acceptance(2), origin: 'plugin:@scope/pack' },
        profiled: { ...acceptance(1), origin: 'profile' },
      },
      setAside: {},
    })
    expect(parseAcceptanceStore(text)).toEqual(store)
    expect(parseAcceptanceStore(text).acceptances.get('plain')).not.toHaveProperty('origin')
  })

  it('records the origin an acceptance is made for and leaves it out when none is given', () => {
    expect(acceptanceOfStart(START, 5, 'pack:team')).toMatchObject({ origin: 'pack:team', acceptedAt: 5 })
    expect(acceptanceOfStart(START, 5)).not.toHaveProperty('origin')
    expect(acceptanceOfStart(START, 5, undefined)).not.toHaveProperty('origin')
  })

  it('reads a version-6 store with no origin, then rewrites it as version 7 keeping its acceptances and set-aside starts', async () => {
    const path = acceptanceStorePath(root)
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    const v6 = storeText(6, { srv: acceptance(1), other: acceptance(2) })
    const parsed = parseAcceptanceStore(v6)
    expect([...parsed.acceptances.keys()].sort()).toEqual(['other', 'srv'])
    expect(parsed.acceptances.get('srv')).toEqual({ ...acceptance(1) })
    expect(parsed.acceptances.get('srv')).not.toHaveProperty('origin')
    expect(parsed.setAside.get('beta')).toEqual({ state: 'revoked', start: START_DIGEST })

    writeFileSync(path, v6, { mode: 0o600 })
    const read = await readAcceptanceStore(path)
    if (read.kind !== 'readable') throw new Error(`the version-6 store was not readable: ${read.kind}`)
    const added = new Map(read.store.acceptances).set('fresh', acceptanceOfStart(START, 3, 'chat'))
    await writeAcceptanceStore(path, { ...read.store, acceptances: added })

    const written = JSON.parse(readFileSync(path, 'utf8')) as { v: number, acceptances: Record<string, object>, setAside: object }
    expect(written.v).toBe(7)
    expect(written.acceptances).toEqual({ fresh: { ...acceptance(3), origin: 'chat' }, other: acceptance(2), srv: acceptance(1) })
    expect(written.setAside).toEqual({ beta: { state: 'revoked', start: START_DIGEST } })
  })

  it('refuses a version-6 acceptance that holds an origin, which that version never wrote', () => {
    expect(() => parseAcceptanceStore(storeText(6, { srv: { ...acceptance(1), origin: 'profile' } }))).toThrow('the acceptance of the server "srv" sets origin')
  })

  it('accepts every origin form, at the longest length', () => {
    const longest = `pack:${'a'.repeat(280)}`
    for (const origin of ['profile', 'settings', 'chat', 'unknown', 'pack:x', 'plugin:@scope/name', longest]) {
      expect(parseAcceptanceStore(storeText(7, { srv: { ...acceptance(1), origin } })).acceptances.get('srv')?.origin).toBe(origin)
    }
    expect(longest.length).toBeLessThanOrEqual(300)
  })

  it('refuses a version-7 acceptance whose origin is not an origin key, and reads nothing from the store', () => {
    for (const origin of ['', 'pack:', 'plugin:', 'other', 'Profile', 'pack:a b', 'pack:a\nb', `pack:${'a'.repeat(281)}`, `plugin:${'a'.repeat(300)}`, 'profile ', 5, null, ['profile']]) {
      const text = storeText(7, { good: acceptance(1), srv: { ...acceptance(1), origin } })
      expect(() => parseAcceptanceStore(text), JSON.stringify(origin)).toThrow(AcceptanceStoreError)
      expect(() => parseAcceptanceStore(text), JSON.stringify(origin)).toThrow('the acceptance of the server "srv" does not hold an origin')
    }
  })

  it('refuses a store of version 8 and a string version, as before', () => {
    for (const version of [8, '7', '6']) {
      expect(() => parseAcceptanceStore(JSON.stringify({ v: version, acceptances: {}, setAside: {} }))).toThrow(`the store's version is ${JSON.stringify(version)}, not 7`)
    }
  })
})

describe('acceptanceCovers', () => {
  const absent: ServerAcceptance = acceptanceOfStart(START, 1)
  const packed: ServerAcceptance = acceptanceOfStart(START, 1, 'pack:x')

  it('counts an acceptance from a version-6 store, which holds no origin, as the unknown origin\'s only', () => {
    expect(acceptanceCovers(absent, 'unknown')).toBe(true)
    for (const origin of ['profile', 'settings', 'chat', 'pack:x', 'plugin:x']) expect(acceptanceCovers(absent, origin), origin).toBe(false)
  })

  it('covers only the origin the acceptance holds', () => {
    expect(acceptanceCovers(packed, 'pack:x')).toBe(true)
    expect(acceptanceCovers(packed, 'plugin:x')).toBe(false)
    expect(acceptanceCovers(packed, 'pack:y')).toBe(false)
    expect(acceptanceCovers(packed, 'profile')).toBe(false)
  })
})
