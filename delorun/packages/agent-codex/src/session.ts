/**
 * One Codex thread in one app-server process, as a program session: Codex's notifications become ordered
 * {@link ProgramEvent}s, its approval requests become the seat's questions, and input becomes `turn/start` or
 * `turn/steer`.
 *
 * Order guarantees the seat relies on:
 * - A tool call's `tool-call` and `message-end` are queued before any question about that call is raised (L36).
 * - Only the current turn's items are shown; an item from a turn that has ended is ignored, so a late
 *   `item/completed` for a settled call never reaches the seat.
 * - When a turn ends with a command still open, the open calls are settled as failed, the app-server process is
 *   closed (which ends its commands, L32) and {@link CodexSession.closedReason} says so before `turn-end` is queued.
 * @module @delorun/agent-codex/session
 */
import type { TokenUsage } from '@deepseek-ai/dsh-llm'
import type { SubprocessHandle } from '@deepseek-ai/dsh-subprocess'
import type {
  AccountObservation, ProgramApprovalAnswer, ProgramApprovalRequest, ProgramEvent, ProgramFailure, ProgramExit, ProgramInterruptOutcome,
  ProgramRunRule, ProgramSession,
} from '@delorun/external-agents/contract'
import type { HarnessServer } from './harness-server.ts'
import type { TurnSandbox } from './levels.ts'
import { addUsage, observationOf, toolCall, toolResult, turnFailure, usageOf } from './mapping.ts'
import { MappedItem, TOOL_ITEM_TYPES, type CodexNotification, type CodexServerRequest, type RateLimitSnapshot, type ToolItem, type TurnError, type WireJson } from './protocol.ts'
import { EventQueue } from './queue.ts'
import { CodexRpcError, type CodexRpc, type RequestId } from './rpc.ts'
import { commandRunRule, ruleCovers } from './run-rules.ts'

/**
 * Why a session's process is gone:
 * - `interrupted-with-open-command`: a turn ended with a command still running, so the driver closed the process to
 *   end the command; the seat resumes the thread on the next message;
 * - `exited`: the process ended or broke the protocol on its own;
 * - `closed`: {@link CodexSession.close} was called.
 */
export type CodexClosedReason = 'interrupted-with-open-command' | 'exited' | 'closed'

/** Input or a take on a session whose process is gone. */
export class CodexSessionClosedError extends Error {
  /** Why the process is gone. */
  readonly reason: CodexClosedReason

  /** @param reason - why the process is gone. */
  constructor(reason: CodexClosedReason) {
    super(`the Codex session is closed (${reason})`)
    this.name = 'CodexSessionClosedError'
    this.reason = reason
  }
}

/** `send(text, 'start')` while a turn is running. */
export class CodexTurnRunningError extends Error {
  constructor() {
    super('a Codex turn is already running; steer it or wait for it to end')
    this.name = 'CodexTurnRunningError'
  }
}

/** What a session needs from its driver. */
export interface CodexSessionOptions {
  /** The app-server process, from the gate's spawn. */
  readonly handle: SubprocessHandle
  /** The JSON-RPC connection over its stdio. */
  readonly rpc: CodexRpc
  /** Asks the person about one tool call. */
  readonly onApproval: (request: ProgramApprovalRequest) => Promise<ProgramApprovalAnswer>
  /** Receives rate-limit figures seen during the run. */
  readonly onLimits: (observation: AccountObservation) => void
  /** How long a request may wait for Codex's answer, in milliseconds. */
  readonly requestTimeoutMs: number
  /** How long the process may take to exit after its input ends before it is terminated, in milliseconds. */
  readonly closeWaitMs: number
  /** Rules the person allowed for this run before the process started (D4). */
  readonly runRules: readonly ProgramRunRule[]
  /** Removes the sandbox's leftovers in the run folder; called once, after the process has ended. */
  readonly cleanUp: () => void
  /** The thread's harness MCP server, closed when the process ends; absent when no harness tool is offered. */
  readonly harness?: HarnessServer
}

