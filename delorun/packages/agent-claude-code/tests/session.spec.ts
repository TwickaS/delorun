import { describe, expect, it, vi } from 'vitest'
import type { SpawnedProcess } from '@anthropic-ai/claude-agent-sdk'
import { ClaudeCodeDriver } from '../src/driver.ts'
import { ClaudeCodeDriverError } from '../src/errors.ts'
import { GateProcess } from '../src/process.ts'
import { ProgramOpenError, type AccountObservation, type ProgramEvent, type ProgramOpenRequest, type ProgramSession, type SessionId } from '@delorun/external-agents/contract'
import { assistant, FakeSdk, init, rateLimit, result, toolResults } from './fake-sdk.ts'

const signal = AbortSignal.timeout(5_000)

const TOOLS_PRESENT = { platform: 'linux', path: '/bin', exists: () => true } as const
const TOOLS_MISSING = { platform: 'linux', path: '/bin', exists: () => false } as const

function driver(sdk: FakeSdk, machine: () => typeof TOOLS_PRESENT | typeof TOOLS_MISSING = () => TOOLS_PRESENT): ClaudeCodeDriver {
  return new ClaudeCodeDriver({
    sdk: () => Promise.resolve(sdk),
    harnessToolTimeoutMs: () => 900_000, level: () => 'standard', machine,
    spawnOption: () => () => { throw new Error('a unit spec starts no process') },
  })
}

function request(overrides: Partial<ProgramOpenRequest> = {}): ProgramOpenRequest {
  return {
    sessionId: 'child-1' as SessionId,
    cwd: '/tmp/task',
    runRules: [],
    harnessTools: [],
    sharesFolder: () => false,
    spawn: () => { throw new Error('a unit spec starts no process') },
    onApproval: () => Promise.resolve('reject'),
    onLimits: () => {},
    signal: new AbortController().signal,
    ...overrides,
  }
}

async function take(session: ProgramSession, count: number): Promise<ProgramEvent[]> {
  const events: ProgramEvent[] = []
  for (let index = 0; index < count; index += 1) events.push(await session.next(signal))
  return events
}

async function until(session: ProgramSession, kind: ProgramEvent['kind']): Promise<ProgramEvent[]> {
  const events: ProgramEvent[] = []
  for (;;) {
    const event = await session.next(signal)
    events.push(event)
    if (event.kind === kind) return events
  }
}

