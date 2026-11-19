/**
 * The mounted seat state over the seat adapter and a scripted program: the view's states while a turn runs, the
 * logged program session and cursor, a reached limit with its Resume route, the model pick, a program that cannot be
 * resumed, parting detection, Stop, and the `seatPrograms` service.
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { appendPluginRecord, pluginRecordOf, SessionId, type Session } from '@deepseek-ai/dsh-session'
import { GateRefusedError, ProgramOpenError } from '@delorun/external-agents/contract'
import { describe, expect, it } from 'vitest'
import {
  CHOOSE_MODEL_PATH, FileModelChoices, loadModelChoices, MODEL_CHOICES_FILE, RESUME_PATH, SEAT_NOTICE_RECORD, SEAT_STATE_RECORD, SEAT_STATUS_RECORD,
  type SeatRoute,
} from '../../src/state/index.ts'
import { collect, finishOf } from '../adapter/support.ts'
import { describeSeat, ScriptedProgram, stateWorld, until, type StateWorld } from './support.ts'
import type { SeatStateOptions } from '../../src/state/index.ts'

const tick = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0))

const view = (w: StateWorld) => w.mount.store.viewOf(w.child)

/** The plugin records of one type in the child's log. */
const records = (w: StateWorld, type: string) =>
  w.session.snapshotEvents().flatMap((event) => {
    const record = pluginRecordOf(event)
    return record?.type === type ? [record.data] : []
  })

/** Finish the program's turn so a stream ends. */
async function finishTurn(w: StateWorld, running: Promise<unknown>): Promise<void> {
  w.gate.latest.emit({ kind: 'turn-end', outcome: 'completed' })
  await running
}

/** Run a whole turn of a program that just answers. */
async function turn(w: StateWorld, messages: Parameters<StateWorld['request']>[0]) {
  const running = collect(w.adapter.stream(w.request(messages)))
  await tick()
  w.gate.latest.emit({ kind: 'turn-end', outcome: 'completed' })
  return running
}

const post = (route: SeatRoute | undefined, body: unknown) => {
  if (route === undefined) throw new Error('route missing')
  return route.fetch(new Request('http://delorun.test/', { method: 'POST', body: JSON.stringify(body) }))
}
const routeOf = (w: StateWorld, path: string) => w.mount.routes.find(route => route.path === path)

