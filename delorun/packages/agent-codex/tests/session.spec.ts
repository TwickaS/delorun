import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, onTestFinished } from 'vitest'
import type { AccountObservation, ProgramApprovalAnswer, ProgramApprovalRequest, ProgramEvent, ProgramRunRule } from '@delorun/external-agents/contract'
import type { HarnessServer } from '../src/harness-server.ts'
import { holdRunFolder } from '../src/leftovers.ts'
import { levelPolicy, type TurnSandbox } from '../src/levels.ts'
import { CodexRpc } from '../src/rpc.ts'
import { CodexSession, CodexSessionClosedError, CodexTurnRunningError } from '../src/session.ts'
import { FakeAppServer, settle, type Frame } from './fake-app-server.ts'
import {
  COMMAND, EXEC, NEXT_TURN, TASK, THREAD, TURN, commandApproval, commandItem, itemFrame, rateLimits, tokenUsage,
  turnCompleted, turnStarted,
} from './recorded.ts'

interface Harness {
  readonly codex: FakeAppServer
  readonly session: CodexSession
  readonly questions: ProgramApprovalRequest[]
  readonly limits: AccountObservation[]
  /** Answers the next question; the default answer is set per test. */
  answer: (request: ProgramApprovalRequest) => Promise<ProgramApprovalAnswer>
}

/** The Standard level's turn sandbox for the task folder. */
const STANDARD_TURN = levelPolicy('standard', TASK, 'on-request').turn

function harness(options: {
  readonly requestTimeoutMs?: number
  readonly runRules?: readonly ProgramRunRule[]
  readonly cleanUp?: () => void
  readonly harness?: HarnessServer
  /** The turn sandbox; `null` keeps the thread's own. */
  readonly turnSandbox?: TurnSandbox | null
} = {}): Harness {
  const codex = new FakeAppServer()
  const questions: ProgramApprovalRequest[] = []
  const limits: AccountObservation[] = []
  const h: Harness = {
    codex,
    questions,
    limits,
    answer: () => Promise.resolve('reject'),
    session: new CodexSession({
      handle: codex.handle,
      rpc: new CodexRpc(codex.stdout, codex.stdin),
      onApproval: (request) => {
        questions.push(request)
        return h.answer(request)
      },
      onLimits: (observation) => { limits.push(observation) },
      requestTimeoutMs: options.requestTimeoutMs ?? 5_000,
      closeWaitMs: 50,
      runRules: options.runRules ?? [],
      cleanUp: options.cleanUp ?? (() => {}),
      ...options.harness === undefined ? {} : { harness: options.harness },
    }),
  }
  h.session.attach(THREAD, options.turnSandbox === null ? undefined : options.turnSandbox ?? STANDARD_TURN)
  codex.answer('turn/start', { result: { turn: { id: TURN, items: [], itemsView: 'notLoaded', status: 'inProgress', error: null } } })
  codex.answer('turn/steer', { result: { turnId: TURN } })
  codex.answer('turn/interrupt', { result: {} })
  return h
}

/** Start a turn the way the recorded run did: the answer to `turn/start` arrives before `turn/started`. */
async function startTurn(h: Harness, text = 'Run this shell command exactly: touch made-by-codex.txt. Then say done.'): Promise<void> {
  await h.session.send(text, 'start')
  h.codex.notify('turn/started', turnStarted())
  await settle()
}

/** Take every event until the turn ends. */
async function untilTurnEnd(session: CodexSession): Promise<ProgramEvent[]> {
  const events: ProgramEvent[] = []
  const signal = AbortSignal.timeout(2_000)
  for (;;) {
    const event = await session.next(signal)
    events.push(event)
    if (event.kind === 'turn-end') return events
  }
}

const kinds = (events: readonly ProgramEvent[]): string[] => events.map(event => event.kind)

