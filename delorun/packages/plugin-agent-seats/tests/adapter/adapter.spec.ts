/**
 * Specs of the seat adapter over a scripted program: request mapping, the new-input cursor, steps, usage, Stop, a
 * repeated request, opening and resuming through the start gate, and the failures that end a turn.
 */
import { GateRefusedError, ProgramOpenError, type ProgramEvent } from '@delorun/external-agents/contract'
import { describe, expect, it } from 'vitest'
import { RESULT_DELIVERY_GUIDANCE } from '../../src/adapter/input.ts'
import { agentMessage, CHILD, collect, finishOf, request, system, toolResult, user, userBlocks, world, type World } from './support.ts'

const tick = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0))

/**
 * Run one adapter request while the program produces `events` after it has been sent its input.
 * @param w - the world.
 * @param messages - the request's history.
 * @param events - the program's events.
 * @returns the chunks.
 */
async function turn(w: World, messages: Parameters<typeof request>[0], events: ProgramEvent[]) {
  const running = collect(w.adapter.stream(request(messages)))
  await tick()
  w.gate.latest.emit(...events)
  return running
}

describe('opening the program', () => {
  it('starts it through the gate for the seat, the creator and the folder, and says "Starting"', async () => {
    const w = world()
    await turn(w, [user('task')], [{ kind: 'turn-end', outcome: 'completed' }])
    expect(w.gate.starts).toHaveLength(1)
    expect(w.gate.starts[0]).toMatchObject({ purpose: 'seat', provider: 'claude-code', creator: 'root', child: CHILD, cwd: '/work', harnessTools: [] })
    expect(w.gate.starts[0]?.resume).toBeUndefined()
    expect(w.reports.starting).toEqual(['child-1:claude-code'])
    expect(w.reports.started).toEqual(['child-1'])
  })

  it('logs the program session id and the cursor', async () => {
    const w = world()
    const task = user('task')
    await turn(w, [task], [{ kind: 'turn-end', outcome: 'completed' }])
    expect(w.states.writes).toEqual([{ programSessionId: 'program-1' }, { programSessionId: 'program-1', cursor: task.id }])
  })

  it('resumes the logged program session from the logged cursor, with the workspace\'s chosen model', async () => {
    const w = world()
    const first = user('first')
    const second = user('second')
    w.states.states.set(CHILD, { programSessionId: 'earlier-session', cursor: first.id })
    w.models.set('workspace-1', 'gpt-5.6-luna')
    await turn(w, [first, second], [{ kind: 'turn-end', outcome: 'completed' }])
    expect(w.gate.starts[0]).toMatchObject({ resume: 'earlier-session', model: 'gpt-5.6-luna' })
    expect(w.gate.latest.sent).toEqual([{ text: 'second', mode: 'start' }])
  })

  it('does not start a program for a model pick of another workspace', async () => {
    const w = world()
    w.models.set('other-workspace', 'gpt-5.6-luna')
    await turn(w, [user('task')], [{ kind: 'turn-end', outcome: 'completed' }])
    expect(w.gate.starts[0]?.model).toBeUndefined()
  })
})