describe('while a turn runs', () => {
  it('records whether the program\'s own sandbox was on at its start, and shows nothing before then', async () => {
    const w = await stateWorld()
    const program = new ScriptedProgram()
    program.sandbox = 'on'
    const before: Array<string | undefined> = []
    w.gate.next = () => {
      before.push(view(w)?.sandbox)
      return program
    }
    const running = collect(w.adapter.stream(w.request([w.say('task')])))
    await tick()
    expect(before).toEqual([undefined])
    expect(view(w)).toMatchObject({ state: 'working', sandbox: 'on' })
    await finishTurn(w, running)

    const again = await stateWorld()
    const running2 = collect(again.adapter.stream(again.request([again.say('task')])))
    await tick()
    expect(view(again)?.sandbox).toBe('off')
    await finishTurn(again, running2)
  })

  it('shows "Starting" while the program spawns and "Working" once it answered', async () => {
    const w = await stateWorld({ info: () => ({ version: '2.1.4', ownSettings: 'accept edits' }) })
    const states: Array<string | undefined> = []
    w.gate.next = () => {
      states.push(view(w)?.state)
      return new ScriptedProgram()
    }
    const task = w.say('task')
    const running = collect(w.adapter.stream(w.request([task])))
    await tick()
    expect(states).toEqual(['starting'])
    expect(view(w)).toMatchObject({ agent: 'claude-code', state: 'working', version: '2.1.4', ownSettings: 'accept edits', sandbox: 'off' })
    await finishTurn(w, running)
  })

  it.each([
    ['nothing is known', {}, {}],
    ['only the plan is known', { plan: 'Max' }, { plan: 'Max' }],
    ['every figure is known', { plan: 'Max', fiveHourPercent: 42, weeklyPercent: 7, fiveHourResetAt: 1_000 }, { plan: 'Max', fiveHourPercent: 42, weeklyPercent: 7, fiveHourResetAt: 1_000 }],
  ])('shows the account figures when %s, keeping the state it is in', async (_name, figures, shown) => {
    const w = await stateWorld({ account: () => Promise.resolve(figures) })
    const running = collect(w.adapter.stream(w.request([w.say('task')])))
    await tick()
    await tick()
    const current = view(w)
    expect(current).toMatchObject({ state: 'working', ...shown })
    for (const key of ['plan', 'fiveHourPercent', 'weeklyPercent', 'fiveHourResetAt'] as const) {
      if (!(key in shown)) expect(current?.[key]).toBeUndefined()
    }
    await finishTurn(w, running)
  })

  it('logs the account figures once while they stay the same', async () => {
    const w = await stateWorld({ account: () => Promise.resolve({ plan: 'Pro' }) })
    const running = collect(w.adapter.stream(w.request([w.say('task')])))
    await tick()
    await tick()
    const before = records(w, SEAT_STATUS_RECORD).length
    w.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    await tick()
    await tick()
    expect(records(w, SEAT_STATUS_RECORD)).toHaveLength(before)
    await finishTurn(w, running)
  })

  it('reports figures that cannot be read and shows none', async () => {
    const w = await stateWorld({ account: () => Promise.reject(new Error('store unreadable')) })
    const running = collect(w.adapter.stream(w.request([w.say('task')])))
    await tick()
    await tick()
    expect(w.warnings.join('\n')).toContain('store unreadable')
    expect(view(w)?.plan).toBeUndefined()
    await finishTurn(w, running)
  })

  it.each([
    ['a refusal of the gate', new GateRefusedError({ category: 'consent', reason: 'The person declined.' })],
    ['a failure to open the program', new ProgramOpenError({ category: 'program', detail: 'it crashed' })],
  ])('ends the "Starting" state when the start ends in %s', async (_name, failure) => {
    const w = await stateWorld()
    w.gate.failure = failure
    await collect(w.adapter.stream(w.request([w.say('task')])))
    const states = records(w, SEAT_STATUS_RECORD).map(record => (record as { state: string }).state)
    expect(states.at(-1)).toBe('idle')
    expect(view(w)?.state).not.toBe('starting')
  })

  it('logs the program session and the cursor, and the next adapter resumes from them', async () => {
    const w = await stateWorld()
    w.gate.next = () => new ScriptedProgram('program-1')
    const first = w.say('task')
    await turn(w, [first])
    expect(w.mount.store.read(w.child)).toEqual({ programSessionId: 'program-1', cursor: first.id })
    expect(records(w, SEAT_STATE_RECORD).at(-1)).toEqual({ programSessionId: 'program-1', cursor: first.id })
    await w.adapter.release(w.child)
    const second = w.say('next')
    const next = collect(w.adapter.stream(w.request([first, second])))
    await tick()
    expect(w.gate.starts[1]).toMatchObject({ resume: 'program-1' })
    expect(w.gate.latest.sent).toEqual([{ text: 'next', mode: 'start' }])
    await finishTurn(w, next)
  })
})