describe('turns', () => {
  it('starts a turn with turn/start on its thread and maps a recorded command turn to ordered events', async () => {
    const h = harness()
    await startTurn(h)
    expect(h.codex.requests('turn/start')).toEqual([{
      threadId: THREAD,
      input: [{ type: 'text', text: 'Run this shell command exactly: touch made-by-codex.txt. Then say done.', text_elements: [] }],
      sandboxPolicy: { type: 'workspaceWrite', writableRoots: [TASK], networkAccess: true, excludeTmpdirEnvVar: false, excludeSlashTmp: false },
    }])
    expect(h.session.turnRunning).toBe(true)
    h.codex.notify('item/started', itemFrame(commandItem('inProgress')))
    h.codex.notify('item/completed', itemFrame(commandItem('completed', 0)))
    h.codex.notify('thread/tokenUsage/updated', tokenUsage(1200, 1000, 40))
    h.codex.notify('item/completed', itemFrame({ type: 'reasoning', id: 'rs_1', summary: ['Writing the answer.'], content: [] }))
    h.codex.notify('item/completed', itemFrame({ type: 'agentMessage', id: 'msg_0c90', text: 'done', phase: 'final_answer' }))
    h.codex.notify('thread/tokenUsage/updated', tokenUsage(1300, 1200, 2))
    h.codex.notify('turn/completed', turnCompleted('completed'))
    const events = await untilTurnEnd(h.session)
    expect(events).toEqual([
      { kind: 'tool-call', id: EXEC, name: 'shell', input: JSON.stringify({ command: COMMAND, cwd: TASK }) },
      { kind: 'message-end' },
      { kind: 'tool-result', id: EXEC, output: '', isError: false },
      { kind: 'reasoning', text: 'Writing the answer.' },
      { kind: 'text', text: 'done' },
      // Codex reports a request's usage after its tool call's message has ended, so both requests land on the next message.
      { kind: 'message-end', usage: { inputTokens: 300, outputTokens: 42, totalTokens: 2542, cacheReadTokens: 2200, reasoningTokens: 6 } },
      { kind: 'turn-end', outcome: 'completed' },
    ])
    expect(h.session.turnRunning).toBe(false)
  })

  it('shows an agent message that arrives whole, without deltas, once', async () => {
    const h = harness()
    await startTurn(h)
    h.codex.notify('item/completed', itemFrame({ type: 'agentMessage', id: 'msg_1', text: 'blue' }))
    h.codex.notify('turn/completed', turnCompleted('completed'))
    expect(kinds(await untilTurnEnd(h.session))).toEqual(['text', 'message-end', 'turn-end'])
  })

  it('steers the running turn with turn/steer naming the expected turn', async () => {
    const h = harness()
    await startTurn(h)
    await h.session.send('Also end your reply with the word banana.', 'steer')
    expect(h.codex.requests('turn/steer')).toEqual([{ threadId: THREAD, input: [{ type: 'text', text: 'Also end your reply with the word banana.', text_elements: [] }], expectedTurnId: TURN }])
    expect(h.codex.requests('turn/start')).toHaveLength(1)
  })

  it('starts the next turn with a steer that arrives after the turn ended', async () => {
    const h = harness()
    await startTurn(h)
    h.codex.answer('turn/steer', () => {
      h.codex.notify('turn/completed', turnCompleted('completed'))
      return { error: { code: -32600, message: 'no active turn' } }
    })
    h.codex.answer('turn/start', { result: { turn: { id: NEXT_TURN, items: [], itemsView: 'notLoaded', status: 'inProgress', error: null } } })
    await h.session.send('late steer', 'steer')
    expect(h.codex.requests('turn/start')).toHaveLength(2)
    expect(h.session.turnRunning).toBe(true)
  })

  it('refuses a second start while a turn runs', async () => {
    const h = harness()
    await startTurn(h)
    await expect(h.session.send('again', 'start')).rejects.toBeInstanceOf(CodexTurnRunningError)
  })

  it('ignores items of a turn that has ended, so a late item/completed reaches no one', async () => {
    const h = harness()
    await startTurn(h)
    h.codex.notify('turn/completed', turnCompleted('completed'))
    await untilTurnEnd(h.session)
    h.codex.answer('turn/start', { result: { turn: { id: NEXT_TURN, items: [], itemsView: 'notLoaded', status: 'inProgress', error: null } } })
    await h.session.send('next', 'start')
    h.codex.notify('turn/started', turnStarted(NEXT_TURN))
    h.codex.notify('item/completed', itemFrame(commandItem('completed', 0), TURN))
    h.codex.notify('item/completed', itemFrame({ type: 'agentMessage', id: 'msg_stale', text: 'stale' }, TURN))
    h.codex.notify('turn/completed', turnCompleted('completed', NEXT_TURN))
    expect(kinds(await untilTurnEnd(h.session))).toEqual(['turn-end'])
  })

  it('reports rate limits seen during a run without personal fields', async () => {
    const h = harness()
    h.codex.notify('account/rateLimits/updated', { rateLimits: { ...rateLimits(40), accountId: 'acct-person' } })
    await settle()
    expect(h.limits).toEqual([{
      provider: 'codex', signedIn: 'yes', plan: 'free', source: 'run',
      windows: [
        { kind: 'window_43200m', usedPercent: 40, resetsAt: 1797520635000, status: 'allowed' },
        { kind: 'five_hour', usedPercent: 12, resetsAt: 1794940000000, status: 'allowed' },
      ],
    }])
  })
})