/** The result recorded for a call still open when its turn ended. */
const UNFINISHED_CALL = 'The call did not finish before the turn ended.'
/** The person's-view detail for a process that ended during a turn. */
const PROCESS_ENDED = 'Codex stopped unexpectedly.'

/**
 * How a finished process ended, without any output it wrote.
 * @param outcome - the process's outcome.
 * @returns the exit code, or the signal when one ended it.
 */
function exitOf(outcome: { readonly exitCode: number | null, readonly signal: string | null }): ProgramExit {
  return { ...outcome.exitCode === null ? {} : { code: outcome.exitCode }, ...outcome.signal === null ? {} : { signal: outcome.signal } }
}

/** Codex's decision for each answer; "Allow for this run" is a one-time accept, and the driver keeps the rule. */
const DECISIONS: Readonly<Record<ProgramApprovalAnswer, 'accept' | 'decline' | 'cancel'>> = {
  'allow-once': 'accept',
  'allow-run': 'accept',
  reject: 'decline',
  cancel: 'cancel',
}

/** One open program tool call in the current turn. */
interface OpenCall { readonly type: ToolItem['type']; readonly item?: ToolItem }

/** One Codex thread as a {@link ProgramSession}. */
export class CodexSession implements ProgramSession {
  private readonly queue = new EventQueue<ProgramEvent>()
  private threadId = ''
  private turnSandbox: TurnSandbox | undefined
  /** The running turn's id; undefined between turns, so items of an ended turn are ignored. */
  private currentTurn: string | undefined
  private starting = false
  private readonly openCalls = new Map<string, OpenCall>()
  private messageOpen = false
  private pendingUsage: TokenUsage | undefined
  private lastError: TurnError | undefined
  private lastSnapshot: RateLimitSnapshot | undefined
  private readonly questions = new Map<RequestId, { readonly turnId: string; readonly callId: string; readonly controller: AbortController }>()
  private closed: CodexClosedReason | undefined
  private exit: ProgramExit | undefined
  private closing: Promise<void> | undefined
  private readonly turnEndWaiters: (() => void)[] = []
  private readonly runRules: ProgramRunRule[]
  private readonly options: CodexSessionOptions

  /** @param options - the process, its connection, the seat's callbacks and the timeouts. */
  constructor(options: CodexSessionOptions) {
    this.options = options
    this.runRules = [...options.runRules]
    options.rpc.start({
      notification: (notification) => { this.notification(notification) },
      request: (request, id) => this.serverRequest(request, id),
      violation: (error) => { this.violation(error) },
    })
    void options.rpc.ended.then(() => { this.processEnded() })
    // The process's exit is observed through its output closing; a spawn failure rejects `done` and closes it too.
    options.handle.done.then((outcome) => { this.exit = exitOf(outcome) }, () => { this.processEnded() })
  }

  /** The Codex thread id, which `thread/resume` takes. */
  get programSessionId(): string {
    return this.threadId
  }

  /** Whether Codex's own sandbox confines the thread at its level; set when the thread opens, see `ProgramSession.sandboxed`. */
  sandboxed = false

  /** Whether a Codex turn is running. */
  get turnRunning(): boolean {
    return this.currentTurn !== undefined || this.starting
  }

  /** Why the process is gone, or undefined while it runs. */
  get closedReason(): CodexClosedReason | undefined {
    return this.closed
  }

  /**
   * Bind the session to the thread `thread/start` or `thread/resume` opened.
   * @param threadId - the thread id.
   * @param turnSandbox - the sandbox policy each turn sets, from the seat's level; undefined keeps the thread's own.
   */
  attach(threadId: string, turnSandbox: TurnSandbox | undefined): void {
    this.threadId = threadId
    this.turnSandbox = turnSandbox
  }

  /**
   * The last rate-limit snapshot seen on this connection.
   * @returns the snapshot, or undefined before one arrived.
   */
  limits(): RateLimitSnapshot | undefined {
    return this.lastSnapshot
  }