describe('a reached plan limit', () => {
  it('puts back the state the chat had when a start ends without a program, so an ended chat stays ended', async () => {
    const w = await stateWorld()
    w.mount.store.setStatus(w.child, 'ended', { endedReason: 'The chat was archived.' })
    w.gate.failure = new GateRefusedError({ category: 'consent', reason: 'The person declined.' })
    await collect(w.adapter.stream(w.request([w.say('task')])))
    expect(view(w)).toMatchObject({ state: 'ended', endedReason: 'The chat was archived.' })
  })

  it.each([
    ['a limit with its reset time', 'limit', { resetAt: 9000 }],
    ['a model pick that is still needed', 'model-needed', { modelPicker: { offered: [{ id: 'm', label: 'M' }], planDefault: 'm' } }],
  ] as const)('puts back %s when a start ends without a program', async (_name, state, change) => {
    const w = await stateWorld()
    w.mount.store.setStatus(w.child, state, change)
    w.gate.failure = new GateRefusedError({ category: 'consent', reason: 'The person declined.' })
    await collect(w.adapter.stream(w.request([w.say('task')])))
    expect(view(w)).toMatchObject({ state, ...change })
  })

  it('falls back to idle when the start ended from a chat that already showed Starting', async () => {
    const w = await stateWorld()
    w.mount.store.setStatus(w.child, 'starting')
    w.gate.failure = new GateRefusedError({ category: 'consent', reason: 'The person declined.' })
    await collect(w.adapter.stream(w.request([w.say('task')])))
    expect(view(w)?.state).toBe('idle')
  })

  it('ends the turn with the reset time and starts nothing until the person asks', async () => {
    let clock = 1000
    const w = await stateWorld({ now: () => clock })
    w.gate.failure = new GateRefusedError({ category: 'limit', window: 'five_hour', resetsAt: 2000 })
    const chunks = await collect(w.adapter.stream(w.request([w.say('task')])))
    expect(finishOf(chunks)).toMatchObject({ kind: 'error', failure: { code: 'EXTERNAL_AGENT_LIMIT' } })
    expect(view(w)).toMatchObject({ state: 'limit', resetAt: 2000 })

    const resume = routeOf(w, RESUME_PATH)
    const early = await post(resume, { child: w.child })
    expect(early.status).toBe(409)
    expect(await early.json()).toMatchObject({ resetAt: 2000 })

    clock = 3000
    const answered = await post(resume, { child: w.child })
    expect(answered.status).toBe(200)
    expect(view(w)?.state).toBe('idle')
  })

  it('shows a limit the program reports mid-turn, and a signed-out program', async () => {
    const w = await stateWorld()
    const running = collect(w.adapter.stream(w.request([w.say('task')])))
    await tick()
    w.gate.latest.emit({ kind: 'turn-end', outcome: 'failed', failure: { category: 'limit', resetsAt: 7000 } })
    await running
    expect(view(w)).toMatchObject({ state: 'limit', resetAt: 7000 })

    const other = await stateWorld()
    other.gate.failure = new ProgramOpenError({ category: 'signed-out' })
    await collect(other.adapter.stream(other.request([other.say('task')])))
    expect(view(other)?.state).toBe('not-signed-in')
  })

  it('reopens nothing and writes nothing into the conversation on Resume, and refuses a chat that is not at a limit', async () => {
    const w = await stateWorld({ now: () => 9000 })
    const resume = routeOf(w, RESUME_PATH)
    expect((await post(resume, { child: w.child })).status).toBe(409)
    appendPluginRecord(w.session, SEAT_STATUS_RECORD, { state: 'limit', resetAt: 5000 })
    expect((await post(resume, { child: w.child })).status).toBe(200)
    expect(view(w)?.state).toBe('idle')
    expect(w.session.ownEvents().some(event => event.type === 'user/message')).toBe(false)
  })

  it('refuses a malformed request and a chat that is not a live agent', async () => {
    const w = await stateWorld()
    const resume = routeOf(w, RESUME_PATH)
    expect((await post(resume, { child: 3 })).status).toBe(400)
    expect((await resume?.fetch(new Request('http://delorun.test/', { method: 'POST', body: 'not json' })))?.status).toBe(400)
    expect((await post(resume, [])).status).toBe(400)
    const plain = w.ctx.sessions.create()
    expect((await post(resume, { child: plain.header.id })).status).toBe(404)
  })
})