describe('failures', () => {
  it('ends a failed turn with the program failure, Codex message in the detail', async () => {
    const h = harness()
    await startTurn(h)
    const error = { message: 'stream disconnected', codexErrorInfo: 'other', additionalDetails: null }
    h.codex.notify('error', { error, willRetry: false, threadId: THREAD, turnId: TURN })
    h.codex.notify('turn/completed', turnCompleted('failed', TURN, error))
    expect((await untilTurnEnd(h.session)).at(-1)).toEqual({ kind: 'turn-end', outcome: 'failed', failure: { category: 'program', detail: 'stream disconnected' } })
  })

  it('maps a reached usage limit to the limit failure with the reached window\'s reset time', async () => {
    const h = harness()
    await startTurn(h)
    h.codex.notify('account/rateLimits/updated', { rateLimits: rateLimits(100, 'rate_limit_reached') })
    h.codex.notify('turn/completed', turnCompleted('failed', TURN, { message: 'usage limit', codexErrorInfo: 'usageLimitExceeded' }))
    expect((await untilTurnEnd(h.session)).at(-1)).toMatchObject({ outcome: 'failed', failure: { category: 'limit', resetsAt: 1797520635000 } })
  })

  it('maps an unauthorised turn to signed-out', async () => {
    const h = harness()
    await startTurn(h)
    h.codex.notify('turn/completed', turnCompleted('failed', TURN, { message: 'x', codexErrorInfo: { responseStreamConnectionFailed: { httpStatusCode: 401 } } }))
    expect((await untilTurnEnd(h.session)).at(-1)).toMatchObject({ failure: { category: 'signed-out' } })
  })

  it('ends the running turn as failed when the process exits, and refuses later input', async () => {
    const h = harness()
    await startTurn(h)
    h.codex.notify('item/started', itemFrame(commandItem('inProgress')))
    await settle()
    h.codex.end({ exitCode: 1, signal: null })
    const events = await untilTurnEnd(h.session)
    expect(events.slice(-2)).toEqual([
      { kind: 'tool-result', id: EXEC, output: 'The call did not finish before the turn ended.', isError: true },
      { kind: 'turn-end', outcome: 'failed', failure: { category: 'program', detail: 'Codex stopped unexpectedly.' } },
    ])
    expect(h.session.closedReason).toBe('exited')
    await expect(h.session.send('more', 'start')).rejects.toBeInstanceOf(CodexSessionClosedError)
    await expect(h.session.next(AbortSignal.timeout(1_000))).rejects.toBeInstanceOf(CodexSessionClosedError)
  })

  it('ends the turn and closes the session on a frame it cannot read', async () => {
    const h = harness()
    await startTurn(h)
    h.codex.notify('item/started', { threadId: THREAD, turnId: TURN, item: { type: 'commandExecution', id: EXEC, command: 7 } })
    const events = await untilTurnEnd(h.session)
    expect(events.at(-1)).toMatchObject({ outcome: 'failed', failure: { category: 'program' } })
    await settle()
    expect(h.codex.exited).toBe(true)
  })
})