  async send(text: string, mode: 'start' | 'steer'): Promise<void> {
    this.assertOpen()
    const input = [{ type: 'text', text, text_elements: [] }]
    if (mode === 'steer' && this.currentTurn !== undefined) {
      const expectedTurnId = this.currentTurn
      try {
        await this.options.rpc.request('turn/steer', { threadId: this.threadId, input, expectedTurnId }, this.timeout())
        return
      } catch (error: unknown) {
        // The turn ended while the steer was on its way: the input starts the next turn instead.
        if (!(error instanceof CodexRpcError) || this.currentTurn === expectedTurnId) throw error
      }
      this.assertOpen()
    }
    if (this.turnRunning) throw new CodexTurnRunningError()
    this.beginTurn()
    try {
      const { turn } = await this.options.rpc.request('turn/start', { threadId: this.threadId, input, ...this.turnSandbox === undefined ? {} : { sandboxPolicy: this.turnSandbox } }, this.timeout())
      // `turn/started` may already have named the turn, and a quick turn may even have completed before this answer.
      if (this.starting) this.currentTurn ??= turn.id
    } finally {
      this.starting = false
    }
  }

  /**
   * Interrupt the running turn and wait for it to end. When a command is still open at its end, the process is closed
   * (L32) and the outcome is `closed`; Codex not ending the turn within the request timeout closes it too.
   */
  async interrupt(): Promise<ProgramInterruptOutcome> {
    const turnId = this.currentTurn
    if (turnId !== undefined && this.closed === undefined) {
      const ended = new Promise<void>((resolve) => { this.turnEndWaiters.push(resolve) })
      try {
        await this.options.rpc.request('turn/interrupt', { threadId: this.threadId, turnId }, this.timeout())
      } catch (error: unknown) {
        // A turn that ended on its own before the request arrived needs no interrupt.
        if (!(error instanceof CodexRpcError) || this.currentTurn === turnId) throw error
      }
      const timeout = this.timeout()
      const timedOut = new Promise<'timeout'>((resolve) => { timeout.addEventListener('abort', () => { resolve('timeout') }, { once: true }) })
      if (await Promise.race([ended, timedOut]) === 'timeout') await this.shutDown('closed')
    }
    return this.closed === undefined ? 'interrupted' : 'closed'
  }

  next(signal: AbortSignal): Promise<ProgramEvent> {
    return this.queue.take(signal)
  }

  close(): Promise<void> {
    return this.shutDown('closed')
  }

  private assertOpen(): void {
    if (this.closed !== undefined) throw new CodexSessionClosedError(this.closed)
  }

  private timeout(): AbortSignal {
    return AbortSignal.timeout(this.options.requestTimeoutMs)
  }

  private beginTurn(): void {
    this.starting = true
    this.openCalls.clear()
    this.messageOpen = false
    this.lastError = undefined
  }

  private emit(event: ProgramEvent): void {
    if (event.kind === 'text' || event.kind === 'reasoning' || event.kind === 'tool-call') this.messageOpen = true
    this.queue.push(event)
  }

  private endMessage(): void {
    const usage = this.pendingUsage
    this.pendingUsage = undefined
    this.messageOpen = false
    this.queue.push(usage === undefined ? { kind: 'message-end' } : { kind: 'message-end', usage })
  }

  private isCurrent(turnId: string, threadId: string): boolean {
    return threadId === this.threadId && turnId === this.currentTurn
  }

