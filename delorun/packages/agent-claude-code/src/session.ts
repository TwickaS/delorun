/**
 * One Claude Code program session over a streaming-input SDK query: the program's messages as {@link ProgramEvent}s in
 * program order, input as new turns or as steers into the running turn, interrupt and close.
 *
 * Mapping: each assistant content block becomes a `text`, `reasoning` or `tool-call` event; a program message ends
 * (`message-end`, with that message's tokens) when the next message, a tool result or a permission question arrives; each
 * tool result becomes a `tool-result`; the program's `result` ends the turn. Frames of the program's own sub-agents
 * (`parent_tool_use_id` set) stay inside the tool call that started them and are not mapped. A steer is queued with
 * priority `next`, so the program takes it at its next tool boundary within the same turn.
 * @module @delorun/agent-claude-code/session
 */
import type {
  SDKAssistantMessage, SDKAssistantMessageError, SDKMessage, SDKResultMessage, SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk'
import type { TokenUsage } from '@deepseek-ai/dsh-llm'
import { isAgentSignInFailure } from '@deepseek-ai/dsh-subagent'
import { ClaudeCodeDriverError } from './errors.ts'
import { runObservation } from './limits.ts'
import type { AccountObservation, OfferedModel, ProgramEvent, ProgramFailure, ProgramSession } from './pending-contract.ts'
import { Queue } from './queue.ts'
import type { ClaudeQuery } from './sdk.ts'

/** The longest failure detail kept for the person's view. */
const DETAIL_LIMIT = 500

/** Claude Code's error text when the session to resume does not exist. */
const NO_CONVERSATION = 'No conversation found'

/** The assistant errors that mean the program is not signed in. */
const SIGNED_OUT_ERRORS: ReadonlySet<SDKAssistantMessageError> = new Set(['authentication_failed', 'oauth_org_not_allowed'])

/**
 * An Anthropic usage block as token usage.
 * @param usage - the message's or turn's usage block.
 * @returns the usage, or undefined when it has no token counts.
 */
export function tokenUsage(usage: { readonly input_tokens?: number | null; readonly output_tokens?: number | null; readonly cache_read_input_tokens?: number | null; readonly cache_creation_input_tokens?: number | null } | null | undefined): TokenUsage | undefined {
  if (usage === null || usage === undefined) return undefined
  if (typeof usage.input_tokens !== 'number' || typeof usage.output_tokens !== 'number') return undefined
  return {
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    ...typeof usage.cache_read_input_tokens === 'number' ? { cacheReadTokens: usage.cache_read_input_tokens } : {},
    ...typeof usage.cache_creation_input_tokens === 'number' ? { cacheWriteTokens: usage.cache_creation_input_tokens } : {},
  }
}

function addUsage(total: TokenUsage | undefined, more: TokenUsage | undefined): TokenUsage | undefined {
  if (total === undefined) return more
  if (more === undefined) return total
  const sum = (a: number | undefined, b: number | undefined): number | undefined => a === undefined && b === undefined ? undefined : (a ?? 0) + (b ?? 0)
  const cacheReadTokens = sum(total.cacheReadTokens, more.cacheReadTokens)
  const cacheWriteTokens = sum(total.cacheWriteTokens, more.cacheWriteTokens)
  return {
    inputTokens: total.inputTokens + more.inputTokens,
    outputTokens: total.outputTokens + more.outputTokens,
    ...cacheReadTokens === undefined ? {} : { cacheReadTokens },
    ...cacheWriteTokens === undefined ? {} : { cacheWriteTokens },
  }
}

function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return content === undefined || content === null ? '' : JSON.stringify(content)
  return content.map((block: unknown) => {
    if (typeof block === 'object' && block !== null && 'type' in block && block.type === 'text' && 'text' in block && typeof block.text === 'string') return block.text
    return JSON.stringify(block)
  }).join('\n')
}

function detail(text: string): string {
  const trimmed = text.trim()
  return trimmed.length > DETAIL_LIMIT ? `${trimmed.slice(0, DETAIL_LIMIT)}…` : trimmed
}

function resultText(result: SDKResultMessage): string {
  if (result.subtype === 'success') return result.result
  return result.errors.length > 0 ? result.errors.join('; ') : result.subtype
}

/** What a session needs besides its query. */
export interface ClaudeCodeSessionOptions {
  /** The program session id: the resumed one, or the one given to a new session. */
  readonly programSessionId: string
  /** Whether the session resumes an earlier one. */
  readonly resumed: boolean
  /** The model the person picked, if any. */
  readonly model?: string
  /** Receives the plan figures a run reports. */
  readonly onLimits: (observation: AccountObservation) => void
}

