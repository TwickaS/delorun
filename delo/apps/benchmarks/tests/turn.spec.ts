import { afterEach, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { checkTurn, PROJECT_DIRECTORY, READ_FILE, stockPatch, switchRows, textItems, TOOL_CALLS, toolItems, TOOLS, TURN_ITEMS, TURN_SCENARIOS, turnSuite, type FinishedTurn } from '../src/suites/turn/index.ts'
import { isTurnRequest, replyEvents, SIDE_TEXT, sseFrame, startModelStub, toolResultsOf, turnScript, type ModelStub, type StubExchange } from '../src/suites/turn/model-stub.ts'
import { authCookie, openFrame, parseDownlink, rpcBody, rpcValue, sessionIdOf, TurnRecorder, within } from '../src/suites/turn/studio-client.ts'

const stubs: ModelStub[] = []
afterEach(async () => {
  for (const stub of stubs.splice(0)) await stub.close()
})

/**
 * Post one Messages request to a stub and read the whole answer.
 * @param stub - the stub.
 * @param body - the request body.
 * @returns the status and the body text.
 */
async function post(stub: ModelStub, body: unknown): Promise<{ status: number, text: string }> {
  const response = await fetch(`${stub.baseURL}/v1/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  return { status: response.status, text: await response.text() }
}

/** A turn request: it carries the agent's tools. */
const TURN = { tools: [{ name: 'read' }], messages: [{ role: 'user', content: 'go' }] }

describe('the model stub script', () => {
  it('scripts one tool call per reply and then the answer, with ids unique per prefix', () => {
    const script = turnScript(2, { name: 'write', input: call => `{"n":${String(call)}}` }, ['Do', 'ne'], 't1')
    expect(script).toEqual([
      { kind: 'tool', id: 'toolu_t1_1', name: 'write', input: '{"n":1}' },
      { kind: 'tool', id: 'toolu_t1_2', name: 'write', input: '{"n":2}' },
      { kind: 'text', chunks: ['Do', 'ne'] },
    ])
    expect(turnScript(0, TOOLS.read, ['x'], 't2')).toEqual([{ kind: 'text', chunks: ['x'] }])
  })

  it('writes a tool reply as one tool_use block that stops for tool use', () => {
    const events = replyEvents({ kind: 'tool', id: 'toolu_1', name: 'read', input: '{"path":"a"}' })
    expect(events.map(event => event.type)).toEqual(['message_start', 'content_block_start', 'content_block_delta', 'content_block_stop', 'message_delta', 'message_stop'])
    expect(events[1]).toMatchObject({ content_block: { type: 'tool_use', id: 'toolu_1', name: 'read' } })
    expect(events[2]).toMatchObject({ delta: { type: 'input_json_delta', partial_json: '{"path":"a"}' } })
    expect(events[4]).toMatchObject({ delta: { stop_reason: 'tool_use' } })
  })

  it('writes a text reply as one delta per chunk that ends the turn', () => {
    const events = replyEvents({ kind: 'text', chunks: ['a', 'b'] })
    expect(events.filter(event => event.type === 'content_block_delta')).toHaveLength(2)
    expect(events.at(-2)).toMatchObject({ delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } })
    expect(sseFrame({ type: 'message_stop' })).toBe('event: message_stop\ndata: {"type":"message_stop"}\n\n')
  })

  it('tells turn requests from side requests by their tools', () => {
    expect(isTurnRequest(TURN)).toBe(true)
    expect(isTurnRequest({ tools: [] })).toBe(false)
    expect(isTurnRequest({ messages: [] })).toBe(false)
    expect(isTurnRequest([])).toBe(false)
    expect(isTurnRequest(null)).toBe(false)
  })

  it('reads the tool results of the last message', () => {
    const body = { messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'x' }, { type: 'tool_result', tool_use_id: 'toolu_2', is_error: true }, { type: 'text', text: 'y' }, 'bare', { type: 'tool_result' }] }] }
    expect(toolResultsOf(body)).toEqual([{ id: 'toolu_1', isError: false }, { id: 'toolu_2', isError: true }])
    expect(toolResultsOf({ messages: [{ role: 'user', content: 'text' }] })).toEqual([])
    expect(toolResultsOf({ messages: [] })).toEqual([])
    expect(toolResultsOf({ messages: 'none' })).toEqual([])
    expect(toolResultsOf(undefined)).toEqual([])
  })
})

describe('the model stub server', () => {
  it('answers turn requests from the script, side requests with a title, and records each exchange', async () => {
    const stub = await startModelStub()
    stubs.push(stub)
    stub.script(turnScript(1, TOOLS.read, ['Done'], 's'))
    const call = await post(stub, TURN)
    expect(call.status).toBe(200)
    expect(call.text).toContain('"stop_reason":"tool_use"')
    const side = await post(stub, { messages: [] })
    expect(side.text).toContain(SIDE_TEXT)
    const answer = await post(stub, { ...TURN, messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_s_1', content: 'x' }] }] })
    expect(answer.text).toContain('"text":"Done"')
    expect(stub.exchanges.map(exchange => exchange.turn)).toEqual([true, false, true])
    const [first, , last] = stub.exchanges
    expect(first!.firstTextAt).toBeUndefined()
    expect(first!.endedAt).toBeGreaterThanOrEqual(first!.arrivedAt)
    expect(last!.firstTextAt).toBeGreaterThanOrEqual(last!.arrivedAt)
    expect(last!.toolResults).toEqual([{ id: 'toolu_s_1', isError: false }])
    expect(stub.unscripted).toBe(0)
  })

  it('answers a turn request with no reply left with a 500 and counts it', async () => {
    const stub = await startModelStub()
    stubs.push(stub)
    expect((await post(stub, TURN)).status).toBe(500)
    expect(stub.unscripted).toBe(1)
    expect(stub.exchanges[0]!.endedAt).toBeDefined()
  })

  it('answers other paths with a 404 and treats an unreadable body as a side request', async () => {
    const stub = await startModelStub()
    stubs.push(stub)
    expect((await fetch(`${stub.baseURL}/v1/models`)).status).toBe(404)
    const response = await fetch(`${stub.baseURL}/v1/messages`, { method: 'POST', body: 'not json' })
    expect(await response.text()).toContain(SIDE_TEXT)
    expect(stub.exchanges).toHaveLength(1)
  })
})

describe('the studio client', () => {
  it('takes the dsh-auth cookie from the start link\'s answer', () => {
    expect(authCookie(['other=1; Path=/', 'dsh-auth-abc=v.1; Path=/; HttpOnly'])).toBe('dsh-auth-abc=v.1')
    expect(() => authCookie(['other=1'])).toThrow('no dsh-auth cookie')
  })

  it('wraps a unary call and reads its value or its error', () => {
    expect(rpcBody('session/create', { cwd: '/p' }, 'r1')).toEqual({ type: 'client-request', rpcId: 'r1', method: 'session/create', payload: { args: { request: { cwd: '/p' } } } })
    expect(rpcValue('session/create', 'r1', { type: 'server-response', rpcId: 'r1', result: { ok: true, value: { sessionId: 's' } } })).toEqual({ sessionId: 's' })
    expect(() => rpcValue('session/create', 'r1', { type: 'server-response', rpcId: 'r1', result: { ok: false, error: { code: 'x' } } })).toThrow('session/create failed: {"code":"x"}')
    expect(() => rpcValue('session/create', 'r1', { type: 'server-response', rpcId: 'r2', result: { ok: true } })).toThrow('no server-response')
    expect(() => rpcValue('session/create', 'r1', { type: 'other', rpcId: 'r1', result: { ok: true } })).toThrow('no server-response')
    expect(() => rpcValue('session/create', 'r1', { type: 'server-response', rpcId: 'r1', result: 'ok' })).toThrow('no server-response')
    expect(() => rpcValue('session/create', 'r1', null)).toThrow('no server-response')
  })

  it('opens a stream and reads the mux\'s frames', () => {
    expect(JSON.parse(openFrame('s1', 'session/follow', { activate: true }))).toEqual({ type: 'open', streamId: 's1', endpoint: 'session/follow', payload: { args: { request: { activate: true } } } })
    expect(parseDownlink('{"type":"item","streamId":"s1","value":{"type":"snapshot"}}')).toEqual({ type: 'item', streamId: 's1', value: { type: 'snapshot' } })
    expect(parseDownlink('{"type":"end","streamId":"s1"}')).toEqual({ type: 'end', streamId: 's1' })
    expect(parseDownlink('{"type":"error","streamId":"s1","error":{"code":"x"}}')).toEqual({ type: 'error', streamId: 's1', error: { code: 'x' } })
    expect(() => parseDownlink('{"type":"other","streamId":"s1"}')).toThrow('not a stream frame')
    expect(() => parseDownlink('{"type":"item"}')).toThrow('not a stream frame')
    expect(() => parseDownlink('[]')).toThrow('not a stream frame')
  })

  it('records the first text, each tool call and result, and the turn\'s end', async () => {
    const recorder = new TurnRecorder()
    const event = (type: string, data: unknown): unknown => ({ type: 'event', event: { type, data } })
    const chunk = (type: string): unknown => ({ type: 'assistant-stream', frame: { type: 'chunk', chunk: { type } } })
    recorder.take('noise', 1)
    recorder.take({ type: 'snapshot' }, 2)
    recorder.take({ type: 'assistant-stream', frame: { type: 'start' } }, 3)
    recorder.take({ type: 'assistant-stream', frame: 'bad' }, 3)
    recorder.take({ type: 'assistant-stream', frame: { type: 'chunk', chunk: 'bad' } }, 3)
    recorder.take(chunk('reasoning-delta'), 4)
    recorder.take({ type: 'event', event: 'bad' }, 5)
    recorder.take({ type: 'event', event: { type: 'turn/start' } }, 5)
    recorder.take(event('tool/call', { callId: 'c1' }), 10)
    recorder.take(event('tool/call', { callId: 7 }), 10)
    recorder.take(event('tool/result', { message: { toolCallId: 'c1' } }), 12)
    recorder.take(event('tool/call', { callId: 'c2' }), 13)
    recorder.take(event('tool/result', { message: { toolCallId: 'c2', isError: true } }), 14)
    recorder.take(event('tool/call', { callId: 'c3' }), 15)
    recorder.take(event('tool/result', { message: { toolCallId: 'c3' }, error: { code: 'x' } }), 16)
    recorder.take(event('tool/result', { message: { toolCallId: 'unknown' } }), 17)
    recorder.take(event('tool/result', { message: 'bad' }), 17)
    recorder.take(chunk('text-delta'), 20)
    recorder.take(chunk('text-delta'), 21)
    recorder.take(event('turn/end', { reason: { kind: 'completed' } }), 30)
    recorder.take(event('turn/end', { reason: { kind: 'error' } }), 31)
    await recorder.ended
    expect(recorder.times()).toEqual({
      firstText: 20,
      end: 30,
      endReason: 'completed',
      tools: [
        { callId: 'c1', call: 10, result: 12, isError: false },
        { callId: 'c2', call: 13, result: 14, isError: true },
        { callId: 'c3', call: 15, result: 16, isError: true },
      ],
    })
    const bare = new TurnRecorder()
    bare.take(event('turn/end', {}), 5)
    expect(bare.times()).toMatchObject({ end: 5, endReason: undefined })
  })

  it('fails the wait for a turn when the follow stream fails first', async () => {
    const recorder = new TurnRecorder()
    recorder.fail('session/follow ended')
    await expect(recorder.ended).rejects.toThrow('session/follow ended')
    new TurnRecorder().fail('nobody waits')
  })

  it('reads the created chat\'s id', () => {
    expect(sessionIdOf({ sessionId: 's1', agentPreset: 'p' })).toBe('s1')
    expect(() => sessionIdOf({ sessionId: '' })).toThrow('no session id')
    expect(() => sessionIdOf({})).toThrow('no session id')
    expect(() => sessionIdOf('s1')).toThrow('no session id')
  })

  it('waits for a promise no longer than its deadline', async () => {
    await expect(within(Promise.resolve(3), 1000, 'three')).resolves.toBe(3)
    await expect(within(Promise.reject(new Error('own')), 1000, 'three')).rejects.toThrow('own')
    await expect(within(new Promise(() => {}), 5, 'nothing')).rejects.toThrow('nothing did not happen within 0.005 seconds')
  })
})

/**
 * A stub exchange.
 * @param fields - the fields that differ from a text reply that arrived at 0.
 * @returns the exchange.
 */
function exchange(fields: Partial<StubExchange>): StubExchange {
  return { turn: true, arrivedAt: 0, firstTextAt: undefined, endedAt: undefined, reply: { kind: 'text', chunks: ['x'] }, toolResults: [], ...fields }
}

/** A turn with two read calls that ran as scripted. */
const TOOL_TURN: FinishedTurn = {
  sentAt: 100,
  times: { firstText: 400, end: 450, endReason: 'completed', tools: [{ callId: 'a', call: 150, result: 160, isError: false }, { callId: 'b', call: 250, result: 260, isError: false }] },
  requests: [
    exchange({ arrivedAt: 110, endedAt: 120, reply: { kind: 'tool', id: 'a', name: 'read', input: '{}' } }),
    exchange({ arrivedAt: 200, endedAt: 210, reply: { kind: 'tool', id: 'b', name: 'read', input: '{}' }, toolResults: [{ id: 'a', isError: false }] }),
    exchange({ arrivedAt: 290, firstTextAt: 300, endedAt: 310, toolResults: [{ id: 'b', isError: false }] }),
  ],
}

describe('the turn suite', () => {
  it('declares its scenarios, items and workload', () => {
    expect(turnSuite.id).toBe('turn')
    expect(turnSuite.scenarios.map(scenario => scenario.id)).toEqual(TURN_SCENARIOS.map(scenario => scenario.id))
    expect(Object.keys(TURN_ITEMS)).toContain('read')
    expect(TOOL_CALLS).toBeGreaterThan(1)
    expect(JSON.parse(TOOLS.read.input(1))).toEqual({ file_path: READ_FILE })
    expect(JSON.parse(TOOLS.write.input(3))).toMatchObject({ file_path: 'written-03.txt' })
    expect(PROJECT_DIRECTORY).not.toContain('.delo')
  })

  it('finds the switch rows the bundle inserts and restates them disabled', () => {
    const bundle = readFileSync(new URL('../../../packages/bundle-local/cordis.patch.yml', import.meta.url), 'utf8')
    const rows = switchRows(bundle)
    expect(rows).toEqual(['delo-instruction-consent', 'delo-mcp-consent', 'delo-permission-defaults', 'delo-schedule-consent', 'delo-fetch-guard', 'delo-update-gate'])
    expect(stockPatch(rows.slice(0, 1))).toBe('- id: delo-instruction-consent\n  disabled: true\n')
    expect(switchRows('- insert:\n    - id: a\n      config:\n        enabled: true\n        enabled: true\n- id: b\n  config:\n    enabled: true\n')).toEqual(['a'])
    expect(() => stockPatch([])).toThrow('no switch row')
  })

  it('accepts a turn that ran as scripted and names each difference of one that did not', () => {
    expect(() => { checkTurn(TOOL_TURN, 2, 'read') }).not.toThrow()
    const refused = { ...TOOL_TURN, times: { ...TOOL_TURN.times, tools: [TOOL_TURN.times.tools[0]!, { ...TOOL_TURN.times.tools[1]!, isError: true }] } }
    expect(() => { checkTurn(refused, 2, 'read') }).toThrow('the client saw 2 tool calls with 1 good results')
    const broken: FinishedTurn = {
      sentAt: 100,
      times: { firstText: undefined, end: 450, endReason: 'error', tools: [{ callId: 'a', call: 150, result: undefined, isError: false }] },
      requests: [
        exchange({ reply: { kind: 'tool', id: 'a', name: 'read', input: '{}' } }),
        exchange({ reply: { kind: 'tool', id: 'b', name: 'read', input: '{}' }, toolResults: [{ id: 'a', isError: true }] }),
        exchange({ toolResults: [] }),
      ],
    }
    expect(() => { checkTurn(broken, 3, 'read') }).toThrow('the read turn did not run as scripted: it ended error; the model got 3 requests for 4 replies; tool call 1 failed or was refused; request 3 carried no result for the call before it; the client saw 1 tool calls with 0 good results; the client saw no text')
  })

  it('reads a text turn\'s items, cold and warm', () => {
    const turn: FinishedTurn = { sentAt: 100, times: { firstText: 180, end: 220, endReason: 'completed', tools: [] }, requests: [exchange({ arrivedAt: 150, firstTextAt: 160, endedAt: 170 })] }
    expect(textItems(turn, true)).toEqual({ 'first-token-cold': 80, 'turn-end-cold': 120 })
    expect(textItems(turn, false)).toEqual({ 'first-token': 80, 'turn-end': 120, 'to-model': 50, 'token-delivery': 20, 'model-to-end': 50 })
    expect(textItems({ ...turn, requests: [] }, false)).toEqual({ 'first-token': 80, 'turn-end': 120 })
  })

  it('reads a tool turn\'s first call, later calls and whole turn', () => {
    expect(toolItems(TOOL_TURN, 'read')).toEqual({ 'read-first': [80], 'read': [80], 'read-turn': [350] })
    const open: FinishedTurn = { ...TOOL_TURN, times: { ...TOOL_TURN.times, end: undefined }, requests: [exchange({}), exchange({ arrivedAt: 5 })] }
    expect(toolItems(open, 'write')).toEqual({ 'write-first': [], 'write': [], 'write-turn': [] })
  })
})