describe('a Claude Code session', () => {
  it('maps one program turn to text, reasoning, calls, message ends, results and the turn end, which carries only tokens no message end reported', async () => {
    const sdk = new FakeSdk()
    const session = await driver(sdk).open(request())
    await session.send('make a file', 'start')
    expect(session.turnRunning).toBe(true)
    const query = sdk.last
    query.emit(init('program-1'))
    query.emit(assistant('m1', [{ type: 'thinking', thinking: 'plan', signature: 'x' }]))
    query.emit(assistant('m1', [{ type: 'text', text: 'Making it.' }]))
    query.emit(assistant('m1', [{ type: 'tool_use', id: 'call-1', name: 'Bash', input: { command: 'touch a.txt' } }], { usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 50 } }))
    query.emit(toolResults([{ id: 'call-1', content: [{ type: 'text', text: 'ok' }] }]))
    query.emit(assistant('m2', [{ type: 'text', text: 'Done.' }], { usage: { input_tokens: 130, output_tokens: 4 } }))
    query.emit(result({ usage: { input_tokens: 240, output_tokens: 30 } }))
    expect(await take(session, 8)).toEqual([
      { kind: 'reasoning', text: 'plan' },
      { kind: 'text', text: 'Making it.' },
      { kind: 'tool-call', id: 'call-1', name: 'Bash', input: '{"command":"touch a.txt"}' },
      { kind: 'message-end', usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 50 } },
      { kind: 'tool-result', id: 'call-1', output: 'ok', isError: false },
      { kind: 'text', text: 'Done.' },
      { kind: 'message-end', usage: { inputTokens: 130, outputTokens: 4 } },
      { kind: 'turn-end', outcome: 'completed', usage: { inputTokens: 10, outputTokens: 6 } },
    ])
    expect(session.turnRunning).toBe(false)
    expect(session.programSessionId).toBe('program-1')
    await session.close()
  })

  it('leaves the frames of the program\'s own sub-agents inside the call that started them', async () => {
    const sdk = new FakeSdk()
    const session = await driver(sdk).open(request())
    await session.send('delegate', 'start')
    const query = sdk.last
    query.emit(assistant('m1', [{ type: 'tool_use', id: 'task-1', name: 'Task', input: {} }]))
    query.emit(assistant('sub', [{ type: 'text', text: 'inner' }], { parent: 'task-1' }))
    query.emit(toolResults([{ id: 'inner-call', content: 'inner result' }], 'task-1'))
    query.emit(toolResults([{ id: 'task-1', content: 'report', isError: true }]))
    query.emit(result())
    expect((await until(session, 'turn-end')).map(event => event.kind)).toEqual(['tool-call', 'message-end', 'tool-result', 'turn-end'])
    await session.close()
  })

  it('sends a new turn as plain input and a steer with priority next', async () => {
    const sdk = new FakeSdk()
    const session = await driver(sdk).open(request())
    await session.send('first', 'start')
    await session.send('also this', 'steer')
    sdk.last.emit(result())
    await until(session, 'turn-end')
    await session.close()
    await sdk.last.inputEnded()
    expect(sdk.last.sent.map(message => ({ content: message.message.content, priority: message.priority }))).toEqual([
      { content: 'first', priority: undefined },
      { content: 'also this', priority: 'next' },
    ])
  })

  it('refuses a steer with no turn running and a second start while one runs', async () => {
    const sdk = new FakeSdk()
    const session = await driver(sdk).open(request())
    await expect(session.send('late', 'steer')).rejects.toMatchObject({ code: 'no-turn' })
    await session.send('first', 'start')
    await expect(session.send('second', 'start')).rejects.toMatchObject({ code: 'turn-running' })
    await session.close()
  })

  it('keeps one seat turn when a steer makes the program run a further turn, adding its usage', async () => {
    const sdk = new FakeSdk()
    const session = await driver(sdk).open(request())
    await session.send('first', 'start')
    sdk.last.emit(result({ queued_turn_count: 1, usage: { input_tokens: 10, output_tokens: 1 } }))
    sdk.last.emit(assistant('m2', [{ type: 'text', text: 'banana' }]))
    sdk.last.emit(result({ usage: { input_tokens: 20, output_tokens: 2 } }))
    expect(await until(session, 'turn-end')).toEqual([
      { kind: 'text', text: 'banana' },
      { kind: 'message-end' },
      { kind: 'turn-end', outcome: 'completed', usage: { inputTokens: 30, outputTokens: 3 } },
    ])
    await session.close()
  })

  it('interrupts the running turn, which ends interrupted, and stays usable', async () => {
    const sdk = new FakeSdk()
    const session = await driver(sdk).open(request())
    expect(await session.interrupt()).toBe('interrupted')
    expect(sdk.last.interrupts).toBe(0)
    await session.send('long task', 'start')
    expect(await session.interrupt()).toBe('interrupted')
    expect(sdk.last.interrupts).toBe(1)
    sdk.last.emit(result({ subtype: 'error_during_execution', is_error: true }))
    expect(await until(session, 'turn-end')).toEqual([{ kind: 'turn-end', outcome: 'interrupted', usage: { inputTokens: 10, outputTokens: 5 } }])
    await session.send('next task', 'start')
    sdk.last.emit(result())
    expect((await until(session, 'turn-end')).at(-1)).toMatchObject({ outcome: 'completed' })
    await session.close()
  })

  it('reports a failed turn with the program\'s own words for the person, cut to a short detail', async () => {
    const sdk = new FakeSdk()
    const session = await driver(sdk).open(request())
    await session.send('go', 'start')
    sdk.last.emit(result({ subtype: 'error_max_turns', is_error: true, errors: ['x'.repeat(800)] }))
    const [end] = await until(session, 'turn-end')
    expect(end).toMatchObject({ kind: 'turn-end', outcome: 'failed', failure: { category: 'program' } })
    expect(end?.kind === 'turn-end' && end.failure?.category === 'program' ? end.failure.detail.length : 0).toBe(501)
    await session.close()
  })

  it('reports a signed-out program from its authentication error', async () => {
    const sdk = new FakeSdk()
    const session = await driver(sdk).open(request())
    await session.send('go', 'start')
    sdk.last.emit(assistant('m1', [{ type: 'text', text: 'Invalid API key · Please run /login' }], { error: 'authentication_failed' }))
    sdk.last.emit(result({ is_error: true, result: 'Invalid API key · Please run /login' }))
    expect((await until(session, 'turn-end')).at(-1)).toMatchObject({ outcome: 'failed', failure: { category: 'signed-out' } })
    await session.close()
  })

  it('reports a reached limit with its reset time, and passes the run\'s rate-limit events on', async () => {
    const sdk = new FakeSdk()
    const seen: AccountObservation[] = []
    const session = await driver(sdk).open(request({ onLimits: (observation) => { seen.push(observation) } }))
    await session.send('go', 'start')
    sdk.last.emit(rateLimit({ status: 'rejected', rateLimitType: 'five_hour', utilization: 1, resetsAt: 1_800_000_000 }))
    sdk.last.emit(assistant('m1', [{ type: 'text', text: 'limit reached' }], { error: 'rate_limit' }))
    sdk.last.emit(result({ is_error: true, result: 'limit reached' }))
    expect((await until(session, 'turn-end')).at(-1)).toMatchObject({ outcome: 'failed', failure: { category: 'limit', resetsAt: 1_800_000_000_000 } })
    expect(seen).toEqual([{ provider: 'claude-code', signedIn: 'yes', windows: [{ kind: 'five_hour', usedPercent: 100, resetsAt: 1_800_000_000_000, status: 'reached' }], source: 'run' }])
    await session.close()
  })

  it('reports a model the plan does not offer with the models it does', async () => {
    const sdk = new FakeSdk()
    const session = await driver(sdk).open(request({ model: 'claude-old' }))
    expect(sdk.last.options.model).toBe('claude-old')
    sdk.last.models = [
      { value: 'default', displayName: 'Default (recommended)', description: '' },
      { value: 'sonnet', displayName: 'Sonnet', description: '' },
    ]
    await session.send('go', 'start')
    sdk.last.emit(assistant('m1', [{ type: 'text', text: 'model not found' }], { error: 'model_not_found' }))
    sdk.last.emit(result({ is_error: true, result: 'model not found' }))
    expect((await until(session, 'turn-end')).at(-1)).toMatchObject({
      outcome: 'failed',
      failure: { category: 'model-not-offered', configured: 'claude-old', offered: [{ id: 'default', displayName: 'Default (recommended)', isDefault: true }, { id: 'sonnet', displayName: 'Sonnet', isDefault: false }] },
    })
    await session.close()
  })

  it('resumes by the program\'s session id, and reports resume-failed when the program ends before it starts', async () => {
    const sdk = new FakeSdk()
    const session = await driver(sdk).open(request({ resume: 'program-gone' }))
    expect(sdk.last.options.resume).toBe('program-gone')
    expect(sdk.last.options.sessionId).toBeUndefined()
    expect(session.programSessionId).toBe('program-gone')
    await session.send('hello again', 'start')
    sdk.last.finish(new Error('Claude Code process exited with code 1'))
    expect(await until(session, 'turn-end')).toEqual([{ kind: 'turn-end', outcome: 'failed', failure: { category: 'resume-failed' } }])
    await session.close()
  })

  it('gives a new session a fresh program session id', async () => {
    const sdk = new FakeSdk()
    const session = await driver(sdk).open(request())
    expect(sdk.last.options.sessionId).toBe(session.programSessionId)
    expect(session.programSessionId).toMatch(/^[0-9a-f-]{36}$/)
    await session.close()
  })

  it('fails the next turn at once when the program ended while idle', async () => {
    const sdk = new FakeSdk()
    const session = await driver(sdk).open(request())
    sdk.last.finish(new Error('Claude Code process exited with code 137'))
    await vi.waitFor(async () => {
      await session.send('anyone there?', 'start')
      expect(await session.next(signal)).toMatchObject({ kind: 'turn-end', outcome: 'failed', failure: { category: 'program', detail: 'Claude Code process exited with code 137' } })
    })
    await session.close()
  })

  it('closes: the query ends, input ends, and later calls are refused', async () => {
    const sdk = new FakeSdk()
    const session = await driver(sdk).open(request())
    await session.close()
    await session.close()
    expect(sdk.last.closed).toBe(true)
    await sdk.last.inputEnded()
    await expect(session.next(signal)).rejects.toBeInstanceOf(ClaudeCodeDriverError)
    await expect(session.send('late', 'start')).rejects.toMatchObject({ code: 'closed' })
  })

  it('closes when the gate aborts the open request\'s signal', async () => {
    const sdk = new FakeSdk()
    const controller = new AbortController()
    await driver(sdk).open(request({ signal: controller.signal }))
    controller.abort()
    await vi.waitFor(() => { expect(sdk.last.closed).toBe(true) })
  })

  it('loads the person\'s own settings and default mode, sets the harness tool wait limit and keeps AskUserQuestion away from the program', async () => {
    const sdk = new FakeSdk()
    const session = await driver(sdk).open(request({ level: 'own' }))
    expect(sdk.last.options.env?.MCP_TOOL_TIMEOUT).toBe('900000')
    expect(sdk.last.options.disallowedTools).toEqual(['AskUserQuestion'])
    expect(sdk.last.options.settingSources).toEqual(['user', 'project', 'local'])
    expect(sdk.last.options.permissionMode).toBeUndefined()
    expect(sdk.last.options.sandbox).toBeUndefined()
    expect(sdk.last.options.cwd).toBe('/tmp/task')
    expect(sdk.last.options.allowedTools).toBeUndefined()
    await session.close()
  })

  it('runs Careful in the command sandbox with no network and no web tools, asking the person for the rest', async () => {
    const sdk = new FakeSdk()
    const session = await driver(sdk).open(request({ level: 'careful' }))
    expect(sdk.last.options.permissionMode).toBe('default')
    expect(sdk.last.options.sandbox).toMatchObject({
      enabled: true, failIfUnavailable: true, allowUnsandboxedCommands: false, filesystem: { allowWrite: ['/tmp/task'] }, network: { allowedDomains: [] },
    })
    expect(sdk.last.options.disallowedTools).toEqual(['AskUserQuestion', 'WebFetch', 'WebSearch'])
    expect(sdk.last.options.allowDangerouslySkipPermissions).toBeUndefined()
    await session.close()
  })

  it('refuses to open Careful without the sandbox\'s tools, naming the install line', async () => {
    const opening = driver(new FakeSdk(), () => TOOLS_MISSING).open(request({ level: 'careful' }))
    await expect(opening).rejects.toBeInstanceOf(ProgramOpenError)
    await expect(opening).rejects.toMatchObject({ failure: { category: 'program', detail: expect.stringContaining('sudo apt install bubblewrap socat') } })
  })

  it('runs Standard in the sandbox with the task folder and /tmp writable and the network open', async () => {
    const sdk = new FakeSdk()
    const session = await driver(sdk).open(request({ level: 'standard' }))
    expect(sdk.last.options.permissionMode).toBe('auto')
    expect(sdk.last.options.sandbox).toMatchObject({ enabled: true, filesystem: { allowWrite: ['/tmp/task', '/tmp'] }, network: { allowedDomains: ['*'] } })
    expect(sdk.last.options.disallowedTools).toEqual(['AskUserQuestion'])
    await session.close()
  })

  it('states that Standard has no sandbox when its tools are missing, instead of failing', async () => {
    const sdk = new FakeSdk()
    const session = await driver(sdk, () => TOOLS_MISSING).open(request({ level: 'standard' }))
    expect(sdk.last.options.sandbox).toEqual({ enabled: false })
    expect(sdk.last.options.permissionMode).toBe('default')
    await session.close()
  })

  it('bypasses permissions with no sandbox at Unrestricted', async () => {
    const sdk = new FakeSdk()
    const session = await driver(sdk).open(request({ level: 'unrestricted' }))
    expect(sdk.last.options.permissionMode).toBe('bypassPermissions')
    expect(sdk.last.options.allowDangerouslySkipPermissions).toBe(true)
    expect(sdk.last.options.sandbox).toEqual({ enabled: false })
    await session.close()
  })

  it('uses the driver\'s own level when the open names none', async () => {
    const sdk = new FakeSdk()
    const session = await driver(sdk).open(request())
    expect(sdk.last.options.permissionMode).toBe('auto')
    await session.close()
  })

  it('fails to open with the contract\'s typed failure, in words for the person, when the SDK cannot be used', async () => {
    const refusing = new ClaudeCodeDriver({
      sdk: () => Promise.reject(new ClaudeCodeDriverError('sdk-version', 'Update Delorun or the Claude Code pack.')),
      harnessToolTimeoutMs: () => 1, level: () => 'standard',
    })
    const opening = refusing.open(request())
    await expect(opening).rejects.toBeInstanceOf(ProgramOpenError)
    await expect(opening).rejects.toMatchObject({ failure: { category: 'program', detail: 'Update Delorun or the Claude Code pack.' } })
  })

  it('starts the program only through the spawn the gate hands it', async () => {
    const sdk = new FakeSdk()
    const spawned: string[] = []
    const gateSpawn = vi.fn(() => { throw new Error('not started') })
    const opened = await new ClaudeCodeDriver({
      sdk: () => Promise.resolve(sdk),
      harnessToolTimeoutMs: () => 1, level: () => 'standard',
      spawnOption: spawn => (options): SpawnedProcess => {
        spawned.push(options.command)
        return new GateProcess(spawn({ argv: [options.command], env: {}, stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' } }))
      },
    }).open(request({ spawn: gateSpawn }))
    expect(() => sdk.last.options.spawnClaudeCodeProcess?.({ command: 'claude', args: [], cwd: '/tmp/task', env: {}, signal })).toThrow('not started')
    expect(gateSpawn).toHaveBeenCalledOnce()
    expect(spawned).toEqual(['claude'])
    await opened.close()
  })
})
