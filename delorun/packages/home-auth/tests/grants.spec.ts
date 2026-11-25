/**
 * The grants a home keeps for Face ID and PIN unlocks (`src/grants.ts`): the hash a grant is keyed by, one use, 30
 * seconds of life, answer grants bound to the request and the answer value, and the holds bound to one terminal or
 * picker. Each test's comment names the check whose removal makes it fail.
 */
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  GRANT_BODY_CAP_BYTES, GRANT_LIFE_MS, GRANTS_PER_DEVICE, GrantStore, HOLD_ABSOLUTE_MS, HOLD_IDLE_MS, canonicalJson, hashArgs, hashRequest, holdFeatureOf,
} from '../src/grants.ts'

const PHONE = { deviceId: 'phone-1', listener: 'reach-tailscale-private' } as const
const OTHER_PHONE = { deviceId: 'phone-2', listener: 'reach-tailscale-private' } as const
const FUNNEL = { deviceId: 'phone-1', listener: 'reach-tailscale-funnel' } as const

function store(): { grants: GrantStore; clock: { at: number } } {
  const clock = { at: 1_000_000 }
  let counter = 0
  const grants = new GrantStore({ now: () => clock.at, random: size => Uint8Array.from({ length: size }, () => (counter++ % 251) + 1) })
  return { grants, clock }
}

const BODY_A = hashArgs({ id: 'a' }) ?? ''
const BODY_B = hashArgs({ id: 'b' }) ?? ''

describe('canonical JSON and the hashes', () => {
  // Removing the member sort makes two orderings of one object hash differently, so a client and the home disagree.
  it('writes object members in code-unit order with no whitespace', () => {
    expect(canonicalJson({ b: 1, a: [true, null, 'x'], c: { z: 1, y: 2 } })).toBe('{"a":[true,null,"x"],"b":1,"c":{"y":2,"z":1}}')
    expect(hashArgs({ b: 1, a: 2 })).toBe(hashArgs({ a: 2, b: 1 }))
  })

  // Removing the plain-object check hashes two different Dates, or a Map, as `{}`.
  it('has no form for an object that is not plain, so two Dates never hash alike', () => {
    expect(() => canonicalJson(new Date(1))).toThrow(TypeError)
    expect(() => canonicalJson({ at: new Map([[1, 2]]) })).toThrow(TypeError)
    expect(() => canonicalJson(new Uint8Array([1]))).toThrow(TypeError)
    expect(hashArgs({ at: new Date(1) })).toBeUndefined()
    expect(canonicalJson(Object.create(null))).toBe('{}')
  })

  // A client reproduces this vector with crypto.subtle: SHA-256 of the JCS text.
  it('hashes the JCS text with SHA-256 (the vector the client must reproduce)', () => {
    expect(hashArgs({ credentialId: 'abc' })).toBe(createHash('sha256').update('{"credentialId":"abc"}', 'utf8').digest('hex'))
  })

  // Removing the non-JSON refusal would let `undefined` or NaN arguments hash to something a grant could cover.
  it('has no hash for arguments JSON cannot hold', () => {
    expect(hashArgs(Number.NaN)).toBeUndefined()
    expect(hashArgs(() => 1)).toBeUndefined()
  })

  // Removing the method and path from the hash lets a grant for one route cover another with the same body.
  it('binds a request hash to the method, the path and the body', () => {
    const body = new TextEncoder().encode('{"a":1}')
    const base = hashRequest({ method: 'POST', path: '/api/x', body })
    expect(base).toMatch(/^[0-9a-f]{64}$/)
    expect(hashRequest({ method: 'POST', path: '/api/y', body })).not.toBe(base)
    expect(hashRequest({ method: 'PUT', path: '/api/x', body })).not.toBe(base)
    expect(hashRequest({ method: 'post', path: '/api/x', body })).toBe(base)
    expect(hashRequest({ method: 'POST', path: '/api/x', body: new TextEncoder().encode('{ "a": 1 }') })).toBe(base)
  })

  // Removing the size cap lets a grant be minted for a body the home never fully hashed.
  it('has no request hash for a body over the cap', () => {
    expect(hashRequest({ method: 'POST', path: '/x', body: new Uint8Array(GRANT_BODY_CAP_BYTES + 1) })).toBeUndefined()
    expect(hashRequest({ method: 'POST', path: '/x', body: new Uint8Array(GRANT_BODY_CAP_BYTES) })).toBeDefined()
  })

  // A body that is not JSON is hashed as the bytes the home received, not dropped.
  it('hashes a body that is not JSON by its bytes', () => {
    const one = hashRequest({ method: 'POST', path: '/x', body: new TextEncoder().encode('not json 1') })
    const two = hashRequest({ method: 'POST', path: '/x', body: new TextEncoder().encode('not json 2') })
    expect(one).not.toBe(two)
  })
})