describe('interrupt (L32)', () => {
  it('sends turn/interrupt for the running turn and keeps the process when nothing is left running', async () => {
    const h = harness()
    await startTurn(h)
    const interrupted = h.session.interrupt()
    await h.codex.waitFor(frame => frame.method === 'turn/interrupt')
    expect(h.codex.requests('turn/interrupt')).toEqual([{ threadId: THREAD, turnId: TURN }])
    h.codex.notify('turn/completed', turnCompleted('interrupted'))
    expect(await interrupted).toBe('interrupted')
    expect((await untilTurnEnd(h.session)).at(-1)).toEqual({ kind: 'turn-end', outcome: 'interrupted' })
    expect(h.session.closedReason).toBeUndefined()
    expect(h.codex.exited).toBe(false)
  })

  it('closes the app-server when a command is still open after the interrupted turn ends, and says so before turn-end', async () => {
    const h = harness()
    await startTurn(h)
    h.codex.notify('item/started', itemFrame(commandItem('inProgress', null, EXEC, "/usr/bin/zsh -lc 'sleep 30 && echo late > late.txt'")))
    await settle()
    const interrupted = h.session.interrupt()
    await h.codex.waitFor(frame => frame.method === 'turn/interrupt')
    h.codex.notify('turn/completed', turnCompleted('interrupted'))
    expect(await interrupted).toBe('closed')
    const events: ProgramEvent[] = []
    const signal = AbortSignal.timeout(2_000)
    for (;;) {
      const event = await h.session.next(signal)
      events.push(event)
      if (event.kind === 'turn-end') {
        expect(h.session.closedReason).toBe('interrupted-with-open-command')
        break
      }
    }
    expect(events.slice(-2)).toEqual([
      { kind: 'tool-result', id: EXEC, output: 'The call did not finish before the turn ended.', isError: true },
      { kind: 'turn-end', outcome: 'interrupted' },
    ])
    await h.session.close()
    expect(h.codex.exited).toBe(true)
    await expect(h.session.send('next message', 'start')).rejects.toMatchObject({ reason: 'interrupted-with-open-command' })
  })

  it('closes the app-server when Codex does not end the interrupted turn in time', async () => {
    const h = harness({ requestTimeoutMs: 100 })
    await startTurn(h)
    expect(await h.session.interrupt()).toBe('closed')
    expect(h.session.closedReason).toBe('closed')
    expect(h.codex.exited).toBe(true)
  })

  it('reports interrupted with no turn running and closed after the session closed', async () => {
    const h = harness()
    expect(await h.session.interrupt()).toBe('interrupted')
    await h.session.close()
    expect(await h.session.interrupt()).toBe('closed')
  })

  it('removes the sandbox folders the program left in its run folder once the process has ended (decision 5)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ea1-codex-leftovers-'))
    onTestFinished(() => { rmSync(root, { recursive: true, force: true }) })
    mkdirSync(join(root, '.git'))
    const cleanUp = holdRunFolder(root, () => false)
    const h = harness({ cleanUp: () => { cleanUp() } })
    // The stand-in program's sandbox mounts over the two names that were missing.
    mkdirSync(join(root, '.agents'))
    mkdirSync(join(root, '.codex'))
    await h.session.close()
    expect(['.git', '.agents', '.codex'].map(name => existsSync(join(root, name)))).toEqual([true, false, false])
  })

  it('terminates a process that does not exit when its input ends', async () => {
    const h = harness()
    h.codex.exitOnStdinEnd = false
    await h.session.close()
    expect(h.codex.terminated).toBe(true)
  })
})

