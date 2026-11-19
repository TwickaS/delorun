/**
 * The seat model adapter (EA2): serves a route no picker lists and refuses every request that is not a seat child's
 * own turn. For a seat child's turn it hands the program only what is new since the cursor, exactly as written, and
 * streams one program assistant message per harness step.
 * @module @delorun/plugin-agent-seats/adapter/adapter
 */
import {
  LlmAdapter, ToolCallId,
  type GenerateOptions, type LlmModelInfo, type LlmProviderInfo, type LlmResolvedModelInfo, type StreamChunk, type TokenUsage,
} from '@deepseek-ai/dsh-llm'
import {
  GateRefusedError, ProgramOpenError,
  type ExternalAgentName, type ExternalAgentsGate, type ProgramApprovalAnswer, type ProgramApprovalRequest, type ProgramFailure,
  type SeatSession, type SessionId,
} from '@delorun/external-agents/contract'
import {
  gateRefusal, HISTORY_PARTED, PROGRAM_CLOSED, programFailure, SEAT_FOLDER_UNKNOWN, SEAT_ROUTE_REFUSED,
  SEAT_ROUTE_REFUSED_MESSAGE, TASK_UNSEPARABLE, type FixedFailure,
} from './failure.ts'
import { newInput, type HarnessResult } from './input.ts'
import { SeatRun } from './run.ts'
import type { SeatAdapterEvents, SeatModelChoices, SeatStateStore } from './state-port.ts'

/** What the adapter reads about a seat child from the rest of the Host. */
export interface SeatHost {
  /**
   * The `ctx.subagents` provider named by the child's `subagent/descriptor`.
   * @param child - a Session id.
   * @returns the provider, or undefined when the Session has no readable descriptor.
   */
  descriptorProvider(child: SessionId): string | undefined
  /**
   * The Session that handed work to the child, where consent is asked.
   * @param child - the seat child.
   * @returns its id, or undefined when the child has no creator.
   */
  creator(child: SessionId): SessionId | undefined
  /**
   * The run folder.
   * @param child - the seat child.
   * @returns the absolute folder, or undefined when the Session has none.
   */
  cwd(child: SessionId): string | undefined
  /**
   * The workspace key the person's model pick is kept under.
   * @param child - the seat child.
   * @returns the key, or undefined when the child has no workspace.
   */
  workspaceOf(child: SessionId): string | undefined
  /**
   * Ask the person about one of the program's tool calls.
   * @param child - the seat child.
   * @param request - the program's question.
   * @param startSignal - the signal of the start that opened the program; stop and archive abort it.
   * @returns the person's answer.
   */
  approve(child: SessionId, request: ProgramApprovalRequest, startSignal: AbortSignal): Promise<ProgramApprovalAnswer>
  /**
   * Whether a tool call is one the program made on a harness tool (Stage 3), so its result goes back to the program.
   * @param child - the seat child.
   * @param callId - the call's id.
   * @returns true for a harness tool call; absent means none is.
   */
  isHarnessCall?(child: SessionId, callId: string): boolean
  /**
   * Whether a tool name is one of the harness tools offered to the program over MCP (Stage 3, D18); the adapter keeps
   * such a name as it is, so the native executor runs the call. Every other name is the program's own tool.
   * @param child - the seat child.
   * @param name - the tool name the program reported.
   * @returns true for a harness tool; absent means none is.
   */
  isHarnessTool?(child: SessionId, name: string): boolean
  /**
   * Hand a harness tool's result back to the program.
   * @param child - the seat child.
   * @param result - the result.
   */
  deliverHarnessResult?(child: SessionId, result: HarnessResult): void
}

/** What one seat route's adapter is built from. */
export interface SeatAdapterOptions {
  /** The hidden route id the seat child's turns use. */
  readonly route: string
  /** The agent the route runs. */
  readonly provider: ExternalAgentName
  /** The `ctx.subagents` provider id whose children are this route's seats. */
  readonly descriptorProvider: string
  /** The agent's display name, such as `Claude Code`. */
  readonly displayName: string
  /** The prefix of the seat's recorded tool names, such as `claude_code.`; the executor treats a call with it as a record. */
  readonly recordPrefix: string
  /** The program's context window in tokens, for the token meter. */
  readonly contextWindow: number
  /** The start gate. */
  readonly gate: Pick<ExternalAgentsGate, 'start' | 'seat'>
  /** What the adapter reads about a seat child. */
  readonly host: SeatHost
  /** The seat's logged state. */
  readonly states: SeatStateStore
  /** The model a person picked per workspace. */
  readonly models: SeatModelChoices
  /** What the adapter reports to the rest of the plugin. */
  readonly events?: SeatAdapterEvents
}

