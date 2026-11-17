/**
 * The `agentSeat` projection on upstream's real Session store and projection registry: the view of a seat child, the
 * states the log moves it through, the same value after a restore and a fork, and a stable view reference.
 */
import { createAssistantMessage } from '@deepseek-ai/dsh-llm'
import { appendPluginRecord, SessionLogOffset, type Session, type SessionEvent } from '@deepseek-ai/dsh-session'
import { describe, expect, it } from 'vitest'
import {
  agentSeatProjection, DEFAULT_OWN_SETTINGS, foldSeat, NO_LOGGED, NO_SHOWN, SEAT_NOTICE_RECORD, SEAT_STATE_RECORD, SEAT_STATUS_RECORD,
  seatStateSchema, type AgentSeatView, type SeatProjectionState,
} from '../../src/state/index.ts'
import { describeSeat, sessionContext } from './support.ts'

async function host() {
  const ctx = await sessionContext()
  const handle = await ctx.sessionProjections.register(agentSeatProjection())
  const session = ctx.sessions.create()
  const events: SessionEvent[] = []
  const view = (target: Session = session): AgentSeatView | null | undefined => ctx.sessionProjections.snapshot(target).values.agentSeat
  const assistant = (turn: number, content: Parameters<typeof createAssistantMessage>[0]['content']) => {
    session.append('assistant/message', {
      turn, step: 1, stream: [], message: createAssistantMessage({ content, source: { provider: 'test', model: 'test' } }),
    }, { surfaceOp: 'append' })
  }
  return { ctx, handle, session, events, view, assistant }
}

describe('the agentSeat view', () => {
  it('is null in a chat that is not a seat child', async () => {
    const h = await host()
    expect(h.view()).toBeNull()
    appendPluginRecord(h.session, SEAT_STATUS_RECORD, { state: 'working' })
    expect(h.view()).toBeNull()
  })

  it('names the agent from the child\'s descriptor, with the sandbox off and no state until the program speaks', async () => {
    const h = await host()
    describeSeat(h.session, 'codex-seat')
    expect(h.view()).toEqual({ agent: 'codex', ownSettings: DEFAULT_OWN_SETTINGS, sandbox: 'off', state: 'idle' })
  })

  it('ignores a descriptor of any other provider', async () => {
    const h = await host()
    describeSeat(h.session, 'tool-subagent')
    expect(h.view()).toBeNull()
  })

  it('moves through starting, working and idle, and keeps the program\'s version and settings once told', async () => {
    const h = await host()
    describeSeat(h.session)
    appendPluginRecord(h.session, SEAT_STATUS_RECORD, { state: 'starting', version: '2.1.4', ownSettings: 'accept edits' })
    expect(h.view()).toEqual({ agent: 'claude-code', version: '2.1.4', ownSettings: 'accept edits', sandbox: 'off', state: 'starting' })
    appendPluginRecord(h.session, SEAT_STATUS_RECORD, { state: 'working' })
    expect(h.view()).toMatchObject({ state: 'working', version: '2.1.4', ownSettings: 'accept edits' })
    h.session.append('turn/start', { turn: 1 })
    h.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    expect(h.view()?.state).toBe('idle')
  })

  it('is working from a turn\'s start', async () => {
    const h = await host()
    describeSeat(h.session)
    h.session.append('turn/start', { turn: 1 })
    expect(h.view()?.state).toBe('working')
  })

  it('shows a reached limit with its reset time past the turn\'s end, until the next turn starts', async () => {
    const h = await host()
    describeSeat(h.session)
    h.session.append('turn/start', { turn: 1 })
    appendPluginRecord(h.session, SEAT_STATUS_RECORD, { state: 'limit', resetAt: 1_790_000_000_000 })
    h.session.append('turn/end', { turn: 1, reason: { kind: 'error', error: { message: 'limit', code: 'EXTERNAL_AGENT_LIMIT' } } })
    expect(h.view()).toMatchObject({ state: 'limit', resetAt: 1_790_000_000_000 })
    h.session.append('turn/start', { turn: 2 })
    expect(h.view()?.state).toBe('working')
    expect(h.view()?.resetAt).toBeUndefined()
  })

  it('shows a signed-out program and an ended seat past the turn\'s end', async () => {
    const h = await host()
    describeSeat(h.session)
    appendPluginRecord(h.session, SEAT_STATUS_RECORD, { state: 'not-signed-in' })
    h.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    expect(h.view()?.state).toBe('not-signed-in')
    appendPluginRecord(h.session, SEAT_STATUS_RECORD, { state: 'ended', endedReason: 'The chat was archived.' })
    expect(h.view()).toMatchObject({ state: 'ended', endedReason: 'The chat was archived.' })
  })

  it('offers the plan\'s models while a model is needed', async () => {
    const h = await host()
    describeSeat(h.session)
    const modelPicker = { offered: [{ id: 'gpt-5.6-luna', label: 'GPT 5.6 Luna' }], planDefault: 'gpt-5.6-luna' }
    appendPluginRecord(h.session, SEAT_STATUS_RECORD, { state: 'model-needed', modelPicker })
    expect(h.view()).toMatchObject({ state: 'model-needed', modelPicker })
    appendPluginRecord(h.session, SEAT_STATUS_RECORD, { state: 'idle' })
    expect(h.view()?.modelPicker).toBeUndefined()
  })

  it('shows that a question waits, and clears it at the turn\'s end', async () => {
    const h = await host()
    describeSeat(h.session)
    appendPluginRecord(h.session, SEAT_STATUS_RECORD, { state: 'working', pending: 1_790_000_000_000 })
    expect(h.view()?.pending).toEqual({ since: 1_790_000_000_000 })
    h.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    expect(h.view()?.pending).toBeUndefined()
  })

  it('keeps the final answer of the latest finished step, not a message that calls a tool', async () => {
    const h = await host()
    describeSeat(h.session)
    h.assistant(1, [{ type: 'text', text: 'Looking.' }, { type: 'tool-call', id: 'call-1' as never, name: 'claude_code.Bash', arguments: '{}' }])
    expect(h.view()?.lastAnswer).toBeUndefined()
    h.assistant(1, [{ type: 'text', text: 'Done: three files.' }])
    expect(h.view()?.lastAnswer).toBe('Done: three files.')
  })

  it('keeps the same view reference when only the state record changes', async () => {
    const h = await host()
    describeSeat(h.session)
    const definition = agentSeatProjection()
    const seated = foldSeat(definition.init(h.session.header, h.session.inheritedEventCount), h.session.snapshotEvents()[0] as SessionEvent)
    const before = definition.wire.view(seated)
    appendPluginRecord(h.session, SEAT_STATE_RECORD, { programSessionId: 'program-1', cursor: 'm1' })
    appendPluginRecord(h.session, SEAT_NOTICE_RECORD, { kind: 'unrecorded-work', text: 'x' })
    const events = h.session.snapshotEvents()
    const recorded = events.slice(1).reduce(foldSeat, seated)
    expect(recorded).not.toBe(seated)
    expect(definition.wire.view(recorded)).toBe(before)
    expect(h.handle.stateOf(h.session).logged).toEqual({ programSessionId: 'program-1', cursor: 'm1', programMessageId: null })
  })

  it('reads a malformed stored record as absent fields', async () => {
    const h = await host()
    describeSeat(h.session)
    appendPluginRecord(h.session, SEAT_STATE_RECORD, { programSessionId: 7 as never, cursor: 'm1' })
    appendPluginRecord(h.session, SEAT_STATUS_RECORD, { state: 'limit', resetAt: 'soon' as never, modelPicker: { offered: [{ id: 3 }, { id: 'a', label: 'A' }], planDefault: 'a' } as never })
    expect(h.handle.stateOf(h.session).logged).toEqual({ programSessionId: null, cursor: 'm1', programMessageId: null })
    expect(h.view()).toMatchObject({ state: 'limit', modelPicker: { offered: [{ id: 'a', label: 'A' }], planDefault: 'a' } })
    expect(h.view()?.resetAt).toBeUndefined()
    appendPluginRecord(h.session, SEAT_STATUS_RECORD, { state: 'working', modelPicker: { planDefault: 'a' } as never })
    expect(h.view()?.modelPicker).toBeUndefined()
  })
})