/** One live Claude Code program session. Build it with its input stream first, then {@link ClaudeCodeSession.attach} the query. */
export class ClaudeCodeSession implements ProgramSession {
  readonly #events = new Queue<ProgramEvent>()
  readonly #input = new Queue<SDKUserMessage>()
  readonly #options: ClaudeCodeSessionOptions
  #query: ClaudeQuery | undefined
  #pump: Promise<void> = Promise.resolve()
  #programSessionId: string
  #running = false
  #interruptRequested = false
  #closed = false
  #initSeen = false
  /** The open program message: its id and its last-seen usage. */
  #open: { readonly id: string; usage: TokenUsage | undefined } | undefined
  #lastError: SDKAssistantMessageError | undefined
  #rejectedResetsAt: number | undefined
  /** Usage of program turns that continued into the same seat turn. */
  #carriedUsage: TokenUsage | undefined
  /** Why the program ended on its own, once it has. */
  #ended: ProgramFailure | undefined

  /** @param options - the session's identity, model and limits observer. */
  constructor(options: ClaudeCodeSessionOptions) {
    this.#options = options
    this.#programSessionId = options.programSessionId
  }

  /** The program's own session id, which a later open resumes. */
  get programSessionId(): string { return this.#programSessionId }
  /** Whether a program turn is running. */
  get turnRunning(): boolean { return this.#running }

  /**
   * The input the query reads: one SDK user message per {@link ClaudeCodeSession.send}, ending at close.
   * @returns the stream.
   */
  async * inputStream(): AsyncGenerator<SDKUserMessage> {
    const never = new AbortController().signal
    for (;;) {
      let message: SDKUserMessage
      try {
        message = await this.#input.take(never)
      } catch (_closed) {
        // The input queue ends only at close, which ends the program's input.
        return
      }
      yield message
    }
  }

  /**
   * Start reading the query's messages.
   * @param query - the query started over {@link ClaudeCodeSession.inputStream}.
   */
  attach(query: ClaudeQuery): void {
    this.#query = query
    this.#pump = this.#read(query)
  }

  async #read(query: ClaudeQuery): Promise<void> {
    let failure: unknown
    try {
      for await (const message of query) await this.#receive(message)
    } catch (error: unknown) {
      failure = error
    }
    if (this.#closed) return
    this.#ended = this.#endFailure(failure)
    if (this.#running) this.#endTurn('failed', undefined, this.#ended)
  }

  #endFailure(error: unknown): ProgramFailure {
    const text = error instanceof Error ? error.message : error === undefined ? '' : String(error)
    if (this.#options.resumed && (!this.#initSeen || text.includes(NO_CONVERSATION))) return { category: 'resume-failed' }
    if (isAgentSignInFailure(text)) return { category: 'signed-out' }
    return { category: 'program', detail: detail(text.length > 0 ? text : 'Claude Code ended unexpectedly.') }
  }

  /**
   * End the open program message. Claude Code asks about a tool call only once its whole message has arrived, so the
   * driver ends the message before the question goes to the seat, which then records the call before asking.
   */
  endMessage(): void {
    const open = this.#open
    if (open === undefined) return
    this.#open = undefined
    this.#events.push(open.usage === undefined ? { kind: 'message-end' } : { kind: 'message-end', usage: open.usage })
  }

  async #receive(message: SDKMessage): Promise<void> {
    switch (message.type) {
      case 'system':
        if (message.subtype === 'init') {
          this.#initSeen = true
          this.#programSessionId = message.session_id
        }
        return
      case 'assistant':
        this.#assistant(message)
        return
      case 'user':
        if (message.parent_tool_use_id !== null) return
        this.endMessage()
        this.#toolResults(message.message.content)
        return
      case 'result':
        await this.#result(message)
        return
      case 'rate_limit_event':
        if (message.rate_limit_info.status === 'rejected' && message.rate_limit_info.resetsAt !== undefined) {
          this.#rejectedResetsAt = message.rate_limit_info.resetsAt * 1000
        }
        this.#options.onLimits(runObservation(message.rate_limit_info))
        return
      default:
        // Status, progress, task and other informational messages carry nothing the seat records.
        return
    }
  }

  #assistant(message: SDKAssistantMessage): void {
    if (message.parent_tool_use_id !== null) return
    if (message.error !== undefined) this.#lastError = message.error
    const id = message.message.id
    if (this.#open !== undefined && this.#open.id !== id) this.endMessage()
    this.#open ??= { id, usage: undefined }
    this.#open.usage = tokenUsage(message.message.usage) ?? this.#open.usage
    for (const block of message.message.content) {
      switch (block.type) {
        case 'text':
          this.#events.push({ kind: 'text', text: block.text })
          break
        case 'thinking':
          this.#events.push({ kind: 'reasoning', text: block.thinking })
          break
        case 'tool_use':
          this.#events.push({ kind: 'tool-call', id: block.id, name: block.name, input: JSON.stringify(block.input) })
          break
        default:
          // Redacted reasoning and server-side blocks have nothing the person can read.
          break
      }
    }
  }

  #toolResults(content: SDKUserMessage['message']['content']): void {
    if (typeof content === 'string') return
    for (const block of content) {
      if (block.type !== 'tool_result') continue
      this.#events.push({ kind: 'tool-result', id: block.tool_use_id, output: toolResultText(block.content), isError: block.is_error === true })
    }
  }

  async #result(result: SDKResultMessage): Promise<void> {
    this.endMessage()
    const usage = tokenUsage(result.usage)
    const failed = result.subtype !== 'success' || result.is_error
    if (!failed && !this.#interruptRequested && (result.queued_turn_count ?? 0) > 0) {
      // A steer that arrived as the turn ended starts another program turn without new input; the seat's turn goes on.
      this.#carriedUsage = addUsage(this.#carriedUsage, usage)
      return
    }
    if (this.#interruptRequested) {
      this.#endTurn('interrupted', usage)
      return
    }
    if (!failed) {
      this.#endTurn('completed', usage)
      return
    }
    this.#endTurn('failed', usage, await this.#turnFailure(result))
  }