describe('the model pick', () => {
  const offered = [{ id: 'gpt-a', displayName: 'GPT A', isDefault: true }, { id: 'gpt-b', displayName: 'GPT B', isDefault: false }]

  it('asks for a pick when the model is not offered, keeps it for the workspace and starts the agent with it', async () => {
    const w = await stateWorld()
    w.gate.failure = new ProgramOpenError({ category: 'model-not-offered', configured: 'gpt-x', offered })
    await collect(w.adapter.stream(w.request([w.say('task')])))
    expect(view(w)).toMatchObject({
      state: 'model-needed',
      modelPicker: { offered: [{ id: 'gpt-a', label: 'GPT A' }, { id: 'gpt-b', label: 'GPT B' }], planDefault: 'gpt-a' },
    })

    const choose = routeOf(w, CHOOSE_MODEL_PATH)
    expect((await post(choose, { child: w.child, id: 'gpt-z' })).status).toBe(409)
    expect((await post(choose, { child: w.child })).status).toBe(400)
    expect((await post(choose, { child: w.child, id: 'gpt-b' })).status).toBe(200)
    expect(w.mount.choices.get('workspace-1')).toBe('gpt-b')
    expect(view(w)?.state).toBe('idle')
    expect(view(w)?.modelPicker).toBeUndefined()
    expect(records(w, SEAT_NOTICE_RECORD)).toEqual([{ kind: 'model-chosen', text: expect.stringContaining('GPT B') }])

    w.gate.failure = undefined
    const next = collect(w.adapter.stream(w.request([w.say('task again')])))
    await tick()
    expect(w.gate.starts.at(-1)?.model).toBe('gpt-b')
    await finishTurn(w, next)
  })

  it('keeps the pick in Delorun\'s own folder across a restart, and refuses a pick the plan did not offer', async () => {
    const w = await stateWorld()
    w.gate.failure = new ProgramOpenError({ category: 'model-not-offered', configured: 'gpt-x', offered })
    await collect(w.adapter.stream(w.request([w.say('task')])))
    await post(routeOf(w, CHOOSE_MODEL_PATH), { child: w.child, id: 'gpt-b' })
    await w.mount.settled()
    const file = join(w.dir, MODEL_CHOICES_FILE)
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ 'workspace-1': 'gpt-b' })
    expect((await loadModelChoices(file, () => undefined)).get('workspace-1')).toBe('gpt-b')
  })

  it('refuses a pick for an agent with no workspace', async () => {
    const w = await stateWorld({ workspaceOf: () => undefined })
    appendPluginRecord(w.session, SEAT_STATUS_RECORD, { state: 'model-needed', modelPicker: { offered: [{ id: 'a', label: 'A' }], planDefault: 'a' } })
    expect((await post(routeOf(w, CHOOSE_MODEL_PATH), { child: w.child, id: 'a' })).status).toBe(409)
    const plain = w.ctx.sessions.create()
    expect((await post(routeOf(w, CHOOSE_MODEL_PATH), { child: plain.header.id, id: 'a' })).status).toBe(404)
  })

  it('reads no choices from a missing file and refuses a file it cannot read', async () => {
    const w = await stateWorld()
    expect((await loadModelChoices(join(w.dir, 'missing.json'), () => undefined)).get('x')).toBeUndefined()
    const { writeFile } = await import('node:fs/promises')
    await writeFile(join(w.dir, 'list.json'), '[]')
    await expect(loadModelChoices(join(w.dir, 'list.json'), () => undefined)).rejects.toThrow('JSON object')
    await writeFile(join(w.dir, 'number.json'), '{"workspace-1": 4}')
    await expect(loadModelChoices(join(w.dir, 'number.json'), () => undefined)).rejects.toThrow('must be a string')
  })

  it('refuses a choices path it cannot read for a reason other than a missing file', async () => {
    const w = await stateWorld()
    await expect(loadModelChoices(w.dir, () => undefined)).rejects.toMatchObject({ code: 'EISDIR' })
  })

  it('reports a pick it could not save and keeps it for this run', async () => {
    const w = await stateWorld()
    const { writeFile } = await import('node:fs/promises')
    await writeFile(join(w.dir, 'blocker'), '')
    const failures: unknown[] = []
    const choices = new FileModelChoices(join(w.dir, 'blocker', 'models.json'), new Map(), error => failures.push(error))
    choices.set('workspace-1', 'gpt-b')
    await choices.settled()
    expect(choices.get('workspace-1')).toBe('gpt-b')
    expect(failures).toHaveLength(1)
  })
})

describe('a program that cannot be resumed', () => {
  it('ends the turn, says so in the chat, and sends the next message alone to a fresh program', async () => {
    const w = await stateWorld()
    w.gate.next = () => new ScriptedProgram('program-1')
    const first = w.say('task')
    await turn(w, [first])
    await w.adapter.release(w.child)

    const second = w.say('are you there')
    w.gate.failure = new ProgramOpenError({ category: 'resume-failed' })
    const chunks = await collect(w.adapter.stream(w.request([first, second])))
    expect(finishOf(chunks)).toMatchObject({ kind: 'error', failure: { code: 'EXTERNAL_AGENT_RESUME_FAILED' } })
    expect(w.gate.starts[1]).toMatchObject({ resume: 'program-1' })
    expect(w.mount.store.read(w.child)).toEqual({ cursor: second.id })
    expect(records(w, SEAT_NOTICE_RECORD)).toEqual([{ kind: 'unresumable', text: expect.stringContaining('could not be resumed') }])
    expect(w.gate.programs[0]?.sent).toEqual([{ text: 'task', mode: 'start' }])

    w.gate.failure = undefined
    w.gate.next = () => new ScriptedProgram('program-2')
    const third = w.say('try again')
    const next = collect(w.adapter.stream(w.request([first, second, third])))
    await tick()
    expect(w.gate.starts[2]?.resume).toBeUndefined()
    expect(w.gate.latest.sent).toEqual([{ text: 'try again', mode: 'start' }])
    await finishTurn(w, next)
    expect(w.mount.store.read(w.child)).toEqual({ programSessionId: 'program-2', cursor: third.id })
  })

  it('adds nothing to a program that was never started', async () => {
    const w = await stateWorld()
    w.gate.failure = new ProgramOpenError({ category: 'resume-failed' })
    await collect(w.adapter.stream(w.request([w.say('task')])))
    expect(w.gate.programs).toEqual([])
  })
})