/**
 * Add one usage figure to another.
 * @param total - the figures so far.
 * @param more - figures to add.
 * @returns the sum.
 */
function addUsage(total: TokenUsage | undefined, more: TokenUsage): TokenUsage {
  if (total === undefined) return { ...more }
  const sum = (a: number | undefined, b: number | undefined): number | undefined => a === undefined && b === undefined ? undefined : (a ?? 0) + (b ?? 0)
  const result: TokenUsage = { inputTokens: total.inputTokens + more.inputTokens, outputTokens: total.outputTokens + more.outputTokens }
  for (const key of ['totalTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens'] as const) {
    const value = sum(total[key], more[key])
    if (value !== undefined) result[key] = value
  }
  return result
}

/**
 * One error finish.
 * @param fixed - the fixed message and code.
 * @returns the chunk.
 */
function errorFinish(fixed: FixedFailure): StreamChunk {
  return { type: 'finish', reason: { kind: 'error', failure: { message: fixed.message, code: fixed.code } } }
}

/** Serves seat children's turns from their program sessions. */
export class SeatAdapter extends LlmAdapter {
  /** Every request served or refused, for assertions. */
  readonly requests: GenerateOptions[] = []
  private readonly options: SeatAdapterOptions
  private readonly runs = new Map<SessionId, SeatRun>()

