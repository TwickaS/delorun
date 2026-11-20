/**
 * The real reach guard (`HomeAuthAuthenticator.checkAnswer`, which the gateway calls before it applies a remote
 * answer) against the seat relay's questions: a question with the `external-agent` marker and an answer of
 * `'allowed-for-run'`, which counts as granting like `'allowed-once'`.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context, type Fiber } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { StudioAddress } from '@delorun/contract-admission'
import { HomeAuthAuthenticator, HomeAuthService } from '@delorun/home-auth'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { claimOf, recordOf } from '../../home-auth/tests/fixtures/home.ts'
import { DeviceStore } from '../../home-auth/src/devices.ts'
import { answerKey } from '../../home-auth/src/grants.ts'
import { RUN_ANSWER } from '../src/relay/index.ts'

const ADDRESS = brandString<StudioAddress>('https://home.example.ts.net')
const LISTENER = 'reach-tailscale-private'
const QUESTION = { grants: 'external-agent', runScope: 'external-agent-run' }

let ctx: Context
let fiber: Fiber
let directory: string

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'delorun-seat-reach-'))
  ctx = new Context()
  let peers = 0
  ctx.provide('webServer', { register: () => () => {}, port: undefined } as never)
  ctx.provide('connection', {
    builtinAdmission: () => ({ kind: 'refused', status: 401, code: 'NOT_SIGNED_IN' }),
    createPeer: () => ({ id: `peer-${String(peers++)}`, ctx: new Context(), principal: { kind: 'owner' }, signal: new AbortController().signal, interactions: 'answer', dispose: async () => {} }),
    closeReachConnections: () => 0,
  } as never)
  fiber = await ctx.plugin(HomeAuthService, { secretsDirectory: join(directory, 'secrets', 'home-auth') })
  await new Promise<void>((resolve) => { ctx.inject(['authenticator'], () => { resolve() }) })
  ctx.homeAuth.serve({ listener: LISTENER, address: ADDRESS, factor: 'tailnet-membership' })
})

afterEach(async () => {
  await fiber.dispose()
  await rm(directory, { recursive: true, force: true })
})

function provider(): HomeAuthAuthenticator {
  const value = ctx.authenticator
  if (!(value instanceof HomeAuthAuthenticator)) throw new Error('home-auth did not provide the authenticator')
  return value
}

/** A reach Peer admitted on a signed-in device's session. */
async function phone(fill: number): Promise<{ readonly id: string }> {
  const store = new DeviceStore({ file: join(directory, 'secrets', 'home-auth', 'devices.json') })
  await ctx.homeAuth.claim(claimOf((await ctx.homeAuth.issueOwnerCode()).code, { address: brandString<StudioAddress>('http://127.0.0.1:3080') }))
  await store.add(recordOf(fill, ADDRESS))
  const opened = await ctx.homeAuth.openSession({ deviceId: recordOf(fill, ADDRESS).id, listener: LISTENER, address: ADDRESS, factor: 'tailnet-membership', lifetimeMs: 3_600_000 })
  const admitted = provider().admit({ headers: { cookie: `__Host-delorun-session=${opened.token}` }, method: 'GET', url: '/' } as never, LISTENER)
  if (admitted.kind !== 'admitted') throw new Error('not admitted')
  return admitted.peer
}

const check = (peer: { readonly id: string }, value: unknown): void => {
  provider().checkAnswer({ peer: peer as never, event: 'approval/request', request: QUESTION, value })
}