describe('action grants', () => {
  // Removing the hash from the key makes a grant for body A cover body B.
  it('a grant for body A refuses body B', () => {
    const { grants } = store()
    grants.mint(PHONE, [{ action: 'pluginManager/installBundle', hash: BODY_A }], 'passkey')
    expect(grants.has(PHONE, 'pluginManager/installBundle', BODY_B)).toBe(false)
    expect(grants.consume(PHONE, 'pluginManager/installBundle', BODY_B)).toBeUndefined()
    expect(grants.has(PHONE, 'pluginManager/installBundle', BODY_A)).toBe(true)
  })

  // Removing the removal on consume lets a grant be replayed.
  it('is used once', () => {
    const { grants } = store()
    grants.mint(PHONE, [{ action: 'a', hash: BODY_A }], 'passkey')
    expect(grants.consume(PHONE, 'a', BODY_A)).toBeDefined()
    expect(grants.consume(PHONE, 'a', BODY_A)).toBeUndefined()
  })

  // `has` and `peek` are how the policy reads a grant while it decides; removing their read-only behaviour spends a grant on a refused call.
  it('reads without using it up', () => {
    const { grants } = store()
    grants.mint(PHONE, [{ action: 'a', hash: BODY_A }], 'pin')
    expect(grants.has(PHONE, 'a', BODY_A)).toBe(true)
    expect(grants.peek(PHONE, 'a', BODY_A)?.factor).toBe('pin')
    expect(grants.consume(PHONE, 'a', BODY_A)).toBeDefined()
  })

  // Removing the expiry check lets a grant outlive its 30 seconds.
  it('lives 30 seconds', () => {
    const { grants, clock } = store()
    grants.mint(PHONE, [{ action: 'a', hash: BODY_A }], 'passkey')
    clock.at += GRANT_LIFE_MS - 1
    expect(grants.has(PHONE, 'a', BODY_A)).toBe(true)
    clock.at += 1
    expect(grants.has(PHONE, 'a', BODY_A)).toBe(false)
  })

  // Removing the holder from the key lets one device spend another's grant, or one listener another's.
  it('belongs to its device and listener', () => {
    const { grants } = store()
    grants.mint(PHONE, [{ action: 'a', hash: BODY_A }], 'passkey')
    expect(grants.has(OTHER_PHONE, 'a', BODY_A)).toBe(false)
    expect(grants.has(FUNNEL, 'a', BODY_A)).toBe(false)
  })

  // One tap, several calls: each entry is its own use.
  it('holds one use per listed action', () => {
    const { grants } = store()
    const minted = grants.mint(PHONE, [{ action: 'a', hash: BODY_A }, { action: 'b', hash: BODY_B }], 'passkey')
    expect(grants.consume(PHONE, 'a', BODY_A)?.grantId).toBe(minted.grantId)
    expect(grants.consume(PHONE, 'b', BODY_B)?.grantId).toBe(minted.grantId)
    expect(grants.consume(PHONE, 'a', BODY_A)).toBeUndefined()
  })

  // Removing the per-device limit lets one device fill the store.
  it('keeps at most 64 per device and ends the oldest first', () => {
    const { grants } = store()
    for (let at = 0; at < GRANTS_PER_DEVICE + 3; at++) grants.mint(PHONE, [{ action: 'a', hash: hashArgs({ at }) ?? '' }], 'passkey')
    expect(grants.has(PHONE, 'a', hashArgs({ at: 0 }) ?? '')).toBe(false)
    expect(grants.has(PHONE, 'a', hashArgs({ at: GRANTS_PER_DEVICE + 2 }) ?? '')).toBe(true)
  })

  // A removed device's grants end with it.
  it('ends with its device', () => {
    const { grants } = store()
    grants.mint(PHONE, [{ action: 'a', hash: BODY_A }], 'passkey')
    grants.endDevice('phone-1')
    expect(grants.has(PHONE, 'a', BODY_A)).toBe(false)
  })
})

