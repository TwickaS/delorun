/**
 * Denial specs of "Allow for this run" and the locked device on the real answer path: a question reaches clients as a
 * pending event of the real Gateway, and each client answers through the Gateway's `$events/result` handling, which
 * calls the real home-auth guard (`HomeAuthAuthenticator.checkAnswer`) before it applies an answer. Only the bridge
 * from the `approval/request` waterfall to the Gateway's event source is a stand-in, as in the Gateway's own specs.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import TypertGatewayService, { type TypertRemoteEventDispatch } from '@deepseek-ai/dsh-api-gateway'
import RemoteAccessService from '@deepseek-ai/dsh-api-remote-access'
import { apply as applyConnection, inject as connectionInject } from '@deepseek-ai/dsh-client-connection'
import type { PeerScope } from '@deepseek-ai/dsh-typert-protocol'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import type { StudioAddress } from '@delorun/contract-admission'
import { HomeAuthAuthenticator, HomeAuthService } from '@delorun/home-auth'
import { answerKey } from '../../home-auth/src/grants.ts'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { claimOf, recordOf } from '../../home-auth/tests/fixtures/home.ts'
import { DeviceStore } from '../../home-auth/src/devices.ts'
import { RUN_ANSWER } from '../src/relay/index.ts'
import { question, RULE, world, type World } from './relay-world.ts'

const ADDRESS = brandString<StudioAddress>('https://home.example.ts.net')
const LISTENER = 'reach-tailscale-private'

let directory: string
let w: World
let abort: AbortController

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'delorun-seat-gateway-'))
  abort = new AbortController()
  w = await world('ask', true, async (ctx) => {
    ctx.provide('webServer', { register: () => () => {}, port: undefined } as never)
    ctx.provide('credentials', { modifyRecord: async (_key: unknown, mutate: (current: unknown) => Promise<unknown>) => mutate(undefined) } as never)
    await ctx.plugin(TypertRegistry)
    await ctx.plugin(RemoteAccessService)
    await ctx.plugin(TypertGatewayService)
    await ctx.plugin({ inject: [...connectionInject], apply: applyConnection })
    await ctx.plugin(HomeAuthService, { secretsDirectory: join(directory, 'secrets', 'home-auth') })
    await new Promise<void>((resolve) => { ctx.inject(['authenticator'], () => { resolve() }) })
    ctx.homeAuth.serve({ listener: LISTENER, address: ADDRESS, factor: 'tailnet-membership' })
    bridge(ctx)
  })
})

afterEach(async () => {
  abort.abort()
  await rm(directory, { recursive: true, force: true })
})

/**
 * Forward the `approval/request` waterfall to the Gateway's event source, as the application's remote-event bridge does.
 * @param ctx - the context holding the Gateway.
 */
function bridge(ctx: Context): void {
  const queue: TypertRemoteEventDispatch[] = []
  let wake: (() => void) | undefined
  const send = (dispatch: TypertRemoteEventDispatch): void => {
    queue.push(dispatch)
    wake?.()
  }
  ctx.effect(() => ctx.typertGateway.registerRemoteEvents(async function* (signal) {
    while (!signal.aborted) {
      while (queue.length > 0) yield queue.shift() as TypertRemoteEventDispatch
      await new Promise<void>((resolve) => {
        wake = resolve
        signal.addEventListener('abort', () => { resolve() }, { once: true })
      })
    }
  }, { home: '/fixture' }))
  ctx.on('approval/request', (request, next) => new Promise((resolve, reject) => {
    send({
      event: 'approval/request',
      request,
      context: { value: ctx.extend({}), subject: request.agent, agentId: request.agent.id },
      resolve: (outcome) => {
        if (outcome.kind === 'result') resolve(outcome.value as ApprovalOutcome)
        else void Promise.resolve().then(next).then(resolve, reject)
      },
      reject,
    })
  }))
}

function authenticator(): HomeAuthAuthenticator {
  const value = w.ctx.authenticator
  if (!(value instanceof HomeAuthAuthenticator)) throw new Error('home-auth did not provide the authenticator')
  return value
}

/** A reach Peer admitted on a signed-in device's session. */
async function phone(fill: number): Promise<PeerScope> {
  const store = new DeviceStore({ file: join(directory, 'secrets', 'home-auth', 'devices.json') })
  if (fill === 2) await w.ctx.homeAuth.claim(claimOf((await w.ctx.homeAuth.issueOwnerCode()).code, { address: brandString<StudioAddress>('http://127.0.0.1:3080') }))
  await store.add(recordOf(fill, ADDRESS))
  const opened = await w.ctx.homeAuth.openSession({ deviceId: recordOf(fill, ADDRESS).id, listener: LISTENER, address: ADDRESS, factor: 'tailnet-membership', lifetimeMs: 3_600_000 })
  const admitted = authenticator().admit({ headers: { cookie: `__Host-delorun-session=${opened.token}` }, method: 'GET', url: '/' } as never, LISTENER)
  if (admitted.kind !== 'admitted') throw new Error('not admitted')
  return admitted.peer
}

