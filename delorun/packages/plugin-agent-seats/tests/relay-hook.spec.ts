/**
 * The relay hook's two failure paths, which a real ledger and a real seat state never take: a ledger that fails for a
 * reason other than the wait being aborted, and a seat state that cannot show a waiting question.
 */
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import ApprovalService, { setApprovalPolicy } from '@deepseek-ai/dsh-user-approval'
import { describe, expect, it, onTestFinished } from 'vitest'
import { Config } from '../src/config.ts'
import { seatRelay } from '../src/relay/index.ts'
import type { SeatStateMount } from '../src/state/index.ts'
import { describeSeat } from './state/support.ts'

interface Calls {
  readonly pending: Array<number | undefined>
  readonly notices: Array<{ readonly child: SessionId, readonly kind: string, readonly text: string }>
}

/** A context with the approval service and a seat child, and the hook built over a stand-in state. */
async function hooked(state: Partial<{ recorded: () => Promise<void>, setPending: () => void, notice: () => void, approval: boolean }>) {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  if (state.approval !== false) await ctx.plugin(ApprovalService)
  const session = ctx.sessions.create()
  describeSeat(session)
  session.append('turn/start', { turn: 1 })
  session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'go' }] }), { surfaceOp: 'append' })
  const child = { id: session.id, session } as Agent
  setApprovalPolicy(session, 'ask')
  ctx.provide('externalAgents', { seat: (id: SessionId) => id === child.id ? { child: id, root: id, provider: 'claude-code' } : undefined } as never)
  ctx.provide('agents', { get: () => child, turnBoundaryOf: () => ({ openTurnStartSeq: 1 }) } as never)
  ctx.on('approval/request', () => new Promise<never>(() => {}))
  const calls: Calls = { pending: [], notices: [] }
  const mount = {
    records: { recorded: state.recorded ?? (() => Promise.resolve()) },
    store: {
      viewOf: () => ({ pending: { since: 1 } }),
      providerOf: () => 'claude-code-seat',
      delegationPinned: () => false,
      notice: state.notice ?? ((notified: SessionId, kind: string, text: string) => { calls.notices.push({ child: notified, kind, text }) }),
    },
    setPending: state.setPending ?? ((_child: SessionId, since: number | undefined) => { calls.pending.push(since) }),
  } as unknown as SeatStateMount
  let approver: ReturnType<typeof seatRelay> | undefined
  await ctx.plugin(class {
    constructor(scope: Context) {
      approver = seatRelay({ ctx: scope, state: mount, seatProviders: new Set(['claude-code-seat']), seats: Config(null).seats })
    }
  })
  if (approver === undefined) throw new Error('the hook did not build')
  // The relay notes a call from its event as it commits.
  session.append('tool/call', { turn: 1, step: 1, callId: ToolCallId('call-1'), name: 'claude_code.Bash', arguments: '{}' })
  return { ctx, child, approver, calls }
}

const question = () => ({ callId: 'call-1', toolName: 'Bash', reason: 'Run', signal: new AbortController().signal })

describe('the relay hook', () => {
  it('rejects, asking nobody, when the ledger fails for a reason other than the wait being aborted', async () => {
    const w = await hooked({ recorded: () => Promise.reject(new Error('the ledger is gone')) })
    const answer = await w.approver(w.child, new AbortController().signal)(question())
    expect(answer).toBe('reject')
  })

  it('goes on asking when the seat state cannot show the waiting question', async () => {
    const w = await hooked({ setPending: () => { throw new Error('not a seat child') } })
    const stop = new AbortController()
    const answer = w.approver(w.child, stop.signal)(question())
    await new Promise(resolve => setTimeout(resolve, 0))
    stop.abort()
    await expect(answer).resolves.toBe('cancel')
    expect(w.calls.pending).toEqual([])
  })

  it('tells the chat, rejecting, that it refused a question from a session that is not a seat', async () => {
    const w = await hooked({})
    const other = { id: SessionId('not-a-seat'), session: w.child.session } as Agent
    await expect(w.approver(other, new AbortController().signal)(question())).resolves.toBe('reject')
    expect(w.calls.notices).toEqual([{ child: other.id, kind: 'question-refused', text: expect.stringContaining('not a live agent') }])
  })

  it('tells the chat, rejecting, that it refused a question while no approval service runs', async () => {
    const w = await hooked({ approval: false })
    await expect(w.approver(w.child, new AbortController().signal)(question())).resolves.toBe('reject')
    expect(w.calls.notices).toEqual([{ child: w.child.id, kind: 'question-refused', text: expect.stringContaining('approval service is not running') }])
  })

  it('still rejects when the notice cannot be logged', async () => {
    const w = await hooked({ approval: false, notice: () => { throw new Error('not loaded') } })
    await expect(w.approver(w.child, new AbortController().signal)(question())).resolves.toBe('reject')
  })
})