describe('parting on resume', () => {
  /** Run a first turn, remember the program's last message, release the program and start the next turn. */
  async function resumed(w: StateWorld, stored: string | undefined) {
    w.gate.next = () => new ScriptedProgram('program-1')
    const first = w.say('task')
    await turn(w, [first])
    w.mount.store.recordProgramMessage(w.child, stored)
    await w.adapter.release(w.child)
    const next = collect(w.adapter.stream(w.request([first, w.say('next')])))
    await tick()
    await finishTurn(w, next)
    await tick()
  }

  it('says the agent did work Delorun did not record', async () => {
    const w = await stateWorld({ tail: () => Promise.resolve({ lastMessageId: 'program-message-9' }) })
    await resumed(w, 'program-message-5')
    expect(records(w, SEAT_NOTICE_RECORD)).toEqual([{ kind: 'unrecorded-work', text: expect.stringContaining('did work') }])
  })

  it('says nothing when the program holds what the log recorded', async () => {
    const w = await stateWorld({ tail: () => Promise.resolve({ lastMessageId: 'program-message-5' }) })
    await resumed(w, 'program-message-5')
    expect(records(w, SEAT_NOTICE_RECORD)).toEqual([])
  })

  it('compares nothing when the log recorded no program message, or no reader is mounted', async () => {
    const unrecorded = await stateWorld({ tail: () => Promise.resolve({ lastMessageId: 'program-message-9' }) })
    await resumed(unrecorded, undefined)
    expect(records(unrecorded, SEAT_NOTICE_RECORD)).toEqual([])
    const unread = await stateWorld()
    await resumed(unread, 'program-message-5')
    expect(records(unread, SEAT_NOTICE_RECORD)).toEqual([])
  })

  it('reports a program that cannot be read instead of failing the turn', async () => {
    const w = await stateWorld({ tail: () => Promise.reject(new Error('thread file locked')) })
    await resumed(w, 'program-message-5')
    expect(w.warnings.join('\n')).toContain('thread file locked')
    expect(records(w, SEAT_NOTICE_RECORD)).toEqual([])
  })

  it('remembers the program\'s last message when a turn ends, and forgets it when the turn was stopped', async () => {
    const w = await stateWorld({ tail: () => Promise.resolve({ lastMessageId: 'program-message-7' }) })
    await turn(w, [w.say('task')])
    w.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    await until(() => w.mount.store.stateOf(w.child).logged.programMessageId === 'program-message-7', 'the recorded message')
    expect(records(w, SEAT_STATE_RECORD).at(-1)).toMatchObject({ programSessionId: 'program-1', programMessageId: 'program-message-7' })
    w.session.append('turn/end', { turn: 2, reason: { kind: 'aborted', reason: { kind: 'user' } } })
    await until(() => w.mount.store.stateOf(w.child).logged.programMessageId === null || w.warnings.length > 0, 'the forgotten message')
    expect(w.warnings).toEqual([])
    // A stopped turn that had none recorded records nothing more.
    const count = records(w, SEAT_STATE_RECORD).length
    w.session.append('turn/end', { turn: 3, reason: { kind: 'interrupted' } })
    await tick()
    expect(records(w, SEAT_STATE_RECORD)).toHaveLength(count)
  })

  it('leaves a chat that is not a seat alone at a turn end, and reports a failed read', async () => {
    const w = await stateWorld({ tail: () => Promise.reject(new Error('gone')) })
    const plain = w.ctx.sessions.create()
    plain.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    await turn(w, [w.say('task')])
    w.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    await until(() => w.warnings.length > 0, 'the warning')
    expect(w.warnings[0]).toContain('was not recorded')
  })
})

