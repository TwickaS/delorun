/**
 * Specs of the seat review (`reviewSeat`): the shared rules on the root and the creator, where the card is asked, the
 * lease and its reuse, every event that ends a lease, and the run rules kept beside it.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { ApprovalOutcome, ApprovalRequest } from '@deepseek-ai/dsh-user-approval'
import type { SeatLease, SeatLeaseEnd, SeatReview, SeatReviewPhase } from '@delorun/external-agents/contract'
import { DELEGATION_CONSENT_ROW_ID } from '@delorun/external-agents/contract'
import { afterEach, describe, expect, it } from 'vitest'
import { DelorunDelegationConsent } from '../src/index.ts'
import { archivedRefusal, leaseEndedRefusal, noOpenTurnRefusal, notApprovedRefusal } from '../src/copy.ts'
import { changeGrantStore, grantStorePath } from '../src/store.ts'
import { DELEGATION_CONSENT_ROW } from '../src/wire.ts'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** A fresh home and two workspace folders. */
function folders(): { home: string, workspace: string, other: string } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'delorun-seat-consent-')))
  roots.push(root)
  const paths = { home: join(root, 'home'), workspace: join(root, 'work'), other: join(root, 'other') }
  for (const path of Object.values(paths)) mkdirSync(path, { recursive: true })
  return paths
}

/**
 * A chat.
 * @param id - its Session id.
 * @param cwd - its folder.
 * @param parent - the chat that created it, for a subagent.
 */
function chat(id: string, cwd: string | undefined, parent?: string): Agent {
  const header = parent === undefined ? { cwd } : { cwd, origin: 'subagent', parentSession: SessionId(parent) }
  return { id: SessionId(id), session: { id: SessionId(id), header } } as never
}

interface World {
  readonly ctx: Context
  readonly consent: DelorunDelegationConsent
  readonly asks: ApprovalRequest[]
  readonly ended: Array<{ lease: SeatLease, reason: SeatLeaseEnd }>
  readonly readOnly: Set<string>
  readonly openTurns: Set<string>
  readonly policies: Map<string, 'ask' | 'never'>
  readonly archived: SessionId[]
  readonly listed: string[]
  readonly agents: Agent[]
  readonly home: string
  readonly workspace: string
  readonly other: string
  answer: ApprovalOutcome
}

/** The service with fake neighbours that each spec changes. */
async function world(): Promise<World> {
  const paths = folders()
  const ctx = new Context()
  const state = {
    asks: [] as ApprovalRequest[],
    ended: [] as Array<{ lease: SeatLease, reason: SeatLeaseEnd }>,
    readOnly: new Set<string>(),
    openTurns: new Set<string>(['root']),
    policies: new Map<string, 'ask' | 'never'>(),
    archived: [] as SessionId[],
    listed: [paths.workspace],
    agents: [] as Agent[],
    answer: 'allowed-once' as ApprovalOutcome,
  }
  ctx.provide('sandboxPolicy', { resolve: ({ session }: { session: { id: string } }) => ({ mode: state.readOnly.has(session.id) ? 'read-only' : 'workspace-write' }) } as never)
  ctx.provide('approval', {
    request: (request: ApprovalRequest) => {
      state.asks.push(request)
      return Promise.resolve(state.policies.get(request.agent.id) === 'never' ? 'rejected' : state.answer)
    },
    config: { policy: 'ask' },
    overrideOf: (session: { id: string }) => state.policies.get(session.id),
  } as never)
  ctx.provide('agents', {
    get: (id: string) => state.agents.find(agent => agent.id === id),
    turnBoundaryOf: (session: { id: string }) => ({ openTurnStartSeq: state.openTurns.has(session.id) ? 1 : null }),
  } as never)
  ctx.provide('workspaceRegistry', {
    get archivedSessionIds() { return state.archived },
    list: () => state.listed.map(path => ({ path })),
  } as never)
  await ctx.plugin(DelorunDelegationConsent, { timeoutMs: () => 1_800_000, env: { DELORUN_HOME: paths.home }, now: () => 7 })
  const consent = ctx.get('delegationConsent') as DelorunDelegationConsent
  consent.onLeaseEnded((lease, reason) => { state.ended.push({ lease, reason }) })
  return Object.assign(state, { ctx, consent, ...paths })
}

/**
 * A seat review of the child `seat` under `root`.
 * @param w - the world.
 * @param phase - when it runs.
 * @param change - facts to change.
 */