describe('what the program is sent', () => {
  it('receives the first task exactly as the delegating model wrote it', async () => {
    const w = world()
    const task = 'Fix the failing build.\n\nRun the unit tests when you are done.'
    await turn(w, [userBlocks(task, RESULT_DELIVERY_GUIDANCE)], [{ kind: 'turn-end', outcome: 'completed' }])
    expect(w.gate.latest.sent).toEqual([{ text: task, mode: 'start' }])
  })

  it('sends a person\'s later message exactly as written, as a steer while the turn runs', async () => {
    const w = world()
    const first = user('start')
    const chunks = await turn(w, [first, user('x', 'system-prompt')], [
      { kind: 'tool-call', id: 'c1', name: 'Bash', input: '{"command":"ls"}' },
      { kind: 'message-end' },
    ])
    expect(finishOf(chunks)).toEqual({ kind: 'tool-calls' })
    const message = user('Also check the lint.')
    const next = collect(w.adapter.stream(request([first, message])))
    await tick()
    expect(w.gate.latest.sent.at(-1)).toEqual({ text: 'Also check the lint.', mode: 'steer' })
    w.gate.latest.emit({ kind: 'turn-end', outcome: 'completed' })
    expect(finishOf(await next)).toEqual({ kind: 'stop' })
  })

  it('sends an agent\'s send_message text without the runtime\'s prefix', async () => {
    const w = world()
    const first = user('start')
    await turn(w, [first], [{ kind: 'turn-end', outcome: 'completed' }])
    const message = agentMessage('lead', 'Use the staging folder.')
    const next = collect(w.adapter.stream(request([first, message])))
    await tick()
    w.gate.latest.emit({ kind: 'turn-end', outcome: 'completed' })
    await next
    expect(w.gate.latest.sent.at(-1)).toEqual({ text: 'Use the staging folder.', mode: 'start' })
  })

  it('does not resend input on a repeated request with nothing new', async () => {
    const w = world()
    const task = user('task')
    await turn(w, [task], [{ kind: 'turn-end', outcome: 'completed' }])
    const again = await collect(w.adapter.stream(request([task])))
    expect(finishOf(again)).toEqual({ kind: 'stop' })
    expect(w.gate.latest.sent).toHaveLength(1)
    expect(w.gate.starts).toHaveLength(1)
  })

  it('resumes reading a running program\'s stream on a repeated request with nothing new', async () => {
    const w = world()
    const task = user('task')
    const first = await turn(w, [task], [{ kind: 'tool-call', id: 'c1', name: 'Bash', input: '{}' }, { kind: 'message-end' }])
    expect(finishOf(first)).toEqual({ kind: 'tool-calls' })
    const again = collect(w.adapter.stream(request([task])))
    await tick()
    w.gate.latest.emit({ kind: 'text', text: 'done' }, { kind: 'turn-end', outcome: 'completed' })
    expect(finishOf(await again)).toEqual({ kind: 'stop' })
    expect(w.gate.latest.sent).toHaveLength(1)
  })

  it('reports the same failure again on a repeated request after a failed turn', async () => {
    const w = world()
    const task = user('task')
    const first = await turn(w, [task], [{ kind: 'turn-end', outcome: 'failed', failure: { category: 'program', detail: 'boom' } }])
    const again = await collect(w.adapter.stream(request([task])))
    expect(finishOf(again)).toEqual(finishOf(first))
    expect(w.gate.latest.sent).toHaveLength(1)
  })

  it('sends nothing when the cursor names no message of the history', async () => {
    const w = world()
    w.states.states.set(CHILD, { programSessionId: 'earlier', cursor: 'gone' })
    const chunks = await collect(w.adapter.stream(request([user('a')])))
    expect(finishOf(chunks)).toMatchObject({ kind: 'error', failure: { code: 'EXTERNAL_AGENT_HISTORY_PARTED' } })
    expect(w.gate.starts).toEqual([])
  })

  it('sends nothing for a first task whose guidance is fused into its text', async () => {
    const w = world()
    const chunks = await collect(w.adapter.stream(request([user(`Fix the build. ${RESULT_DELIVERY_GUIDANCE}`)])))
    expect(finishOf(chunks)).toMatchObject({ kind: 'error', failure: { code: 'EXTERNAL_AGENT_TASK_UNSEPARABLE' } })
    expect(w.gate.starts).toEqual([])
  })

  it('starts nothing for a request with no message for the program and no open program', async () => {
    const w = world()
    const chunks = await collect(w.adapter.stream(request([system()])))
    expect(finishOf(chunks)).toEqual({ kind: 'stop' })
    expect(w.gate.starts).toEqual([])
  })
})