  private notification(notification: CodexNotification): void {
    switch (notification.method) {
      case 'turn/started': {
        const { threadId, turn } = notification.params
        if (threadId === this.threadId && this.starting) this.currentTurn ??= turn.id
        break
      }
      case 'item/started': {
        const { threadId, turnId, item } = notification.params
        if (!this.isCurrent(turnId, threadId) || !TOOL_ITEM_TYPES.has(item.type)) break
        const mapped = this.toolItem(item)
        if (mapped !== undefined) this.announce(mapped.id, mapped.type, toolCall(mapped), mapped)
        break
      }
      case 'item/completed': {
        const { threadId, turnId, item } = notification.params
        if (!this.isCurrent(turnId, threadId)) break
        if (TOOL_ITEM_TYPES.has(item.type)) {
          const mapped = this.toolItem(item)
          if (mapped === undefined) break
          if (!this.openCalls.has(mapped.id)) this.announce(mapped.id, mapped.type, toolCall(mapped), mapped)
          this.openCalls.delete(mapped.id)
          this.emit({ kind: 'tool-result', id: mapped.id, ...toolResult(mapped) })
        } else if (item.type === 'agentMessage' || item.type === 'reasoning') {
          const parsed = MappedItem.safeParse(item)
          if (!parsed.success) {
            this.violation(new Error(`${item.type}: Codex's item has fields Delorun cannot read`))
            break
          }
          if (parsed.data.type === 'agentMessage' && parsed.data.text !== '') this.emit({ kind: 'text', text: parsed.data.text })
          if (parsed.data.type === 'reasoning') {
            // The summary is the reasoning Codex shows; its raw content only when there is no summary.
            const text = (parsed.data.summary.length > 0 ? parsed.data.summary : parsed.data.content).join('\n\n')
            if (text !== '') this.emit({ kind: 'reasoning', text })
          }
        }
        break
      }
      case 'thread/tokenUsage/updated':
        if (notification.params.threadId === this.threadId) this.pendingUsage = addUsage(this.pendingUsage, usageOf(notification.params.tokenUsage.last))
        break
      case 'account/rateLimits/updated':
        this.lastSnapshot = notification.params.rateLimits
        this.options.onLimits(observationOf({ snapshot: notification.params.rateLimits, source: 'run' }))
        break
      case 'error': {
        const { threadId, turnId, error, willRetry } = notification.params
        if (!willRetry && this.isCurrent(turnId, threadId)) this.lastError = error
        break
      }
      case 'serverRequest/resolved':
        this.questions.get(notification.params.requestId)?.controller.abort(new Error('Codex withdrew the question'))
        break
      case 'turn/completed': {
        const { threadId, turn } = notification.params
        if (!this.isCurrent(turn.id, threadId)) break
        const outcome = turn.status === 'completed' ? 'completed' : turn.status === 'interrupted' ? 'interrupted' : 'failed'
        const failure = outcome === 'failed' ? turnFailure(turn.error ?? this.lastError, this.lastSnapshot) : undefined
        this.endTurn(outcome, failure)
        break
      }
    }
  }

  /** Parse a tool item; an item of a mapped type with unreadable fields breaks the session. */
  private toolItem(item: { readonly type: string; readonly id: string }): ToolItem | undefined {
    const parsed = MappedItem.safeParse(item)
    if (!parsed.success || parsed.data.type === 'agentMessage' || parsed.data.type === 'reasoning') {
      this.violation(new Error(`${item.type}: Codex's item has fields Delorun cannot read`))
      return undefined
    }
    return parsed.data
  }

  /** Queue a call's `tool-call` and end its message, once per call. */
  private announce(id: string, type: ToolItem['type'], call: { readonly name: string; readonly input: string }, item?: ToolItem): void {
    if (this.openCalls.has(id)) return
    this.openCalls.set(id, item === undefined ? { type } : { type, item })
    this.emit({ kind: 'tool-call', id, name: call.name, input: call.input })
    this.endMessage()
  }