describe('the real reach guard on a seat question', () => {
  it('refuses a locked phone any granting answer, for this run included, and lets it reject', async () => {
    const locked = await phone(2)
    expect(() => { check(locked, RUN_ANSWER) }).toThrow(expect.objectContaining({ code: 'LOOPBACK_REQUIRED', details: { action: 'external-agent' } }))
    expect(() => { check(locked, 'allowed-once') }).toThrow(expect.objectContaining({ code: 'LOOPBACK_REQUIRED' }))
    expect(() => { check(locked, 'rejected') }).not.toThrow()
  })

  it('refuses a code-unlocked phone with dangerous mode off and lets it reject', async () => {
    const coded = await phone(3)
    vi.spyOn(ctx.homeAuth, 'elevationOf').mockImplementation(() => ({ id: 'elevation-1' }) as never)
    expect(ctx.homeAuth.dangerousMode()).toBe(false)
    expect(() => { check(coded, RUN_ANSWER) }).toThrow(expect.objectContaining({ code: 'LOOPBACK_REQUIRED' }))
    expect(() => { check(coded, 'allowed-once') }).toThrow(expect.objectContaining({ code: 'LOOPBACK_REQUIRED' }))
    expect(() => { check(coded, 'rejected') }).not.toThrow()
  })

  it('refuses a device that holds only the approval grace, with dangerous mode off', async () => {
    const grace = await phone(5)
    vi.spyOn(ctx.homeAuth, 'elevationOf').mockImplementation(() => ({ id: 'grace-1', grace: true }) as never)
    expect(ctx.homeAuth.dangerousMode()).toBe(false)
    expect(() => { check(grace, RUN_ANSWER) }).toThrow(expect.objectContaining({ code: 'LOOPBACK_REQUIRED' }))
    expect(() => { check(grace, 'allowed-once') }).toThrow(expect.objectContaining({ code: 'LOOPBACK_REQUIRED' }))
  })

  // Pins A483 for seats: with the page-unlock lift back in checkAnswer, a PIN page answers for this run with no grant.
  it('refuses a for-run answer from a page that holds a PIN unlock until its own answer grant, once', async () => {
    const page = await phone(4)
    const reach = provider()['reachPeers'].get(page.id as never)
    if (reach === undefined) throw new Error('no reach Peer')
    provider()['reachPeers'].set(page.id as never, { ...reach, unlockId: 'page-1' })
    vi.spyOn(ctx.homeAuth, 'pageUnlockOf').mockImplementation(() => ({ id: 'page-1' }) as never)
    const question = { ...QUESTION, agent: { id: 'seat-child' }, callId: 'call_9' }
    const answer = (value: string): void => { provider().checkAnswer({ peer: page as never, event: 'approval/request', request: question, value }) }
    expect(() => { answer(RUN_ANSWER) }).toThrow(expect.objectContaining({ code: 'LOOPBACK_REQUIRED', details: { action: 'external-agent' } }))
    const grants = ctx.homeAuth.faceGrants()
    if (grants === undefined) throw new Error('no grant store')
    grants.mintAnswer({ deviceId: reach.deviceId, listener: reach.listener }, answerKey({ agent: 'seat-child', callId: 'call_9', grants: 'external-agent' }), RUN_ANSWER)
    expect(() => { answer('allowed-once') }).toThrow(expect.objectContaining({ code: 'LOOPBACK_REQUIRED' }))
    expect(() => { answer(RUN_ANSWER) }).not.toThrow()
    expect(() => { answer(RUN_ANSWER) }).toThrow(expect.objectContaining({ code: 'LOOPBACK_REQUIRED' }))
  })

  // A499 admits an external-agent answer of the Peer that holds a live Face ID pass; a run answer counts as an answer like Allow once (L110).
  it('admits a for-run answer under the answering device\'s own live Face ID pass only, and refuses it after the pass ends', async () => {
    const page = await phone(4)
    const reach = provider()['reachPeers'].get(page.id as never)
    if (reach === undefined) throw new Error('no reach Peer')
    const holder = { deviceId: reach.deviceId, listener: reach.listener }
    const question = { ...QUESTION, agent: { id: 'seat-child' }, callId: 'call_10' }
    const answer = (value: string): void => { provider().checkAnswer({ peer: page as never, event: 'approval/request', request: question, value }) }
    const grants = ctx.homeAuth.faceGrants()
    if (grants === undefined) throw new Error('no grant store')
    grants.openPass({ deviceId: 'another-device', listener: reach.listener }, 15)
    expect(() => { answer(RUN_ANSWER) }).toThrow(expect.objectContaining({ code: 'LOOPBACK_REQUIRED' }))
    grants.openPass(holder, 15)
    expect(() => { answer(RUN_ANSWER) }).not.toThrow()
    grants.endPass(holder, 'lock-now')
    expect(() => { answer(RUN_ANSWER) }).toThrow(expect.objectContaining({ code: 'LOOPBACK_REQUIRED' }))
  })

  it('accepts the computer\'s for-run answer', () => {
    expect(() => { check({ id: 'local' }, RUN_ANSWER) }).not.toThrow()
  })
})
