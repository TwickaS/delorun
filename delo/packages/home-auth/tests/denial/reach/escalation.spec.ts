/**
 * A full-access escalation answered from a reach device, end to end. Delo's web composition boots in this process with
 * `@delo/home-auth`; a chat's model asks upstream's `bash` tool to run a command with `sandbox_permissions:
 * danger-full-access`, so the tool's sandbox escalation asks upstream's approval service, whose `approval/request`
 * waterfall the Gateway forwards to the device's event stream. The device runs upstream's Client Remote service over an
 * in-process carrier that calls the studio's shared `/api` channel and event stream with the Peer the authenticator
 * admitted, and its approval answerer says `allowed-once`, as the phone's approval dialog does.
 *
 * - The home refuses that answer with `LOOPBACK_REQUIRED` naming `full-access-escalation`, the device reports it as
 *   `remote/answer-refused` and keeps its event stream, and nothing is granted: the prompt stays pending for the home's
 *   own computer, the session log holds no decision, the command never runs, and the chat's sandbox mode is unchanged.
 * - On the same event stream, an ordinary escalation from `read-only` to `workspace-write` answered `allowed-once` from
 *   the device applies: the decision is logged and the command runs.
 *
 * Each test's comment names the check whose removal makes that test fail.
 */
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { GenerateOptions, LlmAdapter, StreamChunk, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { PeerScope } from '@deepseek-ai/dsh-typert-protocol'
import type { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import type { StudioAddress } from '@delo/contract-admission'
import { FULL_ACCESS_REFUSAL } from '../../../src/authenticator.ts'
import { HomeAuthService } from '../../../src/service.ts'
import { DeviceStore } from '../../../src/devices.ts'
import { claimOf, recordOf } from '../../fixtures/home.ts'
import { bootStudio, type Studio } from '../admission/studio.ts'

const ADDRESS = brandString<StudioAddress>('https://home.example.ts.net')
const LISTENER = 'reach-tailscale-private'
/** The provider route of the scripted model this spec registers. */
const PROVIDER = 'delo-escalation-fixture'
/** The scripted model's id, the one model its route lists. */
const MODEL = 'fixture'
/** The prompt text that makes the scripted model ask for full access; any other prompt asks for `workspace-write`. */
const FULL_ACCESS_PROMPT = 'Write the marker outside the workspace.'

/**
 * Upstream's Client Remote service module. This spec's program is the Host face, which does not compile Client-face
 * modules, so the spec loads it at run time by a specifier the compiler does not resolve and reads it through these
 * members.
 */
interface ClientRemoteModule {
  readonly inject: readonly string[]
  apply(ctx: Context): void
}

/** The members of the device's `ctx.remote` this spec uses. */
interface DeviceRemote {
  $on(event: 'approval/request', listener: (request: { readonly grants?: string }) => Promise<string>): () => void
}

/** The payload of the Client's `remote/answer-refused` event. */
interface AnswerRefusal {
  readonly event: string
  readonly code: string
  readonly message: string
  readonly action: string | undefined
}

/** One generation source the Client Remote service registers with its Connection. */
type GenerationSource = (signal: AbortSignal, ready: (host: { readonly home: string }) => void) => Promise<void>

/** One Remote call's result as the shared `/api` channel returns it. */
type Result =
  | { readonly ok: true; readonly value?: unknown }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string; readonly details: object } }

const usage = { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } } as const

/**
 * A model that answers each request from the conversation so far: after a tool result, or without `bash` on offer, it
 * answers with text; otherwise it calls `bash` with an escalation, to `danger-full-access` for {@link FULL_ACCESS_PROMPT} and to `workspace-write` for
 * any other prompt. It is an object with upstream's `LlmAdapter` members because this package does not depend on
 * `@deepseek-ai/dsh-llm` at run time; each member but `stream` does what the base class does.
 * @param commands - the command each escalation runs.
 * @returns the adapter.
 */