describe('Stop and the seat\'s end', () => {
  it('interrupts the running program and keeps it open', async () => {
    const w = await stateWorld()
    const running = collect(w.adapter.stream(w.request([w.say('task')])))
    await tick()
    await expect(w.mount.stop(w.child)).resolves.toBe('interrupted')
    expect(w.gate.latest.interrupts).toBe(1)
    expect(finishOf(await running)).toEqual({ kind: 'stop' })
  })

  it('says "closed" when the program had to be closed, and resumes its session on the next message', async () => {
    const w = await stateWorld()
    w.gate.next = () => new ScriptedProgram('program-1')
    const first = w.say('task')
    const controller = new AbortController()
    const running = collect(w.adapter.stream(w.request([first], { signal: controller.signal })))
    await tick()
    w.gate.latest.interruptOutcome = 'closed'
    await expect(w.mount.stop(w.child)).resolves.toBe('closed')
    controller.abort(new Error('stopped'))
    await expect(running).rejects.toThrow('stopped')
    const second = w.say('again')
    const next = collect(w.adapter.stream(w.request([first, second])))
    await tick()
    expect(w.gate.starts[1]).toMatchObject({ resume: 'program-1' })
    await finishTurn(w, next)
  })

  it('answers "none" for a chat with no open program', async () => {
    const w = await stateWorld()
    await expect(w.mount.stop(SessionId('nothing'))).resolves.toBe('none')
  })

  it('logs that a seat ended with its reason, and whether a question waits', async () => {
    const w = await stateWorld({ now: () => 1 })
    w.mount.setPending(w.child, 1234)
    expect(view(w)?.pending).toEqual({ since: 1234 })
    w.mount.setPending(w.child, undefined)
    expect(view(w)?.pending).toBeUndefined()
    w.mount.end(w.child, 'The chat was archived.')
    expect(view(w)).toMatchObject({ state: 'ended', endedReason: 'The chat was archived.' })
    expect(() => w.mount.setPending(w.ctx.sessions.create().header.id, 1)).toThrow('not a seat child')
  })

  it('fails loud for a seat child whose Session is not loaded', async () => {
    const w = await stateWorld()
    expect(() => w.mount.store.read(SessionId('unloaded'))).toThrow('not loaded')
  })
})

describe('the seatPrograms service', () => {
  it('is provided on the context and serves the live seats of the adapter', async () => {
    const w = await stateWorld()
    expect(w.ctx.seatPrograms).toBe(w.mount.programs)
    expect(w.mount.programs.records).toBe(w.mount.records)
    expect(w.mount.programs.program(w.child)).toBeUndefined()
    const running = collect(w.adapter.stream(w.request([w.say('task')])))
    await tick()
    expect(w.mount.programs.program(w.child)).toBe(w.adapter.runOf(w.child))
    await finishTurn(w, running)
  })
})

