/** Host-qualified persisted keys (contract C10): composition, isolation, fallback. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  defineStore, persistenceHostId, qualifiedPersistKey, setPersistenceHostId,
} from '../src/index.ts'

/** One canonical lowercase UUID version 4 — the host id form of contract C10. */
const HOST_A = '0b9e8c52-6a17-4b8e-9a2f-1d3c5e7f9a01'
const HOST_B = 'c2f4a6d8-3e50-4f19-b7a2-8c0e2d4b6f83'

afterEach(() => {
  setPersistenceHostId(undefined)
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

/** Back the browser's localStorage with a Map, as the sibling store spec does. */
function storage(): Map<string, string> {
  const values = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value) },
    removeItem: (key: string) => { values.delete(key) },
  })
  return values
}

describe('setPersistenceHostId', () => {
  it('carries the active connection\'s host id and clears it with undefined', () => {
    expect(persistenceHostId()).toBeUndefined()
    setPersistenceHostId(HOST_A)
    expect(persistenceHostId()).toBe(HOST_A)
    setPersistenceHostId(undefined)
    expect(persistenceHostId()).toBeUndefined()
  })

  it('rejects a host id outside the canonical lowercase UUID version 4 form', () => {
    for (const malformed of [
      HOST_A.toUpperCase(),
      '0b9e8c52-6a17-4b8e-9a2f-1d3c5e7f9a0',   // 35 characters
      '0b9e8c52-6a17-5b8e-9a2f-1d3c5e7f9a01',   // version nibble 5
      '0b9e8c52-6a17-4b8e-c2f4-1d3c5e7f9a01',   // variant nibble c
      'g h e 8c52-6a17-4b8e-9a2f-1d3c5e7f9a01', // non-hex character
      '0b9e8c526a174b8e9a2f1d3c5e7f9a01',       // unsegmented
      '',
    ]) {
      expect(() => { setPersistenceHostId(malformed) }).toThrow(/canonical lowercase UUID version 4/)
    }
    // A rejected id never becomes the active one.
    expect(persistenceHostId()).toBeUndefined()
  })
})

describe('qualifiedPersistKey', () => {
  it('joins the persist name with the host id and the caller\'s scope', () => {
    setPersistenceHostId(HOST_A)
    expect(qualifiedPersistKey('dsh.entry.v1')).toBe(`dsh.entry.v1.${HOST_A}`)
    expect(qualifiedPersistKey('dsh.entry.v1', 'session-9')).toBe(`dsh.entry.v1.${HOST_A}.session-9`)
  })

  it('keeps the bare stock shape while no host id is named', () => {
    expect(qualifiedPersistKey('dsh.entry.v1')).toBe('dsh.entry.v1')
    expect(qualifiedPersistKey('dsh.entry.v1', 'session-9')).toBe('dsh.entry.v1.session-9')
  })

  it('composes from parts and never parses the upstream id', () => {
    setPersistenceHostId(HOST_A)
    // A scope holding dots, or one that itself resembles a UUID, is appended
    // untouched after the fixed-length host id.
    expect(qualifiedPersistKey('dsh.entry.v1', 'session.with.dots'))
      .toBe(`dsh.entry.v1.${HOST_A}.session.with.dots`)
    expect(qualifiedPersistKey('dsh.entry.v1', HOST_B))
      .toBe(`dsh.entry.v1.${HOST_A}.${HOST_B}`)
  })
})

describe('defineStore persistence under a host id', () => {
  it('persists per connection and per session, and rehydrates from the same key', () => {
    const values = storage()
    const handle = defineStore({
      init: () => ({ draft: '' }),
      persist: 'spec.c10.chat',
      actions: { setDraft: (d, text: string) => { d.draft = text } },
    })
    setPersistenceHostId(HOST_A)
    handle.create('s1').actions.setDraft('one')
    handle.create('s2').actions.setDraft('two')
    handle.create().actions.setDraft('host-wide')
    expect(values.get(`spec.c10.chat.${HOST_A}.s1`)).toEqual(JSON.stringify({ draft: 'one' }))
    expect(values.get(`spec.c10.chat.${HOST_A}.s2`)).toEqual(JSON.stringify({ draft: 'two' }))
    expect(values.get(`spec.c10.chat.${HOST_A}`)).toEqual(JSON.stringify({ draft: 'host-wide' }))
    expect(values.has('spec.c10.chat.s1')).toBe(false)
    // Rehydration honors the same host-qualified key.
    expect(handle.create('s1').getSnapshot().draft).toBe('one')
  })

  it('keeps two connections with one upstream id in separate browser state', () => {
    const values = storage()
    const handle = defineStore({
      init: () => ({ draft: '' }),
      persist: 'spec.c10.chat',
      actions: { setDraft: (d, text: string) => { d.draft = text } },
    })
    setPersistenceHostId(HOST_A)
    handle.create('shared').actions.setDraft('connection A')
    setPersistenceHostId(HOST_B)
    expect(handle.create('shared').getSnapshot().draft).toBe('')
    handle.create('shared').actions.setDraft('connection B')
    expect(values.get(`spec.c10.chat.${HOST_A}.shared`)).toEqual(JSON.stringify({ draft: 'connection A' }))
    expect(values.get(`spec.c10.chat.${HOST_B}.shared`)).toEqual(JSON.stringify({ draft: 'connection B' }))
  })

  it('clears exactly its own host-qualified entry', () => {
    const values = storage()
    const handle = defineStore({
      init: () => ({ draft: '' }),
      persist: 'spec.c10.chat',
      actions: { setDraft: (d, text: string) => { d.draft = text } },
    })
    setPersistenceHostId(HOST_A)
    handle.create('s1').actions.setDraft('one')
    setPersistenceHostId(HOST_B)
    handle.create('s1').actions.setDraft('two')
    setPersistenceHostId(HOST_A)
    handle.create('s1').clearPersisted()
    expect(values.has(`spec.c10.chat.${HOST_A}.s1`)).toBe(false)
    expect(values.has(`spec.c10.chat.${HOST_B}.s1`)).toBe(true)
  })

  it('keeps the bare stock shape while no host id is named, without migrating it', () => {
    const values = storage()
    const handle = defineStore({
      init: () => ({ draft: '' }),
      persist: 'spec.c10.chat',
      actions: { setDraft: (d, text: string) => { d.draft = text } },
    })
    handle.create('s1').actions.setDraft('stock')
    expect(values.get('spec.c10.chat.s1')).toEqual(JSON.stringify({ draft: 'stock' }))
    // Once a host id is named, the stock entry is simply not read.
    setPersistenceHostId(HOST_A)
    expect(handle.create('s1').getSnapshot().draft).toBe('')
  })
})