describe('answer grants', () => {
  // Removing the answer value from the key lets Face ID for "Allow once" admit a persistent allow.
  it('a grant for "Allow once" refuses a persistent allow', () => {
    const { grants } = store()
    grants.mintAnswer(PHONE, 'call-1', 'allowed-once')
    expect(grants.consumeAnswer(PHONE, 'call-1', 'allowed-always')).toBeUndefined()
    expect(grants.consumeAnswer(PHONE, 'call-1', 'allowed-once')).toBeDefined()
  })

  // Removing the request id from the key lets one prompt's grant answer another.
  it('a grant for one request refuses another request id', () => {
    const { grants } = store()
    grants.mintAnswer(PHONE, 'call-1', 'allowed-once')
    expect(grants.consumeAnswer(PHONE, 'call-2', 'allowed-once')).toBeUndefined()
  })

  it('is used once and expires', () => {
    const { grants, clock } = store()
    grants.mintAnswer(PHONE, 'call-1', 'allowed-once')
    expect(grants.consumeAnswer(PHONE, 'call-1', 'allowed-once')).toBeDefined()
    expect(grants.consumeAnswer(PHONE, 'call-1', 'allowed-once')).toBeUndefined()
    grants.mintAnswer(PHONE, 'call-3', 'allowed-once')
    clock.at += GRANT_LIFE_MS
    expect(grants.consumeAnswer(PHONE, 'call-3', 'allowed-once')).toBeUndefined()
  })

  it('belongs to its device', () => {
    const { grants } = store()
    grants.mintAnswer(PHONE, 'call-1', 'allowed-once')
    expect(grants.consumeAnswer(OTHER_PHONE, 'call-1', 'allowed-once')).toBeUndefined()
  })
})