function escalatingModel(commands: { readonly fullAccess: string; readonly workspaceWrite: string }): LlmAdapter {
  async function* stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    // A request that offers no `bash`, such as the chat title's, and a request after the tool ran end with text.
    if (options.messages.at(-1)?.role === 'tool' || !(options.tools ?? []).some(tool => tool.name === 'bash')) {
      yield * [
        { type: 'block-start', index: 0, blockType: 'text' },
        { type: 'text-delta', index: 0, text: 'done' },
        { type: 'block-end', index: 0, block: { type: 'text', text: 'done' } },
        usage,
        { type: 'finish', reason: { kind: 'stop' } },
      ] satisfies StreamChunk[]
      return
    }
    const fullAccess = JSON.stringify(options.messages).includes(FULL_ACCESS_PROMPT)
    const args = JSON.stringify(fullAccess
      ? { command: commands.fullAccess, description: 'Write the marker', sandbox_permissions: 'danger-full-access', justification: 'The marker lives outside the workspace.' }
      : { command: commands.workspaceWrite, description: 'Write the marker', sandbox_permissions: 'workspace-write', justification: 'The marker lives in the workspace.' })
    const id = `call-${String(options.messages.length)}` as ToolCallId
    yield * [
      { type: 'block-start', index: 0, blockType: 'tool-call' },
      { type: 'tool-call-delta', index: 0, id, name: 'bash', argumentsDelta: args },
      { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: 'bash', arguments: args } },
      usage,
      { type: 'finish', reason: { kind: 'tool-calls' } },
    ] satisfies StreamChunk[]
  }
  const resolveModel: LlmAdapter['resolveModel'] = (provider, model) => Promise.resolve({ provider, id: model, name: model })
  return {
    providerInfo: provider => ({ id: provider, name: provider }),
    providerRetryPolicy: () => undefined,
    imageRequestPricing: () => undefined,
    imageRequestTarget: (_provider, _model, image) => ({ width: image.width, height: image.height, maxBytes: image.bytes }),
    listModels: provider => Promise.resolve([{ provider, id: MODEL, name: MODEL }]),
    resolveModel,
    prepareCall: async (provider, model, signal) => ({ model: await resolveModel(provider, model, signal), stream }),
    stream,
  }
}

let studio: Studio
let directory: string
let peer: PeerScope
let workspaceId: WorkspaceId
let workspace: string
let outsideMarker: string
let insideMarker: string
let rpc = 0
/** The device's Client Context, which runs upstream's Client Remote service. */
let phone: Context
/** Stops the device's event generation. */
const phoneGeneration = new AbortController()
/** Every `allowed-once` the device's approval answerer gave, by the request's `grants`. */
const answered: (string | undefined)[] = []
/** Every refusal the device's Client Remote service reported. */
const refusals: AnswerRefusal[] = []

/**
 * Call one Remote method as the given Peer, through the shared `/api` channel.
 * @param endpoint - the `<namespace>/<method>` endpoint.
 * @param args - its named wire arguments.
 * @param as - the Peer the call speaks for.
 * @returns the call's result.
 */
