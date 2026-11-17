/**
 * The world the relay specs share: a real Session store and approval service, a seat child under a root chat, and the
 * relay over them. The default world answers a question through a stand-in for the gateway; a spec that needs the real
 * gateway passes `prepare`, which installs the path a question travels to the person.
 */
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { type SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import ApprovalService, { setApprovalPolicy, type ApprovalRequest } from '@deepseek-ai/dsh-user-approval'
import type { ProgramApprovalRequest, ProgramRunRule, SeatRecord } from '@delorun/external-agents/contract'
import { onTestFinished } from 'vitest'
import { RunScope, SeatRelay, type SeatRelayOptions } from '../src/relay/index.ts'

/** Who answers: the home's computer, a PIN-unlocked page, a code-unlocked phone, or a locked phone. */
export type Peer = 'computer' | 'pin-page' | 'code-phone' | 'locked-phone'

/** A refusal as the gateway sees it. */
export class LoopbackRequired extends Error {
  readonly code = 'LOOPBACK_REQUIRED'
}

/**
 * The reach rule for the `external-agent` marker: any value but a refusal grants; only the computer and a PIN-unlocked
 * page may give it.
 * @param peer - who answers.
 * @param value - the raw answer.
 */
export function guard(peer: Peer, value: unknown): void {
  if (value === 'rejected' || value === 'cancelled' || value === 'unavailable') return
  if (peer === 'computer' || peer === 'pin-page') return
  throw new LoopbackRequired('This needs you at your computer')
}

export interface Waiting {
  readonly request: ApprovalRequest
  readonly resolve: (value: never) => void
  settled: boolean
}

export interface World {
  readonly ctx: Context
  readonly relay: SeatRelay
  readonly root: Agent
  readonly child: Agent
  readonly waiting: Waiting[]
  readonly openTurns: Set<string>
  readonly sandbox: Map<string, string>
  readonly consent: Record<string, unknown>
  /** The rules the stand-in consent kept, as the real consent keeps them beside a lease. */
  readonly kept: ProgramRunRule[]
  /** Whether the stand-in consent still holds the child's lease. */
  leased: boolean
  readonly recorded: Map<string, () => void>
  readonly seats: Map<string, SeatRecord>
  readonly descriptors: Map<string, string>
  readonly events: (agent: Agent, type: string) => Array<Record<string, unknown>>
  /** Answer the latest pending question as a client; returns whether the gateway applied it. */
  answer(peer: Peer, value: unknown, which?: number): 'applied' | 'ignored'
}

/**
 * An agent with a real Session and an open turn.
 * @param ctx - the context holding the session store.
 * @returns the agent.
 */
export function agentOf(ctx: Context): Agent {
  const session = ctx.sessions.create()
  session.append('turn/start', { turn: 1 })
  session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'go' }] }), { surfaceOp: 'append' })
  return { id: session.id, session } as Agent
}

/**
 * The relay over a real approval service and a stand-in gateway.
 * @param rootPolicy - the root chat's approval policy.
 * @param mountListener - whether the run-scope listener is mounted.
 * @param prepare - installs the path a question travels to the person in place of the stand-in gateway.
 */
export async function world(rootPolicy: 'ask' | 'never' = 'ask', mountListener = true, prepare?: (ctx: Context) => Promise<void>): Promise<World> {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(ApprovalService)
  const root = agentOf(ctx)
  const child = agentOf(ctx)
  setApprovalPolicy(root.session, rootPolicy)
  setApprovalPolicy(child.session, 'never')
  const seats = new Map<string, SeatRecord>([[child.id, { child: child.id, root: root.id, provider: 'claude-code' }]])
  const descriptors = new Map<string, string>([[child.id, 'agent-seat']])
  const agents = new Map<string, Agent>([[root.id, root], [child.id, child]])
  ctx.provide('externalAgents', { seat: (id: SessionId) => seats.get(id) } as never)
  const openTurns = new Set<string>([root.id, child.id])
  const sandbox = new Map<string, string>([[root.id, rootPolicy === 'never' ? 'danger-full-access' : 'workspace-write']])
  ctx.provide('agents', { get: (id: string) => agents.get(id), turnBoundaryOf: (session: { id: string }) => ({ openTurnStartSeq: openTurns.has(session.id) ? 1 : null }) } as never)
  const kept: ProgramRunRule[] = []
  const lease = { held: true }
  const consent: Record<string, unknown> = {
    fullAccessStartsAgents: () => true,
    runRules: () => [...kept],
    addRunRule: (_child: SessionId, rule: ProgramRunRule) => lease.held && kept.push(rule) > 0,
  }
  ctx.provide('delegationConsent', consent as never)
  ctx.provide('sandboxPolicy', { resolve: ({ session }: { session: { id: string } }) => ({ mode: sandbox.get(session.id) ?? 'workspace-write' }), overrideOf: () => undefined } as never)
  const recorded = new Map<string, () => void>()
  const options: SeatRelayOptions = {
    seatProviders: new Set(['agent-seat']),
    descriptorOf: agent => descriptors.get(agent.id),
    recorded: (_agent, callId) => new Promise<void>((resolve) => { recorded.set(callId, resolve); resolve() }),
    recordName: (_agent, toolName) => `claude_code.${toolName}`,
  }
  let relay: SeatRelay | undefined
  await ctx.plugin(class { constructor(scope: Context) { relay = new SeatRelay(scope, options, mountListener ? new RunScope() : new UnmountedRunScope()) } })
  if (relay === undefined) throw new Error('relay not built')
  const log = new Map<string, Array<{ type: string, data: Record<string, unknown> }>>()
  ctx.on('session/event', (session, event) => {
    log.set(session.id, [...log.get(session.id) ?? [], { type: event.type, data: { ...event.data } }])
  })
  const waiting: Waiting[] = []
  if (prepare === undefined) ctx.on('approval/request', request => new Promise((resolve) => { waiting.push({ request, resolve, settled: false }) }))
  else await prepare(ctx)
  const events = (agent: Agent, type: string): Array<Record<string, unknown>> => {
    return (log.get(agent.id) ?? []).filter(event => event.type === type).map(event => ({ ...event.data }))
  }
  return {
    ctx, relay, root, child, waiting, openTurns, sandbox, consent, kept, recorded, seats, descriptors, events,
    get leased() { return lease.held },
    set leased(value: boolean) { lease.held = value },
    answer(peer, value, which = waiting.length - 1) {
      const entry = waiting[which]
      if (entry === undefined) throw new Error('no question is pending')
      guard(peer, value)
      if (entry.settled) return 'ignored'
      entry.settled = true
      entry.resolve(value as never)
      return 'applied'
    },
  }
}

/** A run-scope state whose listener is not registered. */
export class UnmountedRunScope extends RunScope {
  override mount(): () => boolean { return () => false }
}

/** A question from the program. */
export function question(overrides: Partial<ProgramApprovalRequest> = {}): ProgramApprovalRequest {
  return { callId: 'call-1', toolName: 'Bash', reason: 'Run `npm test`', signal: new AbortController().signal, ...overrides }
}

export const RULE = { provider: 'claude-code', summary: 'Run `npm test`', data: { rule: 'Bash(npm test)' } } as const

/** Let queued promise work finish. */
export const settle = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0))