  async #turnFailure(result: SDKResultMessage): Promise<ProgramFailure> {
    const text = resultText(result)
    const error = this.#lastError
    if ((error !== undefined && SIGNED_OUT_ERRORS.has(error)) || isAgentSignInFailure(text)) return { category: 'signed-out' }
    if (error === 'rate_limit' || result.terminal_reason === 'blocking_limit') {
      return this.#rejectedResetsAt === undefined ? { category: 'limit' } : { category: 'limit', resetsAt: this.#rejectedResetsAt }
    }
    if (error === 'model_not_found') return { category: 'model-not-offered', configured: this.#options.model ?? 'default', offered: await this.#offeredModels() }
    if (this.#options.resumed && text.includes(NO_CONVERSATION)) return { category: 'resume-failed' }
    return { category: 'program', detail: detail(text) }
  }

  async #offeredModels(): Promise<OfferedModel[]> {
    try {
      const models = await this.#query?.supportedModels() ?? []
      return models.map(model => ({ id: model.value, displayName: model.displayName, isDefault: model.value === 'default' }))
    } catch (_unanswered) {
      // The program could not list its models; the person still learns the configured model was refused.
      return []
    }
  }

  #endTurn(outcome: 'completed' | 'interrupted' | 'failed', usage: TokenUsage | undefined, failure?: ProgramFailure): void {
    const total = addUsage(this.#carriedUsage, usage)
    this.#carriedUsage = undefined
    this.#running = false
    this.#interruptRequested = false
    this.#lastError = undefined
    this.#events.push({
      kind: 'turn-end',
      outcome,
      ...total === undefined ? {} : { usage: total },
      ...failure === undefined ? {} : { failure },
    })
  }

  /**
   * Send input to the program.
   * @param text - the text.
   * @param mode - `start` begins a turn; `steer` joins the running turn at its next tool boundary.
   * @throws ClaudeCodeDriverError `closed` after close, `turn-running` to start while a turn runs, `no-turn` to steer while none runs.
   */
  send(text: string, mode: 'start' | 'steer'): Promise<void> {
    if (this.#closed) return Promise.reject(new ClaudeCodeDriverError('closed', 'This Claude Code session is closed.'))
    if (mode === 'start' && this.#running) return Promise.reject(new ClaudeCodeDriverError('turn-running', 'A Claude Code turn is already running; steer it instead.'))
    if (mode === 'steer' && !this.#running) return Promise.reject(new ClaudeCodeDriverError('no-turn', 'No Claude Code turn is running to steer; start one instead.'))
    if (this.#ended !== undefined) {
      // The program has ended; the turn fails at once with the reason it ended.
      this.#running = true
      this.#endTurn('failed', undefined, this.#ended)
      return Promise.resolve()
    }
    if (mode === 'start') this.#running = true
    this.#input.push({
      type: 'user',
      message: { role: 'user', content: text },
      parent_tool_use_id: null,
      ...mode === 'steer' ? { priority: 'next' } : {},
    })
    return Promise.resolve()
  }

  /** Record that the person's answer to a question stopped the running turn, which then ends `interrupted`. */
  stopping(): void {
    if (this.#running) this.#interruptRequested = true
  }

  /** Interrupt the running turn; its `turn-end` reports `interrupted`. The session stays usable. */
  async interrupt(): Promise<void> {
    if (!this.#running || this.#closed || this.#query === undefined) return
    this.#interruptRequested = true
    await this.#query.interrupt()
  }

  /**
   * Take the next event, waiting for one.
   * @param signal - aborts the wait.
   * @returns the next event in program order.
   * @throws ClaudeCodeDriverError `closed` once the session is closed and its events are taken.
   */
  next(signal: AbortSignal): Promise<ProgramEvent> {
    return this.#events.take(signal)
  }

  /** End the program process; Claude Code keeps the session where it keeps its sessions, for a later resume. */
  async close(): Promise<void> {
    if (this.#closed) return
    this.#closed = true
    this.#input.end(new ClaudeCodeDriverError('closed', 'This Claude Code session is closed.'))
    this.#query?.close()
    await this.#pump
    this.#running = false
    this.#events.end(new ClaudeCodeDriverError('closed', 'This Claude Code session is closed.'))
  }
}
