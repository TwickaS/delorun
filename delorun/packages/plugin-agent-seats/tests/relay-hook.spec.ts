/**
 * The relay hook's two failure paths, which a real ledger and a real seat state never take: a ledger that fails for a
 * reason other than the wait being aborted, and a seat state that cannot show a waiting question.
 */
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import SessionStore, { type SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import ApprovalService, { setApprovalPolicy } from '@deepseek-ai/dsh-user-approval'
import { describe, expect, it, onTestFinished } from 'vitest'
import { Config } from '../src/config.ts'
import { seatRelay } from '../src/relay/index.ts'
import type { SeatStateMount } from '../src/state/index.ts'
import { describeSeat } from './state/support.ts'

interface Calls {
  readonly pending: Array<number | undefined>
}

/** A context with the approval service and a seat child, and the hook built over a stand-in state. */
async function hooked(state: Partial<{ recorded: () => Promise<void>, setPending: () => void }>) {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(ApprovalService)
  const session = ctx.sessions.create()
  describeSeat(session)
  session.append('turn/start', { turn: 1 })
  session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'go' }] }), { surfaceOp: 'append' })
  session.append('tool/call', { turn: 1, step: 1, callId: ToolCallId('call-1'), name: 'claude_code.Bash', arguments: '{}' })
  const child = { id: session.id, session } as Agent
  setApprovalPolicy(session, 'ask')
  ctx.provide('externalAgents', { seat: (id: SessionId) => id === child.id ? { child: id, root: id, provider: 'claude-code' } : undefined } as never)
  ctx.provide('agents', { get: () => child, turnBoundaryOf: () => ({ openTurnStartSeq: 1 }) } as never)
  ctx.on('approval/request', () => new Promise<never>(() => {}))
  const calls: Calls = { pending: [] }
  const mount = {
    records: { recorded: state.recorded ?? (() => Promise.resolve()) },
    store: { viewOf: () => ({ pending: { since: 1 } }) },
    setPending: state.setPending ?? ((_child: SessionId, since: number | undefined) => { calls.pending.push(since) }),
  } as unknown as SeatStateMount
  let approver: ReturnType<typeof seatRelay> | undefined
  await ctx.plugin(class {
    constructor(scope: Context) {
      approver = seatRelay({ ctx: scope, state: mount, seatProviders: new Set(['claude-code-seat']), seats: Config(null).seats })
    }
  })
  if (approver === undefined) throw new Error('the hook did not build')
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
})