  /** @param options - the route, the agent and the ports the adapter reads. */
  constructor(options: SeatAdapterOptions) {
    super()
    this.options = options
  }

  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: `${this.options.displayName} (external agent, not a chat model)` }
  }

  /** @returns no models: the route never appears in a picker (EA2). */
  override listModels(): Promise<readonly LlmModelInfo[]> {
    return Promise.resolve([])
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({
      provider, id: model, name: this.options.displayName, inputModalities: ['text'], context: { contextWindow: this.options.contextWindow },
    })
  }

  /**
   * The live seat for a child, for the executor and the relay.
   * @param child - the seat child.
   * @returns the live seat, or undefined when no program session is open.
   */
  runOf(child: SessionId): SeatRun | undefined {
    return this.runs.get(child)
  }

  /**
   * Drop and close a child's program session (a quiet agent's program is closed, EA23; an archive; a lease end). The
   * program's own session stays on disk and the next message resumes it.
   * @param child - the seat child.
   * @returns resolves when the program has been asked to close.
   */
  async release(child: SessionId): Promise<void> {
    const run = this.runs.get(child)
    if (run === undefined) return
    this.runs.delete(child)
    await run.program.close()
  }

  /**
   * Drop and close every open program session, as when the plugin stops.
   * @returns resolves when every program has been asked to close.
   */
  async releaseAll(): Promise<void> {
    await Promise.all([...this.runs.keys()].map(child => this.release(child)))
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const child = this.recognise(options)
    if (child === undefined) {
      yield { type: 'finish', reason: { kind: 'error', failure: { message: SEAT_ROUTE_REFUSED_MESSAGE, code: SEAT_ROUTE_REFUSED } } }
      return
    }
    yield* this.serve(child, options, options.signal ?? new AbortController().signal)
  }

  /**
   * The seat child a request is the own turn of.
   * @param options - the request.
   * @returns the child, or undefined when the request is anything else: a title or compaction request, a chat the
   *   gate holds no seat for (an ordinary chat or a fork), or a child the descriptor does not tie to this route.
   */
  private recognise(options: GenerateOptions): SessionId | undefined {
    if (options.purpose !== undefined || options.sessionId === undefined || options.provider !== this.options.route) return undefined
    const child: SessionId = options.sessionId
    if (this.options.host.descriptorProvider(child) !== this.options.descriptorProvider) return undefined
    const seat = this.options.gate.seat(child)
    if (seat !== undefined) return seat.provider === this.options.provider ? child : undefined
    // The gate registers a seat while it starts the program, so the first turn, and the first turn after a Host restart,
    // arrives before any registration; `gate.start` then runs the consent review and refuses an unapproved seat.
    // A fork is an ordinary top-level Session with no creator, so it never reaches the start.
    return this.runs.has(child) || this.options.host.creator(child) === undefined ? undefined : child
  }

  private async * serve(child: SessionId, options: GenerateOptions, signal: AbortSignal): AsyncIterable<StreamChunk> {
    let run = this.runs.get(child)
    if (run?.closed === true) {
      this.runs.delete(child)
      run = undefined
    }
    if (run?.interrupted === true) {
      try {
        await run.settleStop(signal)
      } catch (error: unknown) {
        if (signal.aborted) throw error
        // Stop ended the program with its turn (the start's signal closes it), so no turn end will arrive: the seat opens
        // the program's own session again below, as for a program that went quiet.
        this.runs.delete(child)
        await run.program.close()
        run = undefined
      }
    }
    const state = run === undefined ? await this.options.states.read(child) : undefined
    const { host } = this.options
    const input = newInput(options.messages, {
      cursor: run === undefined ? state?.cursor : run.cursor,
      isHarnessCall: callId => host.isHarnessCall?.(child, callId) === true,
    })
    switch (input.kind) {
      case 'parted':
        yield errorFinish(HISTORY_PARTED)
        return
      case 'unseparable':
        yield errorFinish(TASK_UNSEPARABLE)
        return
      case 'input':
        break
    }
    if (input.lastId === undefined) {
      // A repeated request with nothing new: the program is not sent the same input again.
      if (run === undefined) {
        yield { type: 'finish', reason: { kind: 'stop' } }
        return
      }
      if (run.turnEnded) {
        yield* this.finishOf(run)
        return
      }
      yield* this.relay(child, run, signal)
      return
    }
    if (run === undefined) {
      try {
        run = await this.open(child, state?.programSessionId, state?.cursor, signal)
      } catch (error: unknown) {
        yield this.openFailure(child, error)
        return
      }
    }
    for (const result of input.harnessResults) host.deliverHarnessResult?.(child, result)
    // A program that went quiet and closed is started again once, resuming its own session, before the message is given up.
    // A text is counted as sent once `send` returns; one whose `send` threw goes to the restarted program. A program that took
    // the text and then threw would receive it twice, which only repeats the person's own words.
    let sent = 0
    let restarted = false
    for (;;) {
      try {
        for (const text of input.texts.slice(sent)) {
          await run.program.send(text, run.turnEnded ? 'start' : 'steer')
          run.turnEnded = false
          run.failure = undefined
          sent++
        }
        break
      } catch (error: unknown) {
        if (signal.aborted) throw error
        this.runs.delete(child)
        await run.program.close()
        if (restarted) {
          yield errorFinish(PROGRAM_CLOSED)
          return
        }
        restarted = true
        try {
          run = await this.open(child, run.program.programSessionId, run.cursor, signal)
        } catch (openError: unknown) {
          yield this.openFailure(child, openError)
          return
        }
      }
    }
    run.cursor = input.lastId
    await this.options.states.write(child, { programSessionId: run.program.programSessionId, cursor: input.lastId })
    yield* this.relay(child, run, signal)
  }

  /**
   * Open or resume the child's program through the start gate.
   * @param child - the seat child.
   * @param resume - the program session id to resume.
   * @param cursor - the logged input cursor, kept on the new live seat.
   * @param signal - aborts the start.
   * @returns the live seat.
   */
  private async open(child: SessionId, resume: string | undefined, cursor: string | undefined, signal: AbortSignal): Promise<SeatRun> {
    const { gate, host, models, states, events, provider } = this.options
    const creator = host.creator(child)
    const cwd = host.cwd(child)
    if (creator === undefined || cwd === undefined) throw new SeatFolderUnknown()
    const workspace = host.workspaceOf(child)
    const model = workspace === undefined ? undefined : models.get(workspace)
    events?.onStarting?.(child, provider)
    let program: SeatSession
    try {
      program = await gate.start({
        purpose: 'seat', provider, creator, child, cwd,
        ...resume === undefined ? {} : { resume },
        ...model === undefined ? {} : { model },
        ...states.delegationPinned?.(child) === true ? { pinned: true } : {},
        harnessTools: [],
        onApproval: request => host.approve(child, request, signal),
        signal,
      })
    } catch (error: unknown) {
      events?.onStartFailed?.(child)
      throw error
    }
    events?.onStarted?.(child, { sandbox: program.sandbox ?? 'off' })
    const run = new SeatRun(program)
    run.cursor = cursor
    if (resume !== program.programSessionId) {
      await states.write(child, { programSessionId: program.programSessionId, ...cursor === undefined ? {} : { cursor } })
    }
    this.runs.set(child, run)
    return run
  }

  /**
   * Turn a failed open into the turn's error finish and tell the rest of the plugin.
   * @param child - the seat child.
   * @param error - what the gate or the driver threw.
   * @returns the finish chunk.
   */
  private openFailure(child: SessionId, error: unknown): StreamChunk {
    const { events } = this.options
    if (error instanceof SeatFolderUnknown) return errorFinish(SEAT_FOLDER_UNKNOWN)
    if (error instanceof GateRefusedError) {
      const { refusal } = error
      if (refusal.category === 'limit') events?.onTurnFailure?.(child, { category: 'limit', resetsAt: refusal.resetsAt }, 'start')
      return errorFinish(gateRefusal(refusal))
    }
    if (error instanceof ProgramOpenError) return this.failureFinish(child, error.failure, 'start')
    throw error
  }

  /**
   * The error finish for a program failure, after telling the rest of the plugin.
   * @param child - the seat child.
   * @param failure - why the open or the turn failed.
   * @param stage - whether the program could not be opened or failed during a turn.
   * @returns the finish chunk.
   */
  private failureFinish(child: SessionId, failure: ProgramFailure, stage: 'start' | 'turn'): StreamChunk {
    const { events, provider } = this.options
    if (failure.category === 'model-not-offered') {
      events?.onModelNotOffered?.({ child, provider, configured: failure.configured, offered: failure.offered })
    }
    events?.onTurnFailure?.(child, failure, stage)
    return errorFinish(programFailure(failure))
  }

  /** How the seat's last turn ended, reported again for a repeated request. */
  private * finishOf(run: SeatRun): Iterable<StreamChunk> {
    if (run.failure === undefined) yield { type: 'finish', reason: { kind: 'stop' } }
    else yield errorFinish(programFailure(run.failure))
  }

  /** Stream program events until a message with tool calls ends (one step) or the program's turn ends. */
  private async * relay(child: SessionId, run: SeatRun, signal: AbortSignal): AsyncIterable<StreamChunk> {
    let index = 0
    let open: { readonly index: number, readonly kind: 'text' | 'reasoning', text: string } | undefined
    let calls = 0
    let usage: TokenUsage | undefined
    const close = (): StreamChunk[] => {
      if (open === undefined) return []
      const block = open.kind === 'text' ? { type: 'text' as const, text: open.text } : { type: 'reasoning' as const, text: open.text }
      const chunk: StreamChunk = { type: 'block-end', index: open.index, block }
      open = undefined
      return [chunk]
    }
    for (;;) {
      let event
      try {
        event = await run.next(signal)
      } catch (error: unknown) {
        if (signal.aborted) await run.stop()
        throw error
      }
      switch (event.kind) {
        case 'text':
        case 'reasoning': {
          if (open?.kind !== event.kind) {
            yield* close()
            open = { index: index++, kind: event.kind, text: '' }
            yield { type: 'block-start', index: open.index, blockType: event.kind }
          }
          open.text += event.text
          yield event.kind === 'text'
            ? { type: 'text-delta', index: open.index, text: event.text }
            : { type: 'reasoning-delta', index: open.index, text: event.text }
          break
        }
        case 'tool-call': {
          yield* close()
          const at = index++
          const id = ToolCallId(event.id)
          const name = this.options.host.isHarnessTool?.(child, event.name) === true ? event.name : `${this.options.recordPrefix}${event.name}`
          yield { type: 'block-start', index: at, blockType: 'tool-call' }
          yield { type: 'tool-call-delta', index: at, id, name, argumentsDelta: event.input }
          yield { type: 'block-end', index: at, block: { type: 'tool-call', id, name, arguments: event.input } }
          calls++
          break
        }
        case 'message-end':
          yield* close()
          if (event.usage !== undefined) usage = addUsage(usage, event.usage)
          if (calls > 0) {
            if (usage !== undefined) yield { type: 'usage', usage }
            yield { type: 'finish', reason: { kind: 'tool-calls' } }
            return
          }
          break
        case 'turn-end': {
          yield* close()
          run.turnEnded = true
          if (event.usage !== undefined) usage = addUsage(usage, event.usage)
          if (usage !== undefined) yield { type: 'usage', usage }
          if (event.outcome === 'failed') {
            run.failure = event.failure ?? { category: 'program', detail: '' }
            yield this.failureFinish(child, run.failure, 'turn')
            return
          }
          yield { type: 'finish', reason: { kind: 'stop' } }
          return
        }
      }
    }
  }
}

/** The seat child has no creator or folder to start the program with. */
class SeatFolderUnknown extends Error {
  constructor() {
    super('the seat child has no creator or run folder')
    this.name = 'SeatFolderUnknown'
  }
}
