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
  fiber = await ctx.plugin(HomeAuthService, { secretsDirectory: join(directory, 'secrets', 'home-auth'), phonePowersOnUpgrade: 'full' })
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

  it('accepts a for-run answer from an unlocked PIN page', async () => {
    const page = await phone(4)
    const reach = provider()['reachPeers'].get(page.id as never)
    if (reach === undefined) throw new Error('no reach Peer')
    provider()['reachPeers'].set(page.id as never, { ...reach, unlockId: 'page-1' })
    vi.spyOn(ctx.homeAuth, 'pageUnlockOf').mockImplementation(() => ({ id: 'page-1' }) as never)
    expect(() => { check(page, RUN_ANSWER) }).not.toThrow()
    vi.spyOn(ctx.homeAuth, 'pageUnlockOf').mockImplementation(() => undefined)
    expect(() => { check(page, RUN_ANSWER) }).toThrow(expect.objectContaining({ code: 'LOOPBACK_REQUIRED' }))
  })

  it('accepts the computer\'s for-run answer', () => {
    expect(() => { check({ id: 'local' }, RUN_ANSWER) }).not.toThrow()
  })
})