  /** Settle the turn: open calls fail, the message ends, the process closes when a command outlives the turn. */
  private endTurn(outcome: 'completed' | 'interrupted' | 'failed', failure: ProgramFailure | undefined, closedReason?: CodexClosedReason): void {
    const turnId = this.currentTurn
    this.currentTurn = undefined
    this.starting = false
    // A command still waiting for its answer has not started, so it does not keep the process from going on.
    const asking = new Set<string>()
    for (const [requestId, question] of this.questions) {
      if (question.turnId !== turnId) continue
      asking.add(question.callId)
      question.controller.abort(new Error('the turn ended'))
      this.questions.delete(requestId)
    }
    let commandOpen = false
    for (const [id, call] of this.openCalls) {
      commandOpen ||= call.type === 'commandExecution' && !asking.has(id)
      this.emit({ kind: 'tool-result', id, output: UNFINISHED_CALL, isError: true })
    }
    this.openCalls.clear()
    if (this.messageOpen) this.endMessage()
    const usage = this.pendingUsage
    this.pendingUsage = undefined
    const reason = closedReason ?? (commandOpen ? 'interrupted-with-open-command' : undefined)
    if (reason !== undefined) void this.shutDown(reason)
    this.queue.push({
      kind: 'turn-end',
      outcome,
      ...usage === undefined ? {} : { usage },
      ...failure === undefined ? {} : { failure },
    })
    for (const resolve of this.turnEndWaiters.splice(0)) resolve()
  }

  private processEnded(): void {
    if (this.closed !== undefined) return
    if (this.turnRunning) this.endTurn('failed', { category: 'program', detail: PROCESS_ENDED, ...this.exit === undefined ? {} : { exit: this.exit } }, 'exited')
    else void this.shutDown('exited')
  }

  private violation(error: Error): void {
    if (this.closed !== undefined) return
    // A frame the driver cannot read may hide a call or a question, so the session cannot go on.
    if (this.turnRunning) this.endTurn('failed', { category: 'program', detail: error.message }, 'exited')
    else void this.shutDown('exited')
  }

  /** End the process once: input closes, then a terminate after the wait; every question is withdrawn. */
  private shutDown(reason: CodexClosedReason): Promise<void> {
    if (this.closing !== undefined) return this.closing
    this.closed = reason
    for (const question of this.questions.values()) question.controller.abort(new Error('the Codex session closed'))
    this.questions.clear()
    const { rpc, handle, closeWaitMs } = this.options
    this.closing = (async () => {
      rpc.close()
      const exited = await Promise.race([
        handle.done.then(() => true, () => true),
        new Promise<false>((resolve) => { setTimeout(() => resolve(false), closeWaitMs).unref() }),
      ])
      if (!exited) handle.terminate()
      try {
        await handle.waitForExit()
      } catch (_unobservable) {
        // The subprocess owner can no longer see the range; it reports that itself, and the session is closed either way.
      }
      this.options.cleanUp()
      await this.options.harness?.close()
      this.queue.close(new CodexSessionClosedError(reason))
    })()
    return this.closing
  }

  private async serverRequest(request: CodexServerRequest, id: RequestId): Promise<WireJson> {
    switch (request.method) {
      case 'item/commandExecution/requestApproval': {
        const { params } = request
        const call = this.openCalls.get(params.itemId)?.item
        const command = params.command ?? (call?.type === 'commandExecution' ? call.command : undefined)
        const cwd = params.cwd ?? (call?.type === 'commandExecution' ? call.cwd : undefined)
        if (!this.openCalls.has(params.itemId)) this.announce(params.itemId, 'commandExecution', { name: 'shell', input: JSON.stringify({ command: command ?? null, cwd: cwd ?? null }) })
        const question = { ...params, command, cwd }
        // A question a rule from this run covers is answered once here; Codex never gets a session-wide answer (D4).
        if (params.turnId === this.currentTurn && this.closed === undefined && this.runRules.some(rule => ruleCovers(rule, question))) return { decision: 'accept' }
        const runRule = commandRunRule(question)
        const reason = [command ?? 'a command', params.reason].filter(part => typeof part === 'string' && part !== '').join('\n')
        const answer = await this.ask(id, params.turnId, { callId: params.itemId, toolName: 'shell', reason, ...runRule === undefined ? {} : { runRule } })
        if (answer === 'allow-run' && runRule !== undefined) this.runRules.push(runRule)
        return { decision: DECISIONS[answer] }
      }
      case 'item/fileChange/requestApproval': {
        const { params } = request
        const call = this.openCalls.get(params.itemId)?.item
        if (!this.openCalls.has(params.itemId)) this.announce(params.itemId, 'fileChange', { name: 'apply_patch', input: JSON.stringify({ grantRoot: params.grantRoot ?? null }) })
        const paths = call?.type === 'fileChange' ? call.changes.map(change => change.path) : []
        const reason = [paths.join('\n'), params.reason, params.grantRoot].find(part => typeof part === 'string' && part !== '') ?? 'a file change'
        const answer = await this.ask(id, params.turnId, { callId: params.itemId, toolName: 'apply_patch', reason })
        // A file change has no run rule, so "Allow for this run" allows this change once.
        return { decision: DECISIONS[answer] }
      }
      case 'item/permissions/requestApproval':
        // Wider sandbox permissions are never granted to a seat: the answer grants nothing, for this turn only.
        return { permissions: {}, scope: 'turn' }
      case 'mcpServer/elicitation/request':
        return this.elicitation(request.params, id)
    }
  }