function seat(w: World, phase: SeatReviewPhase, change: Partial<Omit<SeatReview, 'phase'>> = {}): SeatReview {
  const root = change.root ?? chat('root', w.workspace)
  return {
    provider: 'claude-code',
    creator: root,
    root,
    child: chat('seat', w.workspace, root.id),
    cwd: w.workspace,
    label: 'Fix the tests',
    phase,
    signal: new AbortController().signal,
    ...change,
  }
}

/** Record a grant straight into the home's grants file. */
async function grant(home: string, workspace: string, provider = 'claude-code'): Promise<void> {
  await changeGrantStore(grantStorePath(home), grants => [...grants, { workspace, provider, grantedAt: 5 }])
}

describe('a seat review at hand-off', () => {
  it('asks once on the root\'s open turn with the external-agent marker and records a lease', async () => {
    const w = await world()
    await expect(w.consent.reviewSeat(seat(w, 'hand-off'))).resolves.toEqual({ kind: 'allow', timeoutMs: 1_800_000 })
    expect(w.asks).toHaveLength(1)
    expect(w.asks[0]).toMatchObject({ toolName: 'claude-code', grants: 'external-agent' })
    expect(w.asks[0]?.agent.id).toBe('root')
    expect(w.consent.leaseOf(SessionId('seat'))).toEqual({
      child: 'seat', root: 'root', workspace: w.workspace, cwd: w.workspace, provider: 'claude-code', workspaceListed: true, grantedAt: 7,
    })
  })

  it('allows a granted workspace without a card and records a lease', async () => {
    const w = await world()
    await grant(w.home, w.workspace)
    w.openTurns.clear()
    await expect(w.consent.reviewSeat(seat(w, 'hand-off'))).resolves.toMatchObject({ kind: 'allow' })
    expect(w.asks).toEqual([])
    expect(w.consent.leaseOf(SessionId('seat'))).toBeDefined()
  })

  it('refuses a read-only root, even with a grant and a writable creator', async () => {
    const w = await world()
    await grant(w.home, w.workspace)
    w.readOnly.add('root')
    const verdict = await w.consent.reviewSeat(seat(w, 'hand-off', { creator: chat('lead', w.workspace, 'root') }))
    expect(verdict).toMatchObject({ kind: 'refuse', reason: expect.stringContaining('this chat runs read-only') })
    expect(w.asks).toEqual([])
  })

  it('refuses a read-only creator under a writable root', async () => {
    const w = await world()
    w.readOnly.add('lead')
    const verdict = await w.consent.reviewSeat(seat(w, 'hand-off', { creator: chat('lead', w.workspace, 'root') }))
    expect(verdict).toMatchObject({ kind: 'refuse', reason: expect.stringContaining('this chat runs read-only') })
    expect(w.asks).toEqual([])
  })

  it('refuses a root whose policy is never without a card, unless a grant exists', async () => {
    const w = await world()
    w.policies.set('root', 'never')
    await expect(w.consent.reviewSeat(seat(w, 'hand-off'))).resolves.toEqual({ kind: 'refuse', reason: notApprovedRefusal('claude-code', 'never', w.workspace) })
    await expect(w.consent.reviewSeat(seat(w, 'resume'))).resolves.toMatchObject({ kind: 'refuse' })
    expect(w.asks).toEqual([])
    await grant(w.home, w.workspace)
    await expect(w.consent.reviewSeat(seat(w, 'hand-off'))).resolves.toMatchObject({ kind: 'allow' })
  })

  it('refuses at hand-off when the root has no open turn, naming the fixed way forward', async () => {
    const w = await world()
    w.openTurns.clear()
    w.openTurns.add('seat')
    await expect(w.consent.reviewSeat(seat(w, 'hand-off'))).resolves.toEqual({ kind: 'refuse', reason: noOpenTurnRefusal('claude-code', w.workspace) })
    expect(w.asks).toEqual([])
  })

  it('asks a grandchild\'s seat on the root\'s open turn, and refuses it when the root has none', async () => {
    const w = await world()
    const lead = chat('lead', w.workspace, 'root')
    w.agents.push(chat('root', w.workspace), lead)
    const grandchild = { creator: lead, child: chat('seat', w.workspace, 'lead') }
    await expect(w.consent.reviewSeat(seat(w, 'hand-off', grandchild))).resolves.toMatchObject({ kind: 'allow' })
    expect(w.asks.map(ask => ask.agent.id)).toEqual(['root'])
    w.consent.endLease(SessionId('seat'), 'revoked')
    w.openTurns.clear()
    w.openTurns.add('lead')
    await expect(w.consent.reviewSeat(seat(w, 'hand-off', grandchild))).resolves.toEqual({ kind: 'refuse', reason: noOpenTurnRefusal('claude-code', w.workspace) })
    expect(w.asks).toHaveLength(1)
  })

  it.each([
    ['no workspace', (w: World) => seat(w, 'hand-off', { root: chat('root', undefined) }), 'has no workspace folder'],
    ['a run folder outside the workspace', (w: World) => seat(w, 'hand-off', { cwd: w.other }), 'is outside it'],
  ])('refuses %s without asking', async (_case, review, text) => {
    const w = await world()
    await expect(w.consent.reviewSeat(review(w))).resolves.toMatchObject({ kind: 'refuse', reason: expect.stringContaining(text) })
    expect(w.asks).toEqual([])
  })

  it('refuses without a sandbox policy, before anything else', async () => {
    const w = await world()
    const bare = new Context()
    bare.provide('approval', w.ctx.get('approval') as never)
    await bare.plugin(DelorunDelegationConsent, { timeoutMs: () => 1, env: { DELORUN_HOME: w.home }, now: () => 1 })
    const consent = bare.get('delegationConsent') as DelorunDelegationConsent
    await expect(consent.reviewSeat(seat(w, 'hand-off'))).resolves.toMatchObject({ kind: 'refuse', reason: expect.stringContaining('no sandbox policy') })
  })

  it('refuses when the grants file cannot be read, so no grant counts', async () => {
    const w = await world()
    mkdirSync(grantStorePath(w.home), { recursive: true })
    await expect(w.consent.reviewSeat(seat(w, 'hand-off'))).resolves.toMatchObject({ kind: 'refuse', reason: expect.stringContaining('cannot be read') })
    expect(w.asks).toEqual([])
  })

  it.each(['rejected', 'cancelled', 'unavailable'] as const)('refuses and records no lease when the card ends %s', async (outcome) => {
    const w = await world()
    w.answer = outcome
    await expect(w.consent.reviewSeat(seat(w, 'hand-off'))).resolves.toMatchObject({ kind: 'refuse' })
    expect(w.consent.leaseOf(SessionId('seat'))).toBeUndefined()
  })

  it('refuses a seat whose child, root or a chat between them is archived', async () => {
    const w = await world()
    const lead = chat('lead', w.workspace, 'root')
    w.agents.push(lead)
    w.archived.push(SessionId('lead'))
    const verdict = await w.consent.reviewSeat(seat(w, 'hand-off', { creator: lead, child: chat('seat', w.workspace, 'lead') }))
    expect(verdict).toEqual({ kind: 'refuse', reason: archivedRefusal('claude-code') })
    expect(w.asks).toEqual([])
  })
})

