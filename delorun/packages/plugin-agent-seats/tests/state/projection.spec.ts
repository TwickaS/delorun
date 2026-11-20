/**
 * The `agentSeat` projection on upstream's real Session store and projection registry: the view of a seat child, the
 * states the log moves it through, the same value after a restore and a fork, and a stable view reference.
 */
import { createAssistantMessage } from '@deepseek-ai/dsh-llm'
import { buildForkSeed, SessionId, SessionLogOffset, SessionSeq, type Session, type SessionEvent } from '@deepseek-ai/dsh-session'
import { describe, expect, it } from 'vitest'
import {
  agentSeatProjection, DEFAULT_OWN_SETTINGS, foldSeat, NO_LOGGED, NO_SHOWN, SEAT_NOTICE_EVENT, SEAT_STATE_EVENT, SEAT_STATUS_EVENT,
  SeatRecords, seatStateSchema, type AgentSeatView, type SeatProjectionState,
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

describe('the descriptor provider and the delegation pin the relay reads', () => {
  it('reads the child\'s own descriptor provider, any provider included, and none before one', async () => {
    const h = await host()
    const store = new SeatRecords(h.ctx.sessions, h.handle)
    expect(store.providerOf(h.session.header.id)).toBeUndefined()
    describeSeat(h.session, 'tool-subagent')
    expect(store.providerOf(h.session.header.id)).toBe('tool-subagent')
    describeSeat(h.session, 'codex-seat')
    expect(store.providerOf(h.session.header.id)).toBe('codex-seat')
    expect(store.providerOf(SessionId('not-loaded'))).toBeUndefined()
  })

  it('ignores a descriptor a fork inherited, so a fork of a seat has no provider of its own', async () => {
    const h = await host()
    describeSeat(h.session)
    const events = h.session.snapshotEvents()
    const seed = buildForkSeed(events, SessionSeq(events.length - 1))
    const fork = h.ctx.sessions.create(undefined, { seed, inheritedEventCount: SessionLogOffset(seed.length), meta: { isSeeded: true } })
    expect(new SeatRecords(h.ctx.sessions, h.handle).providerOf(fork.header.id)).toBeUndefined()
  })

  it('reports the pin while the delegation pin is the latest approval policy, and not after a switch or a lift', async () => {
    const h = await host()
    const store = new SeatRecords(h.ctx.sessions, h.handle)
    const child = h.session.header.id
    expect(store.delegationPinned(child)).toBe(false)
    h.session.append('approval/policy', { policy: 'never', source: 'delegation' })
    expect(store.delegationPinned(child)).toBe(true)
    h.session.append('approval/policy', { policy: 'ask' })
    expect(store.delegationPinned(child)).toBe(false)
    h.session.append('approval/policy', { policy: 'never', source: 'delegation' })
    expect(store.delegationPinned(child)).toBe(true)
    h.session.append('approval/policy', { policy: 'never', source: 'delegation' })
    expect(store.delegationPinned(child)).toBe(true)
  })
})

describe('the agentSeat view', () => {
  it('is null in a chat that is not a seat child', async () => {
    const h = await host()
    expect(h.view()).toBeNull()
    h.session.append(SEAT_STATUS_EVENT, { state: 'working' })
    expect(h.view()).toBeNull()
  })

  it('names the agent from the child\'s descriptor, with no sandbox claim and no state until the program speaks', async () => {
    const h = await host()
    describeSeat(h.session, 'codex-seat')
    expect(h.view()).toEqual({ agent: 'codex', ownSettings: DEFAULT_OWN_SETTINGS, state: 'idle' })
  })

  it('ignores a descriptor of any other provider', async () => {
    const h = await host()
    describeSeat(h.session, 'tool-subagent')
    expect(h.view()).toBeNull()
  })

  it('moves through starting, working and idle, and keeps the program\'s version and settings once told', async () => {
    const h = await host()
    describeSeat(h.session)
    h.session.append(SEAT_STATUS_EVENT, { state: 'starting', version: '2.1.4', ownSettings: 'accept edits' })
    expect(h.view()).toEqual({ agent: 'claude-code', version: '2.1.4', ownSettings: 'accept edits', state: 'starting' })
    h.session.append(SEAT_STATUS_EVENT, { state: 'working', sandbox: 'on' })
    expect(h.view()).toMatchObject({ state: 'working', version: '2.1.4', ownSettings: 'accept edits', sandbox: 'on' })
    h.session.append(SEAT_STATUS_EVENT, { state: 'idle' })
    expect(h.view()).toMatchObject({ sandbox: 'on' })
    h.session.append(SEAT_STATUS_EVENT, { state: 'starting' })
    expect(h.view()?.sandbox).toBeUndefined()
    h.session.append(SEAT_STATUS_EVENT, { state: 'working', sandbox: 'off' })
    expect(h.view()).toMatchObject({ sandbox: 'off' })
    h.session.append(SEAT_STATUS_EVENT, { state: 'working', sandbox: 'own' })
    expect(h.view()).toMatchObject({ sandbox: 'own' })
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
    h.session.append(SEAT_STATUS_EVENT, { state: 'limit', resetAt: 1_790_000_000_000 })
    h.session.append('turn/end', { turn: 1, reason: { kind: 'error', error: { message: 'limit', code: 'EXTERNAL_AGENT_LIMIT' } } })
    expect(h.view()).toMatchObject({ state: 'limit', resetAt: 1_790_000_000_000 })
    h.session.append('turn/start', { turn: 2 })
    expect(h.view()?.state).toBe('working')
    expect(h.view()?.resetAt).toBeUndefined()
  })

  it('shows a signed-out program and an ended seat past the turn\'s end', async () => {
    const h = await host()
    describeSeat(h.session)
    h.session.append(SEAT_STATUS_EVENT, { state: 'not-signed-in' })
    h.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    expect(h.view()?.state).toBe('not-signed-in')
    h.session.append(SEAT_STATUS_EVENT, { state: 'ended', endedReason: 'The chat was archived.' })
    expect(h.view()).toMatchObject({ state: 'ended', endedReason: 'The chat was archived.' })
  })

  it('offers the plan\'s models while a model is needed', async () => {
    const h = await host()
    describeSeat(h.session)
    const modelPicker = { offered: [{ id: 'gpt-5.6-luna', label: 'GPT 5.6 Luna' }], planDefault: 'gpt-5.6-luna' }
    h.session.append(SEAT_STATUS_EVENT, { state: 'model-needed', modelPicker })
    expect(h.view()).toMatchObject({ state: 'model-needed', modelPicker })
    h.session.append(SEAT_STATUS_EVENT, { state: 'idle' })
    expect(h.view()?.modelPicker).toBeUndefined()
  })

  it('shows that a question waits, and clears it at the turn\'s end', async () => {
    const h = await host()
    describeSeat(h.session)
    h.session.append(SEAT_STATUS_EVENT, { state: 'working', pending: 1_790_000_000_000 })
    expect(h.view()?.pending).toEqual({ since: 1_790_000_000_000 })
    h.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    expect(h.view()?.pending).toBeUndefined()
  })

  it('counts the finished turns of the seat child, past a sticky state and not before the first', async () => {
    const h = await host()
    describeSeat(h.session)
    expect(h.view()?.turns).toBeUndefined()
    h.session.append('turn/start', { turn: 1 })
    expect(h.view()?.turns).toBeUndefined()
    h.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    expect(h.view()?.turns).toBe(1)
    h.session.append(SEAT_STATUS_EVENT, { state: 'not-signed-in' })
    h.session.append('turn/end', { turn: 2, reason: { kind: 'completed' } })
    expect(h.view()).toMatchObject({ state: 'not-signed-in', turns: 2 })
  })

  it('counts no turn of a chat that is not a seat child, and none a fork inherited', async () => {
    const h = await host()
    h.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    expect(h.view()).toBeNull()
    const state: SeatProjectionState = { inherited: 9, tail: null, provider: null, pinned: false, logged: NO_LOGGED, shown: { ...NO_SHOWN, agent: 'codex' } }
    expect(foldSeat(state, { type: 'turn/end', seq: 3, time: 0, data: { turn: 1, reason: { kind: 'completed' } } } as SessionEvent)).toBe(state)
  })

  it('keeps the view reference across an event that changes nothing shown, and replaces it at a turn\'s end', async () => {
    const h = await host()
    describeSeat(h.session)
    const definition = agentSeatProjection()
    const seated = h.session.snapshotEvents().reduce(foldSeat, definition.init(h.session.header, h.session.inheritedEventCount))
    const ended = foldSeat(seated, { type: 'turn/end', seq: 5, time: 0, data: { turn: 1, reason: { kind: 'completed' } } } as SessionEvent)
    expect(definition.wire.view(ended)).not.toBe(definition.wire.view(seated))
    expect(definition.wire.view(ended)).toMatchObject({ turns: 1 })
    const stepped = foldSeat(ended, { type: 'step/start', seq: 6, time: 0, data: { turn: 2, step: 1 } } as SessionEvent)
    expect(definition.wire.view(stepped)).toBe(definition.wire.view(ended))
  })

  it('keeps the final answer of the latest finished step, not a message that calls a tool', async () => {
    const h = await host()
    describeSeat(h.session)
    h.assistant(1, [{ type: 'text', text: 'Looking.' }, { type: 'tool-call', id: 'call-1' as never, name: 'claude_code.Bash', arguments: '{}' }])
    expect(h.view()?.lastAnswer).toBeUndefined()
    h.assistant(1, [{ type: 'text', text: 'Done: three files.' }])
    expect(h.view()?.lastAnswer).toBe('Done: three files.')
  })

  it('keeps the same view reference when only the state event changes', async () => {
    const h = await host()
    describeSeat(h.session)
    const definition = agentSeatProjection()
    const seated = foldSeat(definition.init(h.session.header, h.session.inheritedEventCount), h.session.snapshotEvents()[0] as SessionEvent)
    const before = definition.wire.view(seated)
    h.session.append(SEAT_STATE_EVENT, { programSessionId: 'program-1', cursor: 'm1' })
    h.session.append(SEAT_NOTICE_EVENT, { kind: 'unrecorded-work', text: 'x' })
    const events = h.session.snapshotEvents()
    const recorded = events.slice(1).reduce(foldSeat, seated)
    expect(recorded).not.toBe(seated)
    expect(definition.wire.view(recorded)).toBe(before)
    expect(h.handle.stateOf(h.session).logged).toEqual({ programSessionId: 'program-1', cursor: 'm1', programMessageId: null })
  })

  it('reads a malformed stored event as absent fields', async () => {
    const h = await host()
    describeSeat(h.session)
    h.session.append(SEAT_STATE_EVENT, { programSessionId: 7 as never, cursor: 'm1' })
    h.session.append(SEAT_STATUS_EVENT, { state: 'limit', resetAt: 'soon' as never, modelPicker: { offered: [{ id: 3 }, { id: 'a', label: 'A' }], planDefault: 'a' } as never })
    expect(h.handle.stateOf(h.session).logged).toEqual({ programSessionId: null, cursor: 'm1', programMessageId: null })
    expect(h.view()).toMatchObject({ state: 'limit', modelPicker: { offered: [{ id: 'a', label: 'A' }], planDefault: 'a' } })
    expect(h.view()?.resetAt).toBeUndefined()
    h.session.append(SEAT_STATUS_EVENT, { state: 'working', modelPicker: { planDefault: 'a' } as never })
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
    h.session.append(SEAT_STATE_EVENT, { programSessionId: 'program-1', cursor: 'm1' })
    h.session.append(SEAT_STATUS_EVENT, { state: 'working' })
    const fork = h.ctx.sessions.fork(h.session)
    expect(h.view(fork)).toBeNull()
    expect(h.handle.stateOf(fork).logged).toEqual(NO_LOGGED)
  })

  it('computes the same value after a checkpoint restore as from the full log', async () => {
    const h = await host()
    h.session.append('subagent/descriptor', { version: 3, mode: 'continuable', provider: 'codex-seat', label: 'task' })
    h.events.push(...h.session.snapshotEvents())
    const checkpoint = h.ctx.sessionProjections.checkpoint(h.session)
    h.session.append(SEAT_STATE_EVENT, { programSessionId: 'program-1', cursor: 'm1' })
    h.session.append(SEAT_STATUS_EVENT, { state: 'limit', resetAt: 5 })
    h.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    const events = h.session.snapshotEvents()
    const restored = h.ctx.sessionProjections.restore(checkpoint, events.slice(h.events.length), SessionLogOffset(h.events.length), h.session.header, h.session.inheritedEventCount)
    expect(restored.snapshot.values.agentSeat).toEqual(h.view())
    expect(h.view()).toMatchObject({ agent: 'codex', state: 'limit', resetAt: 5 })
  })

  it('accepts its own state as a stored checkpoint', () => {
    const state: SeatProjectionState = { inherited: 0, tail: null, provider: null, pinned: false, logged: NO_LOGGED, shown: NO_SHOWN }
    expect(seatStateSchema.parse(state)).toEqual(state)
    expect(() => seatStateSchema.parse({ ...state, extra: 1 })).toThrow()
    expect(foldSeat(state, { type: 'step/start', seq: 5, time: 0, data: { turn: 1, step: 1 } } as SessionEvent)).toBe(state)
  })
})

describe('the logged program state', () => {
  it('reads a program session without a cursor, and a cursor without a program session', async () => {
    const h = await host()
    describeSeat(h.session)
    const store = new SeatRecords(h.ctx.sessions, h.handle)
    const child = h.session.header.id
    expect(store.read(child)).toBeUndefined()
    store.write(child, { programSessionId: 'program-1' })
    expect(store.read(child)).toEqual({ programSessionId: 'program-1' })
    store.write(child, { cursor: 'm1' })
    expect(store.read(child)).toEqual({ cursor: 'm1' })
  })

  it('keeps the program\'s last message only for the program session it was read from', async () => {
    const h = await host()
    describeSeat(h.session)
    const store = new SeatRecords(h.ctx.sessions, h.handle)
    const child = h.session.header.id
    store.recordProgramMessage(child, 'last-1')
    expect(store.stateOf(child).logged).toMatchObject({ programSessionId: null, cursor: null, programMessageId: 'last-1' })
    store.write(child, { programSessionId: 'program-1', cursor: 'm1' })
    store.recordProgramMessage(child, 'last-2')
    store.write(child, { programSessionId: 'program-1', cursor: 'm2' })
    expect(store.stateOf(child).logged).toMatchObject({ programSessionId: 'program-1', cursor: 'm2', programMessageId: 'last-2' })
    store.write(child, { programSessionId: 'program-2' })
    expect(store.stateOf(child).logged.programMessageId).toBeNull()
  })

  it('has no cursor to keep when it drops the program of a chat with no message yet', async () => {
    const h = await host()
    describeSeat(h.session)
    const store = new SeatRecords(h.ctx.sessions, h.handle)
    const child = h.session.header.id
    store.write(child, { programSessionId: 'program-1' })
    store.clearProgram(child)
    expect(store.read(child)).toBeUndefined()
  })
})

describe('a question that waits while the seat shows a state with details', () => {
  it.each([
    ['a reached limit', 'limit', { resetAt: 1_790_000_000_000 }],
    ['an ended seat', 'ended', { endedReason: 'The chat was archived.' }],
    ['a model to pick', 'model-needed', { modelPicker: { offered: [{ id: 'a', label: 'A' }], planDefault: 'a' } }],
  ] as const)('keeps the details of %s', async (_label, state, change) => {
    const h = await host()
    describeSeat(h.session)
    const store = new SeatRecords(h.ctx.sessions, h.handle)
    const child = h.session.header.id
    store.setStatus(child, state, change)
    store.setPending(child, 5)
    expect(h.view()).toMatchObject({ state, pending: { since: 5 }, ...change })
  })

  it('refuses a chat that is not a seat child', async () => {
    const h = await host()
    expect(() => { new SeatRecords(h.ctx.sessions, h.handle).setPending(h.session.header.id, 5) }).toThrow('is not a seat child')
  })
})

describe('records the log may hold in a shape the fold did not write', () => {
  it('ignores a status record without a state', async () => {
    const h = await host()
    describeSeat(h.session)
    h.session.append(SEAT_STATUS_EVENT, { state: 'working' })
    h.session.append(SEAT_STATUS_EVENT, {} as never)
    expect(h.view()?.state).toBe('working')
  })

  it('skips an offered model that is not an object, and one with no name', async () => {
    const h = await host()
    describeSeat(h.session)
    const modelPicker = { offered: [null, { id: 'a' }, { id: 'b', label: 'B' }], planDefault: 'b' }
    h.session.append(SEAT_STATUS_EVENT, { state: 'model-needed', modelPicker } as never)
    expect(h.view()?.modelPicker).toEqual({ offered: [{ id: 'b', label: 'B' }], planDefault: 'b' })
  })

  it('reads the last answer from the text of a message that also holds reasoning', async () => {
    const h = await host()
    describeSeat(h.session)
    h.session.append('turn/start', { turn: 1 })
    h.assistant(1, [{ type: 'reasoning', text: 'thinking' }, { type: 'text', text: 'Done.' }])
    h.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    expect(h.view()?.lastAnswer).toBe('Done.')
  })

  it('reads the same descriptor again without changing the seat', async () => {
    const h = await host()
    describeSeat(h.session)
    const before = h.view()
    describeSeat(h.session)
    expect(h.view()).toEqual(before)
  })
})

/** A fresh Context and registry over a Session rebuilt from a log's JSON, as a restart reads it from disk. */
async function restartFrom(session: Session, events: readonly SessionEvent[] = session.snapshotEvents()) {
  const next = await sessionContext()
  const handle = await next.sessionProjections.register(agentSeatProjection())
  const seed = JSON.parse(JSON.stringify(events)) as SessionEvent[]
  const restored = next.sessions.prepare(session.header.id, { seed, meta: structuredClone(session.header), inheritedEventCount: SessionLogOffset(0), eventState: 'detached' })
  return { next, handle, restored }
}

describe('a seat child restarted from its serialised log', () => {
  it('rebuilds the same view and the same logged state', async () => {
    const h = await host()
    describeSeat(h.session)
    const store = new SeatRecords(h.ctx.sessions, h.handle)
    const child = h.session.header.id
    store.setStatus(child, 'starting', { version: '2.1.4', ownSettings: 'accept edits', sandbox: 'on' })
    store.setAccount(child, { plan: 'Max', fiveHourPercent: 40, weeklyPercent: 10, fiveHourResetAt: 1_790_000_000_000 })
    h.session.append('turn/start', { turn: 1 })
    h.assistant(1, [{ type: 'text', text: 'Done: three files.' }])
    store.write(child, { programSessionId: 'program-1', cursor: 'm1' })
    store.recordProgramMessage(child, 'program-message-7')
    h.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    store.setStatus(child, 'model-needed', { modelPicker: { offered: [{ id: 'a', label: 'A' }], planDefault: 'a' } })
    store.setPending(child, 5)
    store.notice(child, 'unresumable', 'The earlier conversation could not be resumed.')
    const { handle, restored, next } = await restartFrom(h.session)
    expect(next.sessionProjections.snapshot(restored).values.agentSeat).toEqual(h.view())
    expect(h.view()).toMatchObject({ state: 'model-needed', plan: 'Max', turns: 1, lastAnswer: 'Done: three files.', pending: { since: 5 } })
    expect(handle.stateOf(restored)).toEqual(h.handle.stateOf(h.session))
    expect(handle.stateOf(restored).logged).toEqual({ programSessionId: 'program-1', cursor: 'm1', programMessageId: 'program-message-7' })
  })

  it('writes the three events with no ignorable marker, so a reader that does not know them refuses the log', async () => {
    const h = await host()
    describeSeat(h.session)
    const store = new SeatRecords(h.ctx.sessions, h.handle)
    const child = h.session.header.id
    store.setStatus(child, 'idle')
    store.write(child, { programSessionId: 'program-1' })
    store.notice(child, 'model-chosen', 'x')
    const written = h.session.snapshotEvents().filter(event => event.type.startsWith('external-agent/'))
    expect(written.map(event => event.type)).toEqual(['external-agent/status', 'external-agent/state', 'external-agent/notice'])
    expect(written.map(event => event.ignorable)).toEqual([undefined, undefined, undefined])
  })
})

describe('a log written by an earlier preview with the seat\'s plugin records', () => {
  const oldRecord = (seq: number, name: string, data: unknown): SessionEvent => ({ type: `plugin:delorun/agent-seat/${name}`, seq, time: 1, data, ignorable: true } as never)

  it('reads without error and shows none of the state the old records held, only that of the typed events after them', async () => {
    const h = await host()
    describeSeat(h.session)
    const descriptor = h.session.snapshotEvents()
    const seed: SessionEvent[] = [
      ...descriptor,
      oldRecord(descriptor.length, 'status', { state: 'limit', resetAt: 5000, plan: 'Max' }),
      oldRecord(descriptor.length + 1, 'state', { programSessionId: 'old-program', cursor: 'm0' }),
      oldRecord(descriptor.length + 2, 'notice', { kind: 'unresumable', text: 'old' }),
      { type: 'turn/start', seq: descriptor.length + 3, time: 1, data: { turn: 1 } },
      { type: SEAT_STATUS_EVENT, seq: descriptor.length + 4, time: 1, data: { state: 'limit', resetAt: 9 } },
    ] as SessionEvent[]
    const { next, handle, restored: old } = await restartFrom(h.session, seed)
    const view = (): AgentSeatView | null | undefined => next.sessionProjections.snapshot(old).values.agentSeat
    expect(handle.stateOf(old).logged).toEqual(NO_LOGGED)
    expect(view()).toMatchObject({ state: 'limit', resetAt: 9 })
    expect(view()?.plan).toBeUndefined()
  })
})