describe('what the step streams', () => {
  it('streams text, reasoning and tool calls in program order, one usage chunk per step, then the finish', async () => {
    const w = world()
    const chunks = await turn(w, [user('task')], [
      { kind: 'reasoning', text: 'thinking' },
      { kind: 'text', text: 'Looking.' },
      { kind: 'tool-call', id: 'c1', name: 'Bash', input: '{"command":"ls"}' },
      { kind: 'message-end', usage: { inputTokens: 10, outputTokens: 4 } },
    ])
    expect(chunks.map(chunk => chunk.type)).toEqual([
      'block-start', 'reasoning-delta', 'block-end', 'block-start', 'text-delta', 'block-end',
      'block-start', 'tool-call-delta', 'block-end', 'usage', 'finish',
    ])
    expect(chunks.filter(chunk => chunk.type === 'usage')).toEqual([{ type: 'usage', usage: { inputTokens: 10, outputTokens: 4 } }])
    expect(chunks.at(-2)).toEqual({ type: 'usage', usage: { inputTokens: 10, outputTokens: 4 } })
    expect(finishOf(chunks)).toEqual({ kind: 'tool-calls' })
  })

  it('sums the usage of every message of a step into its one usage chunk', async () => {
    const w = world()
    const chunks = await turn(w, [user('task')], [
      { kind: 'text', text: 'a' },
      { kind: 'message-end', usage: { inputTokens: 10, outputTokens: 4, cacheReadTokens: 2 } },
      { kind: 'text', text: 'b' },
      { kind: 'turn-end', outcome: 'completed', usage: { inputTokens: 5, outputTokens: 1, cacheReadTokens: 1 } },
    ])
    expect(chunks.filter(chunk => chunk.type === 'usage')).toEqual([{ type: 'usage', usage: { inputTokens: 15, outputTokens: 5, cacheReadTokens: 3 } }])
  })

  it('sums a figure that only one message reports, and omits one that none reports', async () => {
    const w = world()
    const chunks = await turn(w, [user('task')], [
      { kind: 'message-end', usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 2 } },
      { kind: 'turn-end', outcome: 'completed', usage: { inputTokens: 1, outputTokens: 1, cacheWriteTokens: 3 } },
    ])
    expect(chunks.filter(chunk => chunk.type === 'usage')).toEqual([{ type: 'usage', usage: { inputTokens: 2, outputTokens: 2, cacheReadTokens: 2, cacheWriteTokens: 3 } }])
  })

  it('keeps streaming one text block while the program goes on with text', async () => {
    const w = world()
    const chunks = await turn(w, [user('task')], [{ kind: 'text', text: 'Hel' }, { kind: 'text', text: 'lo' }, { kind: 'turn-end', outcome: 'completed' }])
    expect(chunks.map(chunk => chunk.type)).toEqual(['block-start', 'text-delta', 'text-delta', 'block-end', 'finish'])
    expect(chunks.find(chunk => chunk.type === 'block-end')).toMatchObject({ block: { text: 'Hello' } })
  })

  it('ends a step at the first message with tool calls and continues in the next request', async () => {
    const w = world()
    const task = user('task')
    const first = await turn(w, [task], [
      { kind: 'tool-call', id: 'c1', name: 'Bash', input: '{}' },
      { kind: 'message-end' },
      { kind: 'text', text: 'Finished.' },
      { kind: 'turn-end', outcome: 'completed' },
    ])
    expect(finishOf(first)).toEqual({ kind: 'tool-calls' })
    const second = await collect(w.adapter.stream(request([task])))
    expect(second.filter(chunk => chunk.type === 'text-delta')).toEqual([{ type: 'text-delta', index: 0, text: 'Finished.' }])
    expect(finishOf(second)).toEqual({ kind: 'stop' })
  })
})

describe('Stop', () => {
  it('interrupts the program when the turn\'s signal aborts, keeping the program open', async () => {
    const w = world()
    const controller = new AbortController()
    const running = collect(w.adapter.stream(request([user('task')], { signal: controller.signal })))
    await tick()
    controller.abort(new Error('stopped'))
    await expect(running).rejects.toThrow('stopped')
    expect(w.gate.latest.interrupts).toBe(1)
    expect(w.gate.latest.closed).toBe(false)
  })

  it('does not interrupt the program when reading its events fails for another reason', async () => {
    const w = world()
    const running = collect(w.adapter.stream(request([user('task')])))
    await tick()
    w.gate.latest.next = () => Promise.reject(new Error('the pipe broke'))
    w.gate.latest.emit({ kind: 'text', text: 'x' })
    await expect(running).rejects.toThrow('the pipe broke')
    expect(w.gate.latest.interrupts).toBe(0)
  })

  it('drops what the program did before its turn ended, then sends the next message as a new turn', async () => {
    const w = world()
    const first = user('task')
    const controller = new AbortController()
    const running = collect(w.adapter.stream(request([first], { signal: controller.signal })))
    await tick()
    controller.abort(new Error('stopped'))
    await expect(running).rejects.toThrow('stopped')
    const second = user('try something else')
    const next = collect(w.adapter.stream(request([first, second])))
    await tick()
    expect(w.gate.latest.sent).toEqual([{ text: 'task', mode: 'start' }, { text: 'try something else', mode: 'start' }])
    w.gate.latest.emit({ kind: 'turn-end', outcome: 'completed' })
    expect(finishOf(await next)).toEqual({ kind: 'stop' })
  })

  it('resumes the program\'s own session on the next message when Stop had to close its process', async () => {
    const w = world()
    const first = user('task')
    const controller = new AbortController()
    const running = collect(w.adapter.stream(request([first], { signal: controller.signal })))
    await tick()
    w.gate.latest.interruptOutcome = 'closed'
    controller.abort(new Error('stopped'))
    await expect(running).rejects.toThrow('stopped')
    const second = user('again')
    const next = collect(w.adapter.stream(request([first, second])))
    await tick()
    expect(w.gate.starts).toHaveLength(2)
    expect(w.gate.starts[1]).toMatchObject({ resume: 'program-1' })
    w.gate.latest.emit({ kind: 'turn-end', outcome: 'completed' })
    await next
    expect(w.gate.latest.sent).toEqual([{ text: 'again', mode: 'start' }])
  })
})