/** A client of the Gateway: one open event stream of one Peer. */
interface Client {
  readonly peer: PeerScope
  readonly clientId: unknown
  readonly events: AsyncIterator<unknown>
}

async function connect(peer: PeerScope): Promise<Client> {
  const events = (await w.ctx.typertGateway.wireStream.open('$events', { args: {} }, (async function* () {})(), peer, abort.signal))[Symbol.asyncIterator]()
  const ready = await events.next()
  return { peer, clientId: Reflect.get(ready.value as object, 'clientId'), events }
}

/** Answer the pending event as one client through the shared `/api` channel, as the phone or the computer's page does. */
async function answer(client: Client, eventId: unknown, value: unknown): Promise<unknown> {
  const response = await w.ctx.connection.createSharedFetchHandler('/api').fetch(new Request('http://host/api/$events/result', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      type: 'client-request', rpcId: 'rpc-answer', method: '$events/result',
      payload: { args: { clientId: client.clientId, eventId, outcome: { kind: 'result', value } } },
    }),
  }), client.peer)
  return response.json()
}

/** Ask one question with a run rule and read its pending event on each client. */
async function ask(...clients: Client[]): Promise<{ readonly result: ReturnType<ReturnType<typeof w.relay.onApproval>>, readonly eventId: string }> {
  w.relay.prepareChild(w.child)
  const result = w.relay.onApproval(w.child, new AbortController().signal)(question({ runRule: RULE }))
  let eventId = ''
  for (const client of clients) {
    const frame = (await client.events.next()).value as { readonly eventId: string, readonly request: { readonly runScope?: string } }
    expect(frame.request.runScope).toBe('external-agent-run')
    eventId = frame.eventId
  }
  return { result, eventId }
}

/** What the delegation gate does after an allow-run answer: keep the program's rule beside the seat's lease. */
const keepRule = (): void => { (w.consent as { addRunRule(child: string, rule: typeof RULE): boolean }).addRunRule(w.child.id, RULE) }

const denied = { result: { ok: false, error: { code: 'LOOPBACK_REQUIRED' } } }
const applied = { result: { ok: true } }