async function call(endpoint: string, args: unknown, as: PeerScope = peer): Promise<Result> {
  rpc += 1
  const response = await studio.ctx.connection.createSharedFetchHandler('/api').fetch(new Request(`http://127.0.0.1/api/${endpoint}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: `escalation-${String(rpc)}`, method: endpoint, payload: args }),
  }), as)
  const body = await response.json() as { readonly result: Result }
  return body.result
}

/**
 * The value of a call that must succeed.
 * @param endpoint - the endpoint.
 * @param args - its named wire arguments.
 * @param as - the Peer the call speaks for.
 * @returns the value.
 */
async function expectAllowed(endpoint: string, args: Record<string, unknown>, as: PeerScope = peer): Promise<unknown> {
  const result = await call(endpoint, { args }, as)
  if (!result.ok) throw new Error(`${endpoint} was refused: ${result.error.code}: ${result.error.message}`)
  return result.value
}

/**
 * Start the device's Client: upstream's Client Remote service over an in-process carrier that reaches the studio's
 * shared `/api` channel and event stream as the device's Peer, with an Agent Context adapter that resolves every chat
 * to the Client root and an approval answerer that allows once, as the phone's approval dialog does when tapped. The
 * Typert registry is reduced to that adapter, the one part of it forwarded events read.
 * @returns once the device's event stream is open.
 */
async function startPhone(): Promise<void> {
  const specifier = '@deepseek-ai/dsh-api-gateway/client'
  // `any` from an unresolved dynamic import: the Host-face program cannot compile the Client face's module.
  const clientRemote: ClientRemoteModule = await import(specifier)
  phone = new Context()
  const agents = { identity: () => undefined, resolve: () => phone }
  phone.provide('typert', { contexts: { getClient: (key: string) => key === 'agent' ? agents : undefined } })
  const sources: GenerationSource[] = []
  phone.provide('connection', {
    interactions: 'answer',
    isLoopback: false,
    remoteMedia: 'load',
    generation: { getSnapshot: () => undefined, subscribe: () => () => {} },
    state: { getSnapshot: () => undefined, subscribe: () => () => {} },
    rpc: {
      call: (_channel: string, endpoint: string, payload: unknown) => call(endpoint, payload),
      open: (_channel: string, endpoint: string, payload: unknown, signal: AbortSignal) => (async function* () {
        yield * await studio.ctx.typertGateway.wireStream.open(endpoint, payload, (async function* () {})(), peer, signal)
      })(),
    },
    openWebSocket: () => { throw new Error('the device uses the in-process carrier') },
    reconnect: () => {},
    registerGenerationSource: (source: GenerationSource) => {
      sources.push(source)
      return () => {}
    },
    start: () => ({ stop: () => {} }),
  })
  await phone.plugin({ inject: [...clientRemote.inject], apply: clientRemote.apply })
  const remote: DeviceRemote = phone.get('remote')
  remote.$on('approval/request', (request) => {
    answered.push(request.grants)
    return Promise.resolve('allowed-once')
  })
  // The Client Remote service declares this event's type; the Host-face program does not compile against it.
  phone.on('remote/answer-refused' as never, ((refusal: AnswerRefusal) => { refusals.push(refusal) }) as never)
  const [source] = sources
  if (source === undefined) throw new Error('the device registered no event generation')
  const ready = Promise.withResolvers<void>()
  void source(phoneGeneration.signal, () => { ready.resolve() }).catch((error: unknown) => { ready.reject(error) })
  await ready.promise
}

/**
 * The live session of a chat.
 * @param sessionId - the chat.
 * @returns its session.
 */
function sessionOf(sessionId: SessionId): Session {
  const session = studio.ctx.sessions.get(sessionId)
  if (session === undefined) throw new Error(`no live session ${sessionId}`)
  return session
}

/**
 * The data of every event of one type a chat logged, in order. The approval service and the sandbox policy declare
 * the types this spec reads; the Host-face program here does not compile against them, so the type is a string.
 * @param sessionId - the chat.
 * @param type - the event type.
 * @returns each event's data.
 */
function logged(sessionId: SessionId, type: string): unknown[] {
  return sessionOf(sessionId).ownEvents().flatMap(event => event.type === type ? [event.data] : [])
}

/**
 * The outcomes the approval service logged in one chat, in order.
 * @param sessionId - the chat.
 * @returns each `approval/decided` outcome.
 */
function decisions(sessionId: SessionId): unknown[] {
  return logged(sessionId, 'approval/decided').map(data => Reflect.get(data as object, 'outcome'))
}

/**
 * Start a chat in the workspace from the device, on the scripted model, which the person selects at the computer.
 * @returns the chat.
 */
async function createChat(): Promise<SessionId> {
  const created = await expectAllowed('session/create', { request: { workspaceId } }) as { readonly sessionId: SessionId }
  await expectAllowed('session/selectModel', { request: { sessionId: created.sessionId, provider: PROVIDER, model: MODEL } }, studio.ctx.connection.browserPeer)
  return created.sessionId
}

/**
 * Send one prompt to a chat from the device.
 * @param sessionId - the chat.
 * @param text - the prompt.
 */
async function prompt(sessionId: SessionId, text: string): Promise<void> {
  await expectAllowed('session/prompt', {
    request: { requestId: `prompt-${String(rpc)}`, sessionId, mode: 'queue', content: [{ type: 'text', text }] },
  })
}

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'delo-reach-escalation-'))
  workspace = join(directory, 'workspace')
  await mkdir(workspace)
  outsideMarker = join(directory, 'outside-marker')
  insideMarker = join(workspace, 'inside-marker')
  studio = await bootStudio()
  const ctx = studio.ctx
  await ctx.plugin(HomeAuthService, { secretsDirectory: join(directory, 'home-auth') })
  await new Promise<void>((resolve) => { ctx.inject(['authenticator', 'workspaceRegistry'], () => { resolve() }) })
  ctx.homeAuth.serve({ listener: LISTENER, address: ADDRESS, factor: 'tailnet-membership' })
  await ctx.homeAuth.claim(claimOf((await ctx.homeAuth.issueOwnerCode()).code, { address: brandString<StudioAddress>('http://127.0.0.1:3080') }))
  const record = recordOf(2, ADDRESS)
  await new DeviceStore({ file: join(directory, 'home-auth', 'devices.json') }).add(record)
  const opened = await ctx.homeAuth.openSession({ deviceId: record.id, listener: LISTENER, address: ADDRESS, factor: 'tailnet-membership', lifetimeMs: 60 * 60 * 1000 })
  const admitted = ctx.authenticator.admit({ headers: { cookie: `__Host-delo-session=${opened.token}` }, method: 'GET', url: '/' }, LISTENER)
  if (admitted.kind !== 'admitted') throw new Error('the device was not admitted')
  peer = admitted.peer
  workspaceId = (await ctx.workspaceRegistry.create(workspace)).id
  ctx.llm.registerAdapter([PROVIDER], escalatingModel({
    fullAccess: `echo granted > ${JSON.stringify(outsideMarker)}`,
    workspaceWrite: `echo applied > ${JSON.stringify(insideMarker)}`,
  }))
  await startPhone()
}, 120_000)

afterAll(async () => {
  phoneGeneration.abort()
  await phone.fiber.dispose()
  await studio.close()
  await rm(directory, { recursive: true, force: true })
})

describe('a sandbox escalation answered from a reach device', () => {
  it('to full access is refused, reported on the device, and leaves nothing granted', async () => {
    const sessionId = await createChat()
    await prompt(sessionId, FULL_ACCESS_PROMPT)
    // Pins `checkAnswer`, the home's `remoteAnswerGuard`: without it the device's `allowed-once` applies, the command runs
    // outside the sandbox and the session logs `allowed-once`.
    await vi.waitFor(() => { expect(refusals).toHaveLength(1) }, { timeout: 20_000 })
    expect(answered).toEqual(['full-access'])
    expect(refusals).toEqual([{ event: 'approval/request', code: 'LOOPBACK_REQUIRED', message: FULL_ACCESS_REFUSAL, action: 'full-access-escalation' }])
    // The prompt stays pending for the home's own computer, and nothing was decided or run.
    expect(studio.ctx.typertGateway.getPendingRemoteEvents()).toEqual([expect.objectContaining({ event: 'approval/request' })])
    expect(decisions(sessionId)).toEqual([])
    expect(existsSync(outsideMarker)).toBe(false)
    expect(logged(sessionId, 'sandbox/mode')).toEqual([{ mode: 'workspace-write' }])

    // Stopping the run withdraws the prompt: the escalation ends cancelled, never granted.
    await expectAllowed('session/cancel', { request: { sessionId } })
    await vi.waitFor(() => { expect(decisions(sessionId)).toEqual(['cancelled']) }, { timeout: 20_000 })
    expect(studio.ctx.typertGateway.getPendingRemoteEvents()).toEqual([])
    expect(existsSync(outsideMarker)).toBe(false)
  }, 60_000)

  it('to workspace-write on the same event stream is answered from the device and applies', async () => {
    const sessionId = await createChat()
    // The chat starts below its escalation target, so the ordinary escalation asks the person. The switch is the event
    // upstream's `setSandboxMode` appends; the sandbox policy declares its type, which this program does not compile.
    const session = sessionOf(sessionId)
    Reflect.apply(session.append, session, ['sandbox/mode', { mode: 'read-only' }])
    await prompt(sessionId, 'Write the marker in the workspace.')
    // Pins the guard's scope: it refuses only a full-access grant, and the device's event stream outlived the refusal.
    await vi.waitFor(() => { expect(decisions(sessionId)).toEqual(['allowed-once']) }, { timeout: 20_000 })
    expect(answered).toEqual(['full-access', undefined])
    expect(refusals).toHaveLength(1)
    await vi.waitFor(async () => { expect(await readFile(insideMarker, 'utf8')).toBe('applied\n') }, { timeout: 20_000 })
    expect(existsSync(outsideMarker)).toBe(false)
  }, 60_000)
})