describe('turns that cannot run or end in failure', () => {
  it('ends a turn on the model-not-offered refusal with the offered list, before any turn', async () => {
    const w = world()
    const offered = [{ id: 'gpt-5.6-luna', displayName: 'GPT-5.6 Luna', isDefault: false }]
    w.gate.failure = new ProgramOpenError({ category: 'model-not-offered', configured: 'gpt-5.5', offered })
    const chunks = await collect(w.adapter.stream(request([user('task')])))
    expect(finishOf(chunks)).toMatchObject({ kind: 'error', failure: { code: 'EXTERNAL_AGENT_MODEL_NOT_OFFERED' } })
    expect(w.reports.notOffered).toEqual([{ child: CHILD, provider: 'claude-code', configured: 'gpt-5.5', offered }])
    expect(w.adapter.runOf(CHILD)).toBeUndefined()
    expect(w.states.writes).toEqual([])
  })

  it('ends a turn at a reached plan limit with the reset time, and tells the chat', async () => {
    const w = world()
    const resetsAt = Date.UTC(2026, 10, 17, 22, 0, 0)
    const chunks = await turn(w, [user('task')], [
      { kind: 'text', text: 'working' },
      { kind: 'turn-end', outcome: 'failed', failure: { category: 'limit', resetsAt } },
    ])
    expect(finishOf(chunks)).toEqual({
      kind: 'error',
      failure: { message: 'The agent\'s plan limit is reached. It resets at 2026-11-17T22:00:00.000Z.', code: 'EXTERNAL_AGENT_LIMIT' },
    })
    expect(w.reports.failures).toEqual([{ child: CHILD, category: 'limit', resetsAt }])
  })

  it('keeps the program\'s own words out of the finish', async () => {
    const w = world()
    const chunks = await turn(w, [user('task')], [{ kind: 'turn-end', outcome: 'failed', failure: { category: 'program', detail: 'secret path /home/x' } }])
    expect(JSON.stringify(finishOf(chunks))).not.toContain('secret')
    expect(w.reports.failures).toEqual([{ child: CHILD, category: 'program' }])
  })

  it('ends a turn the gate refuses at a plan limit with the reset time', async () => {
    const w = world()
    w.gate.failure = new GateRefusedError({ category: 'limit', window: 'five_hour', resetsAt: Date.UTC(2026, 10, 17, 22, 0, 0) })
    const chunks = await collect(w.adapter.stream(request([user('task')])))
    expect(finishOf(chunks)).toMatchObject({ kind: 'error', failure: { code: 'EXTERNAL_AGENT_LIMIT', message: expect.stringContaining('2026-11-17T22:00:00.000Z') } })
    expect(w.reports.failures).toMatchObject([{ category: 'limit' }])
  })

  it.each([
    [{ category: 'consent', reason: 'The person declined.' } as const, 'EXTERNAL_AGENT_CONSENT'],
    [{ category: 'not-installed' } as const, 'EXTERNAL_AGENT_NOT_INSTALLED'],
    [{ category: 'capacity', busy: ['codex'] } as const, 'EXTERNAL_AGENT_CAPACITY'],
    [{ category: 'seat-running' } as const, 'EXTERNAL_AGENT_RUNNING'],
  ])('ends a turn the gate refuses (%j)', async (refusal, code) => {
    const w = world()
    w.gate.failure = new GateRefusedError(refusal)
    expect(finishOf(await collect(w.adapter.stream(request([user('task')]))))).toMatchObject({ kind: 'error', failure: { code } })
    expect(w.reports.starting).toEqual(['child-1:claude-code'])
    expect(w.reports.startFailed).toEqual(['child-1'])
    expect(w.reports.started).toEqual([])
  })

  it.each([
    [{ category: 'signed-out' } as const, 'EXTERNAL_AGENT_SIGNED_OUT'],
    [{ category: 'resume-failed' } as const, 'EXTERNAL_AGENT_RESUME_FAILED'],
  ])('ends a turn when the program cannot open (%j)', async (failure, code) => {
    const w = world()
    w.gate.failure = new ProgramOpenError(failure)
    expect(finishOf(await collect(w.adapter.stream(request([user('task')]))))).toMatchObject({ kind: 'error', failure: { code } })
    expect(w.reports.failures).toMatchObject([{ category: failure.category }])
  })

  it('does not swallow an unexpected start error', async () => {
    const w = world()
    w.gate.failure = new Error('driver bug')
    await expect(collect(w.adapter.stream(request([user('task')])))).rejects.toThrow('driver bug')
    expect(w.reports.startFailed).toEqual(['child-1'])
  })

  it('does not start a program for a seat with no folder', async () => {
    const w = world({ host: { cwd: () => undefined } })
    expect(finishOf(await collect(w.adapter.stream(request([user('task')]))))).toMatchObject({ kind: 'error', failure: { code: 'EXTERNAL_AGENT_FOLDER_UNKNOWN' } })
    expect(w.gate.starts).toEqual([])
  })

  it('lets a Stop that arrives while the input is sent end the request as a Stop', async () => {
    const w = world()
    const first = user('task')
    await turn(w, [first], [{ kind: 'turn-end', outcome: 'completed' }])
    const controller = new AbortController()
    w.gate.latest.send = () => { controller.abort(new Error('stopped')); return Promise.reject(new Error('closed')) }
    await expect(collect(w.adapter.stream(request([first, user('more')], { signal: controller.signal })))).rejects.toThrow('closed')
    expect(w.adapter.runOf(CHILD)).toBeDefined()
    expect(w.gate.latest.closed).toBe(false)
  })

  it('hands the result of a harness tool the program called back to the host', async () => {
    const delivered: Array<{ readonly callId: string, readonly output: string, readonly isError: boolean }> = []
    const w = world({ host: { isHarnessCall: (_child, callId) => callId === 'harness-1', deliverHarnessResult: (_child, result) => { delivered.push(result) } } })
    const first = user('task')
    await turn(w, [first], [{ kind: 'turn-end', outcome: 'completed' }])
    const next = collect(w.adapter.stream(request([first, toolResult('harness-1', 'the answer'), toolResult('recorded-1', 'ls output'), user('go on')])))
    await tick()
    w.gate.latest.emit({ kind: 'turn-end', outcome: 'completed' })
    await next
    expect(delivered).toEqual([{ callId: 'harness-1', output: 'the answer', isError: false }])
    expect(w.gate.latest.sent.at(-1)?.text).toBe('go on')
  })

  it('starts the program without a model pick when the chat belongs to no workspace', async () => {
    const w = world({ host: { workspaceOf: () => undefined } })
    w.models.set('workspace-1', 'never-used')
    await turn(w, [user('task')], [{ kind: 'turn-end', outcome: 'completed' }])
    expect(w.gate.starts[0]?.model).toBeUndefined()
  })

  it('says the turn failed, without a reason, when the program reports a failed turn with none', async () => {
    const w = world()
    const chunks = await turn(w, [user('task')], [{ kind: 'turn-end', outcome: 'failed' }])
    expect(finishOf(chunks)).toMatchObject({ kind: 'error', failure: { code: 'EXTERNAL_AGENT_FAILED' } })
    expect(w.reports.failures).toEqual([{ child: CHILD, category: 'program' }])
  })

  it('ends the turn and drops the program when it no longer accepts input', async () => {
    const w = world()
    const first = user('task')
    await turn(w, [first], [{ kind: 'turn-end', outcome: 'completed' }])
    w.gate.latest.sendError = new Error('closed')
    const chunks = await collect(w.adapter.stream(request([first, user('more')])))
    expect(finishOf(chunks)).toMatchObject({ kind: 'error', failure: { code: 'EXTERNAL_AGENT_PROGRAM_CLOSED' } })
    expect(w.adapter.runOf(CHILD)).toBeUndefined()
    expect(w.states.states.get(CHILD)?.cursor).toBe(first.id)
  })
})