describe('the seat fold', () => {
  it('returns the same state for events that concern no seat', async () => {
    const h = await host()
    describeSeat(h.session)
    const state = h.handle.stateOf(h.session)
    h.session.append('step/start', { turn: 1, step: 1 })
    expect(h.handle.stateOf(h.session)).toBe(state)
  })

  it('tracks the newest message id for a fresh program session to skip', async () => {
    const h = await host()
    describeSeat(h.session)
    const first = createAssistantMessage({ content: [{ type: 'text', text: 'a' }], source: { provider: 'test', model: 'test' } })
    h.session.append('assistant/message', { turn: 1, step: 1, stream: [], message: first }, { surfaceOp: 'append' })
    expect(h.handle.stateOf(h.session).tail).toBe(first.id)
  })

  it('has no seat in a fork, whose inherited events are not its own', async () => {
    const h = await host()
    describeSeat(h.session)
    appendPluginRecord(h.session, SEAT_STATE_RECORD, { programSessionId: 'program-1', cursor: 'm1' })
    appendPluginRecord(h.session, SEAT_STATUS_RECORD, { state: 'working' })
    const fork = h.ctx.sessions.fork(h.session)
    expect(h.view(fork)).toBeNull()
    expect(h.handle.stateOf(fork).logged).toEqual(NO_LOGGED)
  })

  it('computes the same value after a checkpoint restore as from the full log', async () => {
    const h = await host()
    h.session.append('subagent/descriptor', { version: 3, mode: 'continuable', provider: 'codex-seat', label: 'task' })
    h.events.push(...h.session.snapshotEvents())
    const checkpoint = h.ctx.sessionProjections.checkpoint(h.session)
    appendPluginRecord(h.session, SEAT_STATE_RECORD, { programSessionId: 'program-1', cursor: 'm1' })
    appendPluginRecord(h.session, SEAT_STATUS_RECORD, { state: 'limit', resetAt: 5 })
    h.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    const events = h.session.snapshotEvents()
    const restored = h.ctx.sessionProjections.restore(checkpoint, events.slice(h.events.length), SessionLogOffset(h.events.length), h.session.header, h.session.inheritedEventCount)
    expect(restored.snapshot.values.agentSeat).toEqual(h.view())
    expect(h.view()).toMatchObject({ agent: 'codex', state: 'limit', resetAt: 5 })
  })

  it('accepts its own state as a stored checkpoint', () => {
    const state: SeatProjectionState = { inherited: 0, tail: null, logged: NO_LOGGED, shown: NO_SHOWN }
    expect(seatStateSchema.parse(state)).toEqual(state)
    expect(() => seatStateSchema.parse({ ...state, extra: 1 })).toThrow()
    expect(foldSeat(state, { type: 'step/start', seq: 5, time: 0, data: { turn: 1, step: 1 } } as SessionEvent)).toBe(state)
  })
})