describe('a seat review at resume', () => {
  it('reuses the lease after the child\'s cold resume without a card', async () => {
    const w = await world()
    await w.consent.reviewSeat(seat(w, 'hand-off'))
    w.openTurns.clear()
    await expect(w.consent.reviewSeat(seat(w, 'resume'))).resolves.toMatchObject({ kind: 'allow' })
    await expect(w.consent.reviewSeat(seat(w, 'turn'))).resolves.toMatchObject({ kind: 'allow' })
    expect(w.asks).toHaveLength(1)
  })

  it('asks on the seat child when the root has no open turn and no lease holds', async () => {
    const w = await world()
    w.openTurns.clear()
    w.openTurns.add('seat')
    await expect(w.consent.reviewSeat(seat(w, 'resume'))).resolves.toMatchObject({ kind: 'allow' })
    expect(w.asks.map(ask => ask.agent.id)).toEqual(['seat'])
  })
})

describe('a seat turn', () => {
  it('never asks: without a lease it refuses with the fixed sentence', async () => {
    const w = await world()
    await expect(w.consent.reviewSeat(seat(w, 'turn'))).resolves.toEqual({ kind: 'refuse', reason: leaseEndedRefusal('claude-code') })
    expect(w.asks).toEqual([])
  })

  it('ends the lease when the root turned read-only since the last turn', async () => {
    const w = await world()
    await w.consent.reviewSeat(seat(w, 'hand-off'))
    w.readOnly.add('root')
    await expect(w.consent.reviewSeat(seat(w, 'turn'))).resolves.toMatchObject({ kind: 'refuse' })
    expect(w.ended.map(end => end.reason)).toEqual(['refused'])
    expect(w.consent.leaseOf(SessionId('seat'))).toBeUndefined()
  })

  it.each([
    ['root', (w: World) => seat(w, 'turn', { root: chat('root-2', w.workspace), creator: chat('root-2', w.workspace) })],
    ['workspace', (w: World) => seat(w, 'turn', { root: chat('root', w.other), creator: chat('root', w.other), cwd: w.other })],
    ['run folder', (w: World) => seat(w, 'turn', { cwd: join(w.workspace, 'sub') })],
    ['agent', (w: World) => seat(w, 'turn', { provider: 'codex' })],
  ])('drops the lease when its %s changed', async (_field, changed) => {
    const w = await world()
    mkdirSync(join(w.workspace, 'sub'))
    await w.consent.reviewSeat(seat(w, 'hand-off'))
    await expect(w.consent.reviewSeat(changed(w))).resolves.toMatchObject({ kind: 'refuse' })
    expect(w.ended.map(end => end.reason)).toEqual(['refused'])
    expect(w.consent.leaseOf(SessionId('seat'))).toBeUndefined()
  })

  it('drops the lease once its listed workspace is removed from the list', async () => {
    const w = await world()
    await w.consent.reviewSeat(seat(w, 'hand-off'))
    w.listed.splice(0)
    await expect(w.consent.reviewSeat(seat(w, 'turn'))).resolves.toMatchObject({ kind: 'refuse' })
    expect(w.ended.map(end => end.reason)).toEqual(['refused'])
  })

  it('drops the lease once a chat between the root and the child is archived', async () => {
    const w = await world()
    const lead = chat('lead', w.workspace, 'root')
    w.agents.push(lead)
    const below = { creator: lead, child: chat('seat', w.workspace, 'lead') }
    await w.consent.reviewSeat(seat(w, 'hand-off', below))
    w.archived.push(SessionId('lead'))
    await expect(w.consent.reviewSeat(seat(w, 'turn', below))).resolves.toEqual({ kind: 'refuse', reason: archivedRefusal('claude-code') })
    expect(w.ended.map(end => end.reason)).toEqual(['refused'])
  })
})