describe('feature holds', () => {
  const terminal = { feature: 'terminal', id: 't-1' } as const
  const opened = { ...terminal, scope: 'session:s-1' } as const

  // Removing the id check lets a hold on one terminal admit another: the grant would open a feature, not a terminal.
  it('admits exactly the terminal the tapped call opened', () => {
    const { grants } = store()
    grants.mint(PHONE, [{ action: 'terminal/create', hash: BODY_A, hold: terminal }], 'passkey')
    grants.consume(PHONE, 'terminal/create', BODY_A, opened)
    expect(grants.holdAdmits(PHONE, 'terminal', 't-1', 'session:s-1')).toBe(true)
    expect(grants.holdAdmits(PHONE, 'terminal', 't-2', 'session:s-1')).toBe(false)
    expect(grants.holdAdmits(OTHER_PHONE, 'terminal', 't-1', 'session:s-1')).toBe(false)
  })

  // A client-named hold id that the call does not open (the home read `opens` from the call) opens nothing.
  it('does not open a hold the call itself does not open', () => {
    const { grants } = store()
    grants.mint(PHONE, [{ action: 'settings/mutate', hash: BODY_A, hold: terminal }], 'passkey')
    grants.consume(PHONE, 'settings/mutate', BODY_A)
    expect(grants.holdAdmits(PHONE, 'terminal', 't-1', 'session:s-1')).toBe(false)
    grants.mint(PHONE, [{ action: 'terminal/create', hash: BODY_B, hold: terminal }], 'passkey')
    grants.consume(PHONE, 'terminal/create', BODY_B, { feature: 'terminal', id: 't-9', scope: 'session:s-1' })
    expect(grants.holdAdmits(PHONE, 'terminal', 't-1', 'session:s-1')).toBe(false)
    expect(grants.holdAdmits(PHONE, 'terminal', 't-9', 'session:s-1')).toBe(false)
  })

  // Removing the idle cap keeps a forgotten terminal open for ever.
  it('ends after 5 minutes idle, and use renews the idle time', () => {
    const { grants, clock } = store()
    grants.mint(PHONE, [{ action: 'terminal/create', hash: BODY_A, hold: terminal }], 'passkey')
    grants.consume(PHONE, 'terminal/create', BODY_A, opened)
    clock.at += HOLD_IDLE_MS - 1
    expect(grants.holdAdmits(PHONE, 'terminal', 't-1', 'session:s-1')).toBe(true)
    clock.at += HOLD_IDLE_MS - 1
    expect(grants.holdAdmits(PHONE, 'terminal', 't-1', 'session:s-1')).toBe(true)
    clock.at += HOLD_IDLE_MS
    expect(grants.holdAdmits(PHONE, 'terminal', 't-1', 'session:s-1')).toBe(false)
  })

  // Removing the absolute cap lets constant use keep a hold for ever.
  it('ends after 60 minutes however busy', () => {
    const { grants, clock } = store()
    grants.mint(PHONE, [{ action: 'terminal/create', hash: BODY_A, hold: terminal }], 'passkey')
    grants.consume(PHONE, 'terminal/create', BODY_A, opened)
    for (let minute = 0; minute < 59; minute++) {
      clock.at += 60_000
      expect(grants.holdAdmits(PHONE, 'terminal', 't-1', 'session:s-1')).toBe(true)
    }
    clock.at += HOLD_ABSOLUTE_MS - 59 * 60_000
    expect(grants.holdAdmits(PHONE, 'terminal', 't-1', 'session:s-1')).toBe(false)
  })

  it('ends when closed or when the device ends', () => {
    const { grants } = store()
    grants.mint(PHONE, [{ action: 'terminal/create', hash: BODY_A, hold: terminal }], 'passkey')
    grants.consume(PHONE, 'terminal/create', BODY_A, opened)
    expect(grants.holdsAny(PHONE, 'terminal', 'session:s-1')).toBe(true)
    grants.closeHold(PHONE, 'terminal', 't-1', 'session:s-1')
    expect(grants.holdsAny(PHONE, 'terminal', 'session:s-1')).toBe(false)
    grants.mint(PHONE, [{ action: 'terminal/create', hash: BODY_B, hold: terminal }], 'passkey')
    grants.consume(PHONE, 'terminal/create', BODY_B, opened)
    grants.endDevice('phone-1')
    expect(grants.holdCount('phone-1')).toBe(0)
  })

  it('names the feature of a terminal, picker or export action', () => {
    expect(holdFeatureOf('terminal/attach')).toBe('terminal')
    expect(holdFeatureOf('directoryPicker/list')).toBe('picker')
    // Pins the export hold: the download route is admitted by the hold `/export` opens, so one confirmation covers both.
    expect(holdFeatureOf('commands/execute')).toBe('export')
    expect(holdFeatureOf('settings/mutate')).toBeUndefined()
  })
})

describe('the passkey.used log (P3-3)', () => {
  // Removing a log call leaves a use of a grant unlogged: the action grant (Fetch gate, device removal) or the answer grant.
  it('records the device, the action or answer and the grant id after each use, and nothing secret', () => {
    const lines: string[] = []
    let counter = 0
    const grants = new GrantStore({ now: () => 1_000_000, random: size => Uint8Array.from({ length: size }, () => (counter++ % 251) + 1), log: line => lines.push(line) })
    const minted = grants.mint(PHONE, [{ action: 'pluginManager/installBundle', hash: BODY_A }], 'pin')
    expect(grants.has(PHONE, 'pluginManager/installBundle', BODY_A)).toBe(true)
    expect(lines).toEqual([])
    grants.consume(PHONE, 'pluginManager/installBundle', BODY_A)
    const answer = grants.mintAnswer(PHONE, 'key-1', 'allowed-once')
    grants.consumeAnswer(PHONE, 'key-1', 'allowed-once')
    expect(grants.consume(PHONE, 'pluginManager/installBundle', BODY_A)).toBeUndefined()
    expect(lines).toEqual([
      `home-auth: passkey.used device=phone-1 listener=reach-tailscale-private action=pluginManager/installBundle factor=pin grant=${minted.grantId}`,
      `home-auth: passkey.used device=phone-1 listener=reach-tailscale-private answer=allowed-once grant=${answer.grantId}`,
    ])
  })
})