describe('closing a quiet agent\'s program', () => {
  it('closes every open program when the plugin stops', async () => {
    const w = world()
    await turn(w, [user('task')], [{ kind: 'turn-end', outcome: 'completed' }])
    expect(w.gate.latest.closed).toBe(false)
    await w.adapter.releaseAll()
    expect(w.gate.latest.closed).toBe(true)
    expect(w.adapter.runOf(CHILD)).toBeUndefined()
  })

  it('closes the program and starts it again with resume on the next message', async () => {
    const w = world()
    const first = user('task')
    await turn(w, [first], [{ kind: 'turn-end', outcome: 'completed' }])
    await w.adapter.release(CHILD)
    expect(w.gate.latest.closed).toBe(true)
    const second = user('next')
    const next = collect(w.adapter.stream(request([first, second])))
    await tick()
    expect(w.gate.starts[1]).toMatchObject({ resume: 'program-1' })
    expect(w.reports.starting).toHaveLength(2)
    w.gate.latest.emit({ kind: 'turn-end', outcome: 'completed' })
    await next
    expect(w.gate.latest.sent).toEqual([{ text: 'next', mode: 'start' }])
  })
})

describe('the names of the program\'s tool calls', () => {
  const toolNames = (chunks: Awaited<ReturnType<typeof collect>>): string[] => chunks.flatMap(chunk => chunk.type === 'block-end' && chunk.block.type === 'tool-call' ? [chunk.block.name] : [])

  it('gives every program tool the seat\'s record prefix, so the native executor never sees an unprefixed record', async () => {
    const w = world()
    const chunks = await turn(w, [user('task')], [
      { kind: 'tool-call', id: 'c1', name: 'Bash', input: '{}' },
      { kind: 'tool-call', id: 'c2', name: 'mcp__server__tool', input: '{}' },
      { kind: 'message-end' },
    ])
    expect(toolNames(chunks)).toEqual(['claude_code.Bash', 'claude_code.mcp__server__tool'])
    const deltas = chunks.flatMap(chunk => chunk.type === 'tool-call-delta' ? [chunk.name] : [])
    expect(deltas).toEqual(['claude_code.Bash', 'claude_code.mcp__server__tool'])
  })

  it('keeps the name of a harness tool offered to the program over MCP', async () => {
    const w = world({ host: { isHarnessTool: (_child, name) => name === 'delorun_read_file' } })
    const chunks = await turn(w, [user('task')], [
      { kind: 'tool-call', id: 'c1', name: 'delorun_read_file', input: '{}' },
      { kind: 'tool-call', id: 'c2', name: 'Bash', input: '{}' },
      { kind: 'message-end' },
    ])
    expect(toolNames(chunks)).toEqual(['delorun_read_file', 'claude_code.Bash'])
  })
})

describe('the relay\'s and the executor\'s view of a seat', () => {
  it('relays a question to the host with the child, and holds a result for the recorded call', async () => {
    const asked: Array<{ readonly callId: string, readonly signal: AbortSignal }> = []
    const w = world({ host: { approve: (_child, request, signal) => { asked.push({ callId: request.callId, signal }); return Promise.resolve('allow-once') } } })
    await turn(w, [user('task')], [{ kind: 'tool-call', id: 'c1', name: 'Bash', input: '{}' }, { kind: 'message-end' }])
    const run = w.adapter.runOf(CHILD)
    expect(run).toBeDefined()
    const answer = w.gate.starts[0]?.onApproval({ callId: 'c1', toolName: 'Bash', reason: 'run ls', signal: new AbortController().signal })
    await expect(answer).resolves.toBe('allow-once')
    expect(asked.map(question => question.callId)).toEqual(['c1'])
    expect(asked[0]?.signal).toBe(w.gate.starts[0]?.signal)
    w.gate.latest.emit({ kind: 'tool-result', id: 'c1', output: 'file.txt', isError: false })
    await expect(run?.result('c1', new AbortController().signal)).resolves.toEqual({ output: 'file.txt', isError: false })
  })
})