describe('what the adapter reports about a program that cannot start', () => {
  it('names Claude Code in the notice about an unresumable program of a chat with no seat view', async () => {
    const w = await stateWorld()
    const plain = w.ctx.sessions.create().header.id
    w.mount.events.onTurnFailure?.(plain, { category: 'resume-failed' }, 'turn')
    const [notice] = w.ctx.sessions.get(plain)?.snapshotEvents().flatMap((event) => {
      const record = pluginRecordOf(event)
      return record?.type === SEAT_NOTICE_RECORD ? [record.data] : []
    }) ?? []
    expect(notice).toMatchObject({ kind: expect.any(String), text: expect.stringContaining('Claude Code') })
  })

  it('leaves the chat as it was when a start fails while the chat is not "Starting"', async () => {
    const w = await stateWorld()
    const before = records(w, SEAT_STATUS_RECORD).length
    w.mount.events.onStartFailed?.(w.child)
    expect(records(w, SEAT_STATUS_RECORD)).toHaveLength(before)
    expect(view(w)?.state).toBe('idle')
  })

  it('checks nothing after a resumed program starts when the chat is no seat view', async () => {
    const w = await stateWorld({ tail: () => Promise.reject(new Error('must not read')) })
    const plain = w.ctx.sessions.create().header.id
    w.mount.store.write(plain, { programSessionId: 'program-1' })
    w.mount.events.onStarting?.(plain, 'claude-code')
    w.mount.events.onStarted?.(plain, { sandbox: 'off' })
    await tick()
    expect(w.warnings).toEqual([])
  })

  it('checks nothing after a resumed program starts when the program session was dropped meanwhile', async () => {
    const w = await stateWorld({ tail: () => Promise.reject(new Error('must not read')) })
    w.mount.store.write(w.child, { programSessionId: 'program-1' })
    w.mount.events.onStarting?.(w.child, 'claude-code')
    w.mount.store.write(w.child, {})
    w.mount.events.onStarted?.(w.child, { sandbox: 'off' })
    await tick()
    expect(w.warnings).toEqual([])
  })

  it.each([
    ['takes the plan\'s default model as the suggestion', [{ id: 'a', displayName: 'A', isDefault: false }, { id: 'b', displayName: 'B', isDefault: true }], 'b'],
    ['suggests the first model when the plan marks no default', [{ id: 'a', displayName: 'A', isDefault: false }, { id: 'b', displayName: 'B', isDefault: false }], 'a'],
    ['suggests the configured model when the plan offers none', [], 'configured-model'],
  ] as const)('%s', (_label, offered, planDefault) => {
    return stateWorld().then((w) => {
      w.mount.events.onModelNotOffered?.({ child: w.child, provider: 'claude-code', configured: 'configured-model', offered })
      expect(view(w)?.modelPicker?.planDefault).toBe(planDefault)
    })
  })

  it('shows a reached limit without a reset time when the program gave none', async () => {
    const w = await stateWorld()
    w.mount.events.onTurnFailure?.(w.child, { category: 'limit' }, 'turn')
    expect(view(w)).toMatchObject({ state: 'limit' })
    expect(view(w)?.resetAt).toBeUndefined()
  })

  it.each([
    ['a time limit', { category: 'time-limit', limitMs: 60_000 }],
    ['a failed turn', { category: 'program', detail: 'boom' }],
  ] as const)('changes nothing in the chat\'s state for %s', async (_label, failure) => {
    const w = await stateWorld()
    const before = records(w, SEAT_STATUS_RECORD).length
    w.mount.events.onTurnFailure?.(w.child, failure, 'turn')
    expect(records(w, SEAT_STATUS_RECORD)).toHaveLength(before)
  })

  it.each([
    ['a failed start with no exit', 'start', { category: 'program', detail: 'secret path /home/x' }, 'Claude Code failed while starting.'],
    ['a failed turn with an exit code', 'turn', { category: 'program', detail: 'secret', exit: { code: 1 } }, 'Claude Code failed during its turn; its process exited with code 1.'],
    ['a failed turn ended by a signal', 'turn', { category: 'program', detail: 'secret', exit: { signal: 'SIGKILL' } }, 'Claude Code failed during its turn; its process ended with signal SIGKILL.'],
  ] as const)('logs and reports only the fixed facts of %s, never the program\'s words', async (_label, stage, failure, sentence) => {
    const w = await stateWorld()
    w.mount.events.onTurnFailure?.(w.child, failure, stage)
    expect(records(w, SEAT_NOTICE_RECORD).at(-1)).toEqual({ kind: 'program-failed', text: sentence })
    expect(w.warnings.join('\n')).toContain(sentence)
    expect(JSON.stringify(records(w, SEAT_NOTICE_RECORD))).not.toContain('secret')
    expect(w.warnings.join('\n')).not.toContain('secret')
  })

  it('refuses account figures for a chat that is not a live agent', async () => {
    const w = await stateWorld()
    const plain = w.ctx.sessions.create()
    expect(() => { w.mount.store.setAccount(plain.header.id, { plan: 'Max' }) }).toThrow(/not a seat child/)
  })

  it('keeps the state\'s own fields when it logs account figures', async () => {
    const w = await stateWorld()
    const picker = { offered: [{ id: 'm', label: 'M' }], planDefault: 'm' }
    appendPluginRecord(w.session, SEAT_STATUS_RECORD, { state: 'model-needed', modelPicker: picker, pending: 5, resetAt: 9, endedReason: 'why' })
    w.mount.store.setAccount(w.child, { plan: 'Max' })
    expect(view(w)).toMatchObject({ state: 'model-needed', modelPicker: picker, pending: { since: 5 }, resetAt: 9, endedReason: 'why', plan: 'Max' })
  })
})