describe('questions', () => {
  /** Raise the recorded command question and collect what happened before it was asked. */
  async function raise(h: Harness, answer: ProgramApprovalAnswer): Promise<{ readonly before: ProgramEvent[]; readonly reply: Frame }> {
    const before: ProgramEvent[] = []
    h.answer = async () => {
      // Every event queued before the question is what the seat could record first.
      for (;;) {
        const event = await h.session.next(AbortSignal.timeout(500)).catch(() => undefined)
        if (event === undefined) break
        before.push(event)
      }
      return answer
    }
    await startTurn(h)
    h.codex.notify('item/started', itemFrame(commandItem('inProgress')))
    const reply = await h.codex.ask(0, 'item/commandExecution/requestApproval', commandApproval())
    return { before, reply }
  }

  it('raises a question only after the call and its message end are queued (L36)', async () => {
    const h = harness()
    const { before } = await raise(h, 'allow-once')
    expect(kinds(before)).toEqual(['tool-call', 'message-end'])
    expect(h.questions).toHaveLength(1)
    expect(h.questions[0]).toMatchObject({ callId: EXEC, toolName: 'shell', reason: COMMAND })
  })

  it.each([
    ['allow-once', 'accept'],
    ['allow-run', 'accept'],
    ['reject', 'decline'],
    ['cancel', 'cancel'],
  ] as const)('answers %s with %s', async (answer, decision) => {
    const h = harness()
    const { reply } = await raise(h, answer)
    expect(reply.result).toEqual({ decision })
  })

  it('offers "Allow for this run" with the exact command as its run rule', async () => {
    const h = harness()
    await raise(h, 'allow-run')
    expect(h.questions[0]?.runRule).toEqual({
      provider: 'codex',
      summary: COMMAND,
      data: { kind: 'command', threadId: THREAD, argv: ['/usr/bin/zsh', '-lc', 'touch made-by-codex.txt'], cwd: TASK, environmentId: 'local' },
    })
  })

  it('answers the same command again itself after "Allow for this run", and asks about any other (D4)', async () => {
    const h = harness()
    await startTurn(h)
    h.answer = () => Promise.resolve('allow-run')
    expect((await h.codex.ask(0, 'item/commandExecution/requestApproval', commandApproval())).result).toEqual({ decision: 'accept' })
    h.answer = () => Promise.resolve('reject')
    expect((await h.codex.ask(1, 'item/commandExecution/requestApproval', commandApproval('exec-2'))).result).toEqual({ decision: 'accept' })
    expect((await h.codex.ask(2, 'item/commandExecution/requestApproval', commandApproval('exec-3', "/usr/bin/zsh -lc 'touch other.txt'"))).result).toEqual({ decision: 'decline' })
    expect(h.questions.map(question => question.callId)).toEqual([EXEC, 'exec-3'])
  })

  it.each([
    ['another folder', { cwd: `${TASK}/sub` }],
    ['another argv split', { command: '/usr/bin/zsh -lc touch made-by-codex.txt' }],
    ['an escalation reason', { reason: 'Needs to write outside the workspace.' }],
    ['a network host', { networkApprovalContext: { host: 'example.com', protocol: 'https' } }],
    ['another thread', { threadId: 'other-thread' }],
  ])('asks again about the same command with %s, despite a rule handed back on open (D4)', async (_name, change) => {
    const rule = { provider: 'codex' as const, summary: COMMAND, data: { kind: 'command', threadId: THREAD, argv: ['/usr/bin/zsh', '-lc', 'touch made-by-codex.txt'], cwd: TASK, environmentId: 'local' } }
    const covered = harness({ runRules: [rule] })
    await startTurn(covered)
    expect((await covered.codex.ask(0, 'item/commandExecution/requestApproval', commandApproval())).result).toEqual({ decision: 'accept' })
    expect(covered.questions).toEqual([])
    const h = harness({ runRules: [rule] })
    await startTurn(h)
    await h.codex.ask(0, 'item/commandExecution/requestApproval', { ...commandApproval(), ...change })
    expect(h.questions).toHaveLength(1)
  })

  it('never re-answers a file change, even after "Allow for this run" on one', async () => {
    const h = harness()
    await startTurn(h)
    h.answer = () => Promise.resolve('allow-run')
    const change = (itemId: string) => ({ threadId: THREAD, turnId: TURN, itemId, startedAtMs: 1, reason: null, grantRoot: null })
    await h.codex.ask(0, 'item/fileChange/requestApproval', change('patch-1'))
    await h.codex.ask(1, 'item/fileChange/requestApproval', change('patch-2'))
    expect(h.questions).toHaveLength(2)
  })

  it('offers no run rule for input to a running terminal or a network host, and allows such a call once', async () => {
    const h = harness()
    await startTurn(h)
    h.answer = () => Promise.resolve('allow-run')
    const stdin = await h.codex.ask(0, 'item/commandExecution/requestApproval', { ...commandApproval(), kind: 'writeStdin' })
    const network = await h.codex.ask(1, 'item/commandExecution/requestApproval', { ...commandApproval('exec-2'), networkApprovalContext: { host: 'example.com', protocol: 'https' } })
    expect(h.questions.map(question => question.runRule)).toEqual([undefined, undefined])
    expect([stdin.result, network.result]).toEqual([{ decision: 'accept' }, { decision: 'accept' }])
  })

  it('announces a call it has not seen before asking about it', async () => {
    const h = harness()
    await startTurn(h)
    h.answer = () => Promise.resolve('reject')
    await h.codex.ask(0, 'item/commandExecution/requestApproval', commandApproval('exec-unseen'))
    expect(await h.session.next(AbortSignal.timeout(500))).toMatchObject({ kind: 'tool-call', id: 'exec-unseen', name: 'shell' })
    expect(await h.session.next(AbortSignal.timeout(500))).toEqual({ kind: 'message-end' })
  })

  it('asks about a file change with its paths and allows "Allow for this run" once', async () => {
    const h = harness()
    await startTurn(h)
    h.codex.notify('item/started', itemFrame({ type: 'fileChange', id: 'patch-1', changes: [{ path: `${TASK}/a.txt`, kind: { type: 'add' }, diff: '+hello' }], status: 'inProgress' }))
    h.answer = () => Promise.resolve('allow-run')
    const reply = await h.codex.ask(0, 'item/fileChange/requestApproval', { threadId: THREAD, turnId: TURN, itemId: 'patch-1', startedAtMs: 1, reason: null, grantRoot: null })
    expect(h.questions[0]).toMatchObject({ callId: 'patch-1', toolName: 'apply_patch', reason: `${TASK}/a.txt` })
    expect(h.questions[0]?.runRule).toBeUndefined()
    expect(reply.result).toEqual({ decision: 'accept' })
  })

  it('withdraws a question Codex resolved itself, and answers it cancel', async () => {
    const h = harness()
    await startTurn(h)
    const asked = Promise.withResolvers<void>()
    h.answer = (request) => {
      asked.resolve()
      return new Promise((resolve) => { request.signal.addEventListener('abort', () => resolve('allow-once')) })
    }
    const reply = h.codex.ask(7, 'item/commandExecution/requestApproval', commandApproval())
    await asked.promise
    h.codex.notify('serverRequest/resolved', { threadId: THREAD, requestId: 7 })
    expect((await reply).result).toEqual({ decision: 'cancel' })
    expect(h.questions[0]?.signal.aborted).toBe(true)
  })

  it('withdraws a pending question when its turn ends', async () => {
    const h = harness()
    await startTurn(h)
    const asked = Promise.withResolvers<void>()
    h.answer = () => {
      asked.resolve()
      return new Promise(() => {})
    }
    const reply = h.codex.ask(3, 'item/commandExecution/requestApproval', commandApproval())
    await asked.promise
    h.codex.notify('turn/completed', turnCompleted('interrupted'))
    expect((await reply).result).toEqual({ decision: 'cancel' })
    // The command never started, so the process stays.
    expect(h.session.closedReason).toBeUndefined()
  })

  it('puts usage that arrives after the last message on turn-end', async () => {
    const h = harness()
    await startTurn(h)
    h.codex.notify('item/started', itemFrame(commandItem('inProgress')))
    h.codex.notify('item/completed', itemFrame(commandItem('completed', 0)))
    h.codex.notify('thread/tokenUsage/updated', tokenUsage(1200, 1000, 40))
    h.codex.notify('turn/completed', turnCompleted('completed'))
    expect((await untilTurnEnd(h.session)).at(-1)).toEqual({ kind: 'turn-end', outcome: 'completed', usage: { inputTokens: 200, outputTokens: 40, totalTokens: 1240, cacheReadTokens: 1000, reasoningTokens: 3 } })
  })

  it('rejects when the seat cannot ask the person', async () => {
    const h = harness()
    await startTurn(h)
    h.answer = () => Promise.reject(new Error('no open turn'))
    expect((await h.codex.ask(0, 'item/commandExecution/requestApproval', commandApproval())).result).toEqual({ decision: 'decline' })
  })

  it('grants no wider permissions', async () => {
    const h = harness()
    await startTurn(h)
    const reply = await h.codex.ask(0, 'item/permissions/requestApproval', { threadId: THREAD, turnId: TURN, itemId: 'perm', environmentId: null, startedAtMs: 1, cwd: TASK, reason: null, permissions: { network: { enabled: true } } })
    expect(reply.result).toEqual({ permissions: {}, scope: 'turn' })
    expect(h.questions).toEqual([])
  })

  it('asks the person about one of their own MCP tool calls and declines a form', async () => {
    const h = harness()
    await startTurn(h)
    h.codex.notify('item/started', itemFrame({ type: 'mcpToolCall', id: 'mcp-1', server: 'docs', tool: 'search', status: 'inProgress', arguments: { q: 'x' }, result: null, error: null }))
    h.answer = () => Promise.resolve('allow-run')
    const tool = await h.codex.ask(0, 'mcpServer/elicitation/request', { threadId: THREAD, turnId: TURN, serverName: 'docs', mode: 'form', message: 'Allow docs/search?', requestedSchema: {}, _meta: { codex_approval_kind: 'mcp_tool_call', persist: ['session', 'always'] } })
    const form = await h.codex.ask(1, 'mcpServer/elicitation/request', { threadId: THREAD, turnId: TURN, serverName: 'docs', mode: 'form', message: 'Your name?', requestedSchema: {}, _meta: null })
    expect(h.questions).toHaveLength(1)
    expect(h.questions[0]).toMatchObject({ callId: 'mcp-1', toolName: 'mcp__docs__search', reason: 'Allow docs/search?' })
    // Without a run rule the card does not offer "Allow for this run".
    expect(h.questions[0]?.runRule).toBeUndefined()
    expect(tool.result).toEqual({ action: 'accept', content: {}, _meta: null })
    expect(form.result).toEqual({ action: 'decline', content: null, _meta: null })
  })

  describe('elicitations about Delorun\'s own harness server (D14)', () => {
    const OWN = 'delorun_5f3a9c0e1b2d'
    const own: HarnessServer = { name: OWN, toolNames: new Set(['harness_read']), mcpServers: {}, close: () => Promise.resolve() }
    const toolCall = (server: string, tool = 'harness_read') => itemFrame({ type: 'mcpToolCall', id: 'mcp-1', server, tool, status: 'inProgress', arguments: {}, result: null, error: null })
    const elicitation = (serverName: string, meta: Frame | null = { codex_approval_kind: 'mcp_tool_call', persist: ['session', 'always'] }, threadId = THREAD) =>
      ({ threadId, turnId: TURN, serverName, mode: 'form', message: `Allow the ${serverName} MCP server to run tool "harness_read"?`, requestedSchema: {}, _meta: meta })

    async function answer(server: string, params: Frame, toolName?: string): Promise<{ readonly reply: Frame; readonly asked: number }> {
      const h = harness({ harness: own })
      await startTurn(h)
      h.codex.notify('item/started', toolCall(server, toolName))
      h.answer = () => Promise.resolve('reject')
      const reply = await h.codex.ask(0, 'mcpServer/elicitation/request', params)
      return { reply, asked: h.questions.length }
    }

    it('answers a call of an offered tool on the thread\'s own server itself, without persisting', async () => {
      const { reply, asked } = await answer(OWN, elicitation(OWN))
      expect(reply.result).toEqual({ action: 'accept', content: {}, _meta: null })
      expect(asked).toBe(0)
    })

    it('asks the person about a server named delorun', async () => {
      expect((await answer('delorun', elicitation('delorun'))).asked).toBe(1)
    })

    it('never accepts an elicitation without the tool-call kind', async () => {
      const { reply, asked } = await answer(OWN, elicitation(OWN, null))
      expect(reply.result).toEqual({ action: 'decline', content: null, _meta: null })
      expect(asked).toBe(0)
    })

    it('asks the person about the right kind with another server\'s name', async () => {
      expect((await answer('docs', elicitation('docs'))).asked).toBe(1)
    })

    it('asks the person about a tool on its own server that was not offered', async () => {
      expect((await answer(OWN, elicitation(OWN), 'harness_write')).asked).toBe(1)
    })

    it('does not answer for another thread', async () => {
      expect((await answer(OWN, elicitation(OWN, undefined, 'other-thread'))).reply.result).not.toMatchObject({ action: 'accept' })
    })
  })

  it('sets no sandbox policy on a turn when the level keeps the thread\'s own', async () => {
    const h = harness({ turnSandbox: null })
    await startTurn(h)
    expect(h.codex.requests('turn/start')[0]).not.toHaveProperty('sandboxPolicy')
  })

  it('sets the unrestricted level\'s full access on each turn', async () => {
    const h = harness({ turnSandbox: { type: 'dangerFullAccess' } })
    await startTurn(h)
    expect(h.codex.requests('turn/start')[0]).toMatchObject({ sandboxPolicy: { type: 'dangerFullAccess' } })
  })

  it('refuses a server request it does not answer', async () => {
    const h = harness()
    const reply = await h.codex.ask(9, 'account/chatgptAuthTokens/refresh', {})
    expect(reply.error).toMatchObject({ code: -32601 })
  })
})