describe('the seat relay on the real Gateway and the real reach guard', () => {
  it('refuses a locked phone Allow for this run, keeps the question pending, then takes the computer\'s Allow once', async () => {
    const computer = await connect(w.ctx.connection.browserPeer)
    const locked = await connect(await phone(2))
    const { result, eventId } = await ask(computer, locked)
    expect(await answer(locked, eventId, RUN_ANSWER)).toMatchObject(denied)
    expect(await answer(locked, eventId, 'allowed-once')).toMatchObject(denied)
    expect(w.ctx.typertGateway.getPendingRemoteEvents()).toHaveLength(1)
    expect(w.relay.pendingOf(w.child.id)).toBe(true)
    expect(w.events(w.child, 'approval/decided')).toEqual([])
    expect(await answer(computer, eventId, 'allowed-once')).toMatchObject(applied)
    await expect(result).resolves.toBe('allow-once')
    await new Promise<void>(resolve => { setImmediate(resolve) })
    expect(w.events(w.child, 'external-agent/run-allowed')).toEqual([])
  })

  it('lets the locked phone reject', async () => {
    const locked = await connect(await phone(2))
    const { result, eventId } = await ask(locked)
    expect(await answer(locked, eventId, 'rejected')).toMatchObject(applied)
    await expect(result).resolves.toBe('reject')
    expect(w.events(w.child, 'approval/decided')).toMatchObject([{ outcome: 'rejected' }])
  })

  // Pins A483 for seats on the real Gateway: with the page-unlock lift back, a PIN page's Allow once applies with no grant.
  it('refuses a PIN page\'s Allow once without its grant, then applies it with one, and the computer\'s later Allow for this run changes nothing', async () => {
    const peer = await phone(2)
    const reach = authenticator()['reachPeers'].get(peer.id as never)
    if (reach === undefined) throw new Error('no reach Peer')
    authenticator()['reachPeers'].set(peer.id as never, { ...reach, unlockId: 'page-1' })
    vi.spyOn(w.ctx.homeAuth, 'pageUnlockOf').mockImplementation(() => ({ id: 'page-1' }) as never)
    const computer = await connect(w.ctx.connection.browserPeer)
    const page = await connect(peer)
    const { result, eventId } = await ask(computer, page)
    expect(await answer(page, eventId, 'allowed-once')).toMatchObject(denied)
    expect(w.relay.pendingOf(w.child.id)).toBe(true)
    const grants = w.ctx.homeAuth.faceGrants()
    if (grants === undefined) throw new Error('no grant store')
    grants.mintAnswer({ deviceId: reach.deviceId, listener: reach.listener }, answerKey({ agent: w.child.id, callId: 'call-1', grants: 'external-agent' }), 'allowed-once')
    expect(await answer(page, eventId, 'allowed-once')).toMatchObject(applied)
    await expect(result).resolves.toBe('allow-once')
    // The computer's later answer reaches a finished event and changes nothing.
    expect(await answer(computer, eventId, RUN_ANSWER)).toMatchObject(applied)
    expect(w.events(w.child, 'approval/decided')).toMatchObject([{ outcome: 'allowed-once' }])
    expect(w.events(w.child, 'external-agent/run-allowed')).toEqual([])
  })
  // Pins L110: "Allow for this run" is a face answer. Without the answer grant for exactly this value and prompt, a device's
  // run answer applies, records the run allowance and keeps a rule the person never confirmed.
  it('applies a device\'s Allow for this run only with a Face ID grant for that value and prompt, then records the run once', async () => {
    const peer = await phone(2)
    const reach = authenticator()['reachPeers'].get(peer.id as never)
    if (reach === undefined) throw new Error('no reach Peer')
    const holder = { deviceId: reach.deviceId, listener: reach.listener }
    const computer = await connect(w.ctx.connection.browserPeer)
    const device = await connect(peer)
    const { result, eventId } = await ask(computer, device)
    const grants = w.ctx.homeAuth.faceGrants()
    if (grants === undefined) throw new Error('no grant store')
    const refused = async (): Promise<void> => {
      expect(await answer(device, eventId, RUN_ANSWER)).toMatchObject(denied)
      expect(w.relay.pendingOf(w.child.id)).toBe(true)
      expect(w.events(w.child, 'external-agent/run-allowed')).toEqual([])
      expect(w.kept).toEqual([])
      expect(w.events(w.child, 'approval/decided')).toEqual([])
    }
    await refused()
    // A grant for Allow once, for another chat, for another call, or for another grants marker never answers for this run.
    grants.mintAnswer(holder, answerKey({ agent: w.child.id, callId: 'call-1', grants: 'external-agent' }), 'allowed-once')
    grants.mintAnswer(holder, answerKey({ agent: 'other-chat', callId: 'call-1', grants: 'external-agent' }), RUN_ANSWER)
    grants.mintAnswer(holder, answerKey({ agent: w.child.id, callId: 'call-2', grants: 'external-agent' }), RUN_ANSWER)
    grants.mintAnswer(holder, answerKey({ agent: w.child.id, callId: 'call-1', grants: 'real-browser' }), RUN_ANSWER)
    await refused()
    grants.mintAnswer(holder, answerKey({ agent: w.child.id, callId: 'call-1', grants: 'external-agent' }), RUN_ANSWER)
    expect(await answer(device, eventId, RUN_ANSWER)).toMatchObject(applied)
    await expect(result).resolves.toBe('allow-run')
    keepRule()
    await new Promise<void>(resolve => { setImmediate(resolve) })
    expect(w.events(w.child, 'external-agent/run-allowed')).toHaveLength(1)
  })

  it('applies a PIN page\'s Allow for this run only with its own grant, which Allow once cannot use, and records the run once', async () => {
    const peer = await phone(2)
    const reach = authenticator()['reachPeers'].get(peer.id as never)
    if (reach === undefined) throw new Error('no reach Peer')
    authenticator()['reachPeers'].set(peer.id as never, { ...reach, unlockId: 'page-1' })
    vi.spyOn(w.ctx.homeAuth, 'pageUnlockOf').mockImplementation(() => ({ id: 'page-1' }) as never)
    const computer = await connect(w.ctx.connection.browserPeer)
    const page = await connect(peer)
    const { result, eventId } = await ask(computer, page)
    expect(await answer(page, eventId, RUN_ANSWER)).toMatchObject(denied)
    const grants = w.ctx.homeAuth.faceGrants()
    if (grants === undefined) throw new Error('no grant store')
    grants.mintAnswer({ deviceId: reach.deviceId, listener: reach.listener }, answerKey({ agent: w.child.id, callId: 'call-1', grants: 'external-agent' }), RUN_ANSWER)
    expect(await answer(page, eventId, 'allowed-once')).toMatchObject(denied)
    expect(w.relay.pendingOf(w.child.id)).toBe(true)
    expect(w.events(w.child, 'external-agent/run-allowed')).toEqual([])
    expect(await answer(page, eventId, RUN_ANSWER)).toMatchObject(applied)
    await expect(result).resolves.toBe('allow-run')
    keepRule()
    await new Promise<void>(resolve => { setImmediate(resolve) })
    expect(w.events(w.child, 'external-agent/run-allowed')).toHaveLength(1)
  })
})