describe('a seat child whose Session is cold', () => {
  const PICKER = { offered: [{ id: 'gpt-5.6-terra', label: 'Terra' }], planDefault: 'gpt-5.6-terra' }

  /** A world whose cold child is a stored Session that `prepare` shapes. */
  async function coldWorld(prepare: (cold: Session) => void, options: Partial<SeatStateOptions> = {}): Promise<StateWorld> {
    let cold: Session | undefined
    const w = await stateWorld({ workspaceOf: () => 'workspace-1', inspectCold: (_child, read) => Promise.resolve(cold === undefined ? undefined : read(cold)), ...options })
    cold = w.ctx.sessions.create()
    prepare(cold)
    return w
  }
  const needsModel = (cold: Session): void => {
    describeSeat(cold)
    appendPluginRecord(cold, SEAT_STATUS_RECORD, { state: 'model-needed', modelPicker: PICKER })
  }

  it('keeps the model pick for the workspace without logging anything in the chat', async () => {
    const w = await coldWorld(needsModel)
    const answered = await post(routeOf(w, CHOOSE_MODEL_PATH), { child: 'cold-child', id: 'gpt-5.6-terra' })
    expect(answered.status).toBe(200)
    expect(await answered.json()).toEqual({ ok: true, cold: true })
    expect(w.mount.choices.get('workspace-1')).toBe('gpt-5.6-terra')
  })

  it('refuses a model id that is not shaped like one', async () => {
    const w = await coldWorld(needsModel)
    expect((await post(routeOf(w, CHOOSE_MODEL_PATH), { child: 'cold-child', id: 'not a model!' })).status).toBe(409)
    expect(w.mount.choices.get('workspace-1')).toBeUndefined()
  })

  it('refuses a model its plan does not offer', async () => {
    const w = await coldWorld(needsModel)
    expect((await post(routeOf(w, CHOOSE_MODEL_PATH), { child: 'cold-child', id: 'gpt-9-other' })).status).toBe(409)
    expect(w.mount.choices.get('workspace-1')).toBeUndefined()
  })

  it('refuses a chat that is not a seat child', async () => {
    const w = await coldWorld(() => {})
    expect((await post(routeOf(w, CHOOSE_MODEL_PATH), { child: 'cold-child', id: 'gpt-5.6-terra' })).status).toBe(404)
    expect(w.mount.choices.get('workspace-1')).toBeUndefined()
  })

  it('refuses a seat that is not waiting for a model', async () => {
    const w = await coldWorld(describeSeat)
    expect((await post(routeOf(w, CHOOSE_MODEL_PATH), { child: 'cold-child', id: 'gpt-5.6-terra' })).status).toBe(409)
  })

  it('refuses a chat with no stored Session', async () => {
    const w = await stateWorld({ inspectCold: () => Promise.resolve(undefined) })
    expect((await post(routeOf(w, CHOOSE_MODEL_PATH), { child: 'cold-child', id: 'gpt-5.6-terra' })).status).toBe(404)
  })

  it('answers Resume without changing anything', async () => {
    const w = await stateWorld()
    const answered = await post(routeOf(w, RESUME_PATH), { child: 'cold-child' })
    expect(answered.status).toBe(200)
    expect(await answered.json()).toEqual({ ok: true, cold: true })
  })

  it('refuses a pick when the child\'s workspace is unknown', async () => {
    const w = await coldWorld(needsModel, { workspaceOf: () => undefined, coldWorkspaceOf: () => Promise.resolve(undefined) })
    expect((await post(routeOf(w, CHOOSE_MODEL_PATH), { child: 'cold-child', id: 'gpt-5.6-terra' })).status).toBe(409)
  })

  it('finds the workspace of a cold child from its stored header', async () => {
    const w = await coldWorld(needsModel, { workspaceOf: () => undefined, coldWorkspaceOf: () => Promise.resolve('workspace-cold') })
    expect((await post(routeOf(w, CHOOSE_MODEL_PATH), { child: 'cold-child', id: 'gpt-5.6-terra' })).status).toBe(200)
    expect(w.mount.choices.get('workspace-cold')).toBe('gpt-5.6-terra')
  })
})