describe('the end of a lease', () => {
  it.each(['seat', 'root'])('ends when the %s is archived', async (archived) => {
    const w = await world()
    await w.consent.reviewSeat(seat(w, 'hand-off'))
    await w.ctx.parallel('workspace/session-archived', { sessionId: SessionId(archived) })
    expect(w.ended.map(end => end.reason)).toEqual(['archived'])
    expect(w.consent.leaseOf(SessionId('seat'))).toBeUndefined()
  })

  it('ends when the person revokes it', async () => {
    const w = await world()
    await w.consent.reviewSeat(seat(w, 'hand-off'))
    w.consent.endLease(SessionId('seat'), 'revoked')
    expect(w.ended.map(end => end.reason)).toEqual(['revoked'])
    await expect(w.consent.reviewSeat(seat(w, 'turn'))).resolves.toMatchObject({ kind: 'refuse' })
  })

  it('ends when the workspace grant for that agent is revoked, and only then', async () => {
    const w = await world()
    await grant(w.home, w.workspace)
    await w.consent.reviewSeat(seat(w, 'hand-off'))
    await w.consent.revoke({ workspace: w.workspace, provider: 'codex' })
    expect(w.ended).toEqual([])
    await w.consent.revoke({ workspace: w.workspace, provider: 'claude-code' })
    expect(w.ended.map(end => end.reason)).toEqual(['grant-revoked'])
  })

  it('ends every lease when the consent stops', async () => {
    const w = await world()
    await w.consent.reviewSeat(seat(w, 'hand-off'))
    await w.consent.reviewSeat(seat(w, 'hand-off', { child: chat('seat-2', w.workspace, 'root') }))
    await w.ctx.fiber.dispose()
    expect(w.ended.map(end => [end.lease.child, end.reason])).toEqual([['seat', 'consent-off'], ['seat-2', 'consent-off']])
  })

  it('keeps run rules beside the lease and drops them with it', async () => {
    const w = await world()
    const rule = { provider: 'claude-code', summary: 'Run npm test', data: { rule: 'Bash(npm test)' } } as const
    expect(w.consent.addRunRule(SessionId('seat'), rule)).toBe(false)
    expect(w.consent.runRules(SessionId('seat'))).toEqual([])
    await w.consent.reviewSeat(seat(w, 'hand-off'))
    expect(w.consent.addRunRule(SessionId('seat'), rule)).toBe(true)
    expect(w.consent.runRules(SessionId('seat'))).toEqual([rule])
    await w.ctx.parallel('workspace/session-archived', { sessionId: SessionId('root') })
    expect(w.consent.runRules(SessionId('seat'))).toEqual([])
    await w.consent.reviewSeat(seat(w, 'hand-off'))
    expect(w.consent.runRules(SessionId('seat'))).toEqual([])
  })
})

describe('the consent row id the gate reads', () => {
  it('is the row bundle-local inserts', () => {
    expect(DELEGATION_CONSENT_ROW_ID).toBe(DELEGATION_CONSENT_ROW)
  })
})