  private async elicitation(params: Extract<CodexServerRequest, { method: 'mcpServer/elicitation/request' }>['params'], id: RequestId): Promise<WireJson> {
    const meta = params._meta
    const kind = typeof meta === 'object' && meta !== null && !Array.isArray(meta) ? meta.codex_approval_kind : undefined
    let callId: string | undefined
    for (const [openId, call] of this.openCalls) {
      if (call.item?.type === 'mcpToolCall' && call.item.server === params.serverName) callId = openId
    }
    // Only a question about one of the person's own MCP tool calls in this turn goes to the person; a form or a
    // link the program wants filled in is declined, because a seat has nowhere to show it.
    if (kind !== 'mcp_tool_call' || callId === undefined || params.turnId === null) return { action: 'decline', content: null, _meta: null }
    const call = this.openCalls.get(callId)?.item
    const toolName = call?.type === 'mcpToolCall' ? `mcp__${call.server}__${call.tool}` : `mcp__${params.serverName}`
    // A call of a harness tool on this thread's own server is the seat's to decide, not Codex's (D14).
    const harness = this.options.harness
    if (harness !== undefined && params.serverName === harness.name && params.threadId === this.threadId && call?.type === 'mcpToolCall' && harness.toolNames.has(call.tool)) {
      return { action: 'accept', content: {}, _meta: null }
    }
    const answer = await this.ask(id, params.turnId, { callId, toolName, reason: params.message })
    switch (answer) {
      case 'allow-once':
      case 'allow-run':
        // Codex's session approval covers every later call of the tool, so "Allow for this run" allows this call once.
        return { action: 'accept', content: {}, _meta: null }
      case 'reject':
        return { action: 'decline', content: null, _meta: null }
      case 'cancel':
        return { action: 'cancel', content: null, _meta: null }
    }
  }

  /** Raise one question; a withdrawn question, an ended turn or a closed session answers `cancel`. */
  private async ask(id: RequestId, turnId: string, question: { readonly callId: string; readonly toolName: string; readonly reason: string; readonly runRule?: ProgramRunRule }): Promise<ProgramApprovalAnswer> {
    if (this.closed !== undefined || turnId !== this.currentTurn) return 'cancel'
    const controller = new AbortController()
    this.questions.set(id, { turnId, callId: question.callId, controller })
    const withdrawn = new Promise<'cancel'>((resolve) => { controller.signal.addEventListener('abort', () => resolve('cancel'), { once: true }) })
    try {
      return await Promise.race([this.options.onApproval({ ...question, signal: controller.signal }), withdrawn])
    } catch (_failed) {
      // The seat could not ask the person; nothing is allowed without an answer.
      return 'reject'
    } finally {
      this.questions.delete(id)
    }
  }
}
