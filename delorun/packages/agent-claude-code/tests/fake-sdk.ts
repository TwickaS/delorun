/**
 * A fake Claude Agent SDK for the unit specs: each `query()` records its options and input, and the spec plays the
 * program's messages. No process starts.
 * @module @delorun/agent-claude-code/tests/fake-sdk
 */
import type {
  AccountInfo, McpSdkServerConfigWithInstance, ModelInfo, Options, PermissionUpdate, SDKAssistantMessage, SDKControlGetUsageResponse, SDKMessage,
  SdkMcpToolDefinition, SDKRateLimitInfo, SDKRateLimitEvent, SDKResultMessage, SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk'
import { Queue } from '../src/queue.ts'
import type { ClaudeQuery, ClaudeSdk } from '../src/sdk.ts'

const never = new AbortController().signal

/** One fake query. */
export class FakeQuery implements ClaudeQuery {
  /** The options the driver passed. */
  readonly options: Options
  /** The messages the driver sent, in order. */
  readonly sent: SDKUserMessage[] = []
  /** How many times the driver interrupted. */
  interrupts = 0
  /** Whether the driver closed the query. */
  closed = false
  /** The account answer; a function throws to fail the call. */
  account: AccountInfo | (() => never) = { subscriptionType: 'max', apiProvider: 'firstParty', email: 'person@example.invalid', organization: 'Example Org' }
  /** The usage answer; a function throws to fail the call. */
  usage: SDKControlGetUsageResponse | (() => never) | undefined
  /** The offered models. */
  models: ModelInfo[] = []
  readonly #messages = new Queue<SDKMessage | Error | null>()
  readonly #reading: Promise<void>

  /**
   * @param prompt - the driver's input stream.
   * @param options - the driver's options.
   */
  constructor(prompt: AsyncIterable<SDKUserMessage>, options: Options) {
    this.options = options
    this.#reading = (async () => { for await (const message of prompt) this.sent.push(message) })()
  }

  /**
   * Play one program message.
   * @param message - the message.
   */
  emit(message: SDKMessage): void { this.#messages.push(message) }

  /**
   * End the program's message stream, with a failure if given.
   * @param error - the failure the stream throws, or none for a normal end.
   */
  finish(error?: Error): void { this.#messages.push(error ?? null) }

  /** Resolves when the driver's input stream has ended. */
  inputEnded(): Promise<void> { return this.#reading }

  async * [Symbol.asyncIterator](): AsyncIterator<SDKMessage> {
    for (;;) {
      const message = await this.#messages.take(never)
      if (message === null) return
      if (message instanceof Error) throw message
      yield message
    }
  }

  interrupt(): Promise<undefined> {
    this.interrupts += 1
    return Promise.resolve(undefined)
  }

  close(): void {
    this.closed = true
    this.#messages.push(null)
  }

  accountInfo(): Promise<AccountInfo> {
    const account = this.account
    return typeof account === 'function' ? Promise.reject(new Error('account unavailable')) : Promise.resolve(account)
  }

  usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET(): Promise<SDKControlGetUsageResponse> {
    const usage = this.usage
    if (usage === undefined || typeof usage === 'function') return Promise.reject(new Error('usage unavailable'))
    return Promise.resolve(usage)
  }

  supportedModels(): Promise<ModelInfo[]> { return Promise.resolve(this.models) }
}

/** A fake SDK module that keeps every query it started. */
export class FakeSdk implements ClaudeSdk {
  /** Every query, in order. */
  readonly queries: FakeQuery[] = []

  /** The tools of every MCP server the driver made, by server name. */
  readonly servers = new Map<string, SdkMcpToolDefinition[]>()

  readonly #configure: (query: FakeQuery) => void
  readonly #mcp: ClaudeSdk['createSdkMcpServer'] | undefined

  /**
   * @param configure - prepares each query's answers before the driver can call it.
   * @param mcp - the real SDK's in-process server maker, for specs that offer harness tools; it starts no process.
   */
  constructor(configure: (query: FakeQuery) => void = () => {}, mcp?: ClaudeSdk['createSdkMcpServer']) {
    this.#configure = configure
    this.#mcp = mcp
  }

  createSdkMcpServer(options: { name: string; tools: SdkMcpToolDefinition[] }): McpSdkServerConfigWithInstance {
    if (this.#mcp === undefined) throw new Error('this fake SDK makes no MCP server')
    this.servers.set(options.name, options.tools)
    return this.#mcp(options)
  }

  query(params: { prompt: AsyncIterable<SDKUserMessage>; options: Options }): FakeQuery {
    const query = new FakeQuery(params.prompt, params.options)
    this.#configure(query)
    this.queries.push(query)
    return query
  }

  /** The latest query. */
  get last(): FakeQuery {
    const query = this.queries.at(-1)
    if (query === undefined) throw new Error('no query was started')
    return query
  }
}

const uuid = '00000000-0000-4000-8000-000000000000'

/**
 * A program message as the SDK reads it from the program's JSON lines: only the fields the driver reads are given.
 * @param fields - the message's fields.
 * @returns the message.
 */
function wire(fields: object): SDKMessage {
  const message: SDKMessage = JSON.parse(JSON.stringify(fields))
  return message
}

/**
 * A `system/init` message.
 * @param sessionId - the program session id.
 * @returns the message.
 */
export function init(sessionId: string): SDKMessage {
  return wire({ type: 'system', subtype: 'init', session_id: sessionId, uuid })
}

type Block =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'thinking'; readonly thinking: string; readonly signature: string }
  | { readonly type: 'tool_use'; readonly id: string; readonly name: string; readonly input: Record<string, unknown> }
  | { readonly type: 'redacted_thinking'; readonly data: string }

/**
 * An assistant frame carrying one or more content blocks of one program message.
 * @param id - the program message id.
 * @param content - the blocks.
 * @param extra - usage, error or a sub-agent's parent call.
 * @param extra.usage - the message's usage.
 * @param extra.error - the assistant error.
 * @param extra.parent - the sub-agent's parent tool call id.
 * @returns the message.
 */
export function assistant(id: string, content: readonly Block[], extra: { usage?: { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number }; error?: SDKAssistantMessage['error']; parent?: string } = {}): SDKMessage {
  return wire({
    type: 'assistant',
    message: { id, type: 'message', role: 'assistant', content, usage: extra.usage ?? null },
    parent_tool_use_id: extra.parent ?? null,
    ...extra.error === undefined ? {} : { error: extra.error },
    uuid,
    session_id: 's',
  })
}

/**
 * A user frame carrying tool results.
 * @param results - the results.
 * @param parent - the sub-agent's parent tool call id.
 * @returns the message.
 */
export function toolResults(results: readonly { id: string; content: string | readonly { type: 'text'; text: string }[]; isError?: boolean }[], parent?: string): SDKMessage {
  return wire({
    type: 'user',
    message: { role: 'user', content: results.map(result => ({ type: 'tool_result', tool_use_id: result.id, content: result.content, ...result.isError === undefined ? {} : { is_error: result.isError } })) },
    parent_tool_use_id: parent ?? null,
    uuid,
    session_id: 's',
  })
}

/**
 * A `result` message.
 * @param fields - the result's subtype, flags, text, errors and usage.
 * @returns the message.
 */
export function result(fields: Partial<{ subtype: SDKResultMessage['subtype']; is_error: boolean; result: string; errors: string[]; usage: { input_tokens: number; output_tokens: number }; queued_turn_count: number; terminal_reason: SDKResultMessage['terminal_reason'] }> = {}): SDKMessage {
  return wire({
    type: 'result',
    subtype: fields.subtype ?? 'success',
    is_error: fields.is_error ?? false,
    result: fields.result ?? 'done',
    errors: fields.errors ?? [],
    usage: fields.usage ?? { input_tokens: 10, output_tokens: 5 },
    ...fields.queued_turn_count === undefined ? {} : { queued_turn_count: fields.queued_turn_count },
    ...fields.terminal_reason === undefined ? {} : { terminal_reason: fields.terminal_reason },
    uuid,
    session_id: 's',
  })
}

/**
 * A rate-limit event.
 * @param info - the rate-limit information.
 * @returns the message.
 */
export function rateLimit(info: SDKRateLimitInfo): SDKMessage {
  const message: SDKRateLimitEvent = { type: 'rate_limit_event', rate_limit_info: info, uuid, session_id: 's' }
  return message
}

/** Suggestions as Claude Code sends them for `touch a.txt`, including a mode change and a folder grant. */
export const TOUCH_SUGGESTIONS: PermissionUpdate[] = [
  { type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'touch a.txt' }], behavior: 'allow', destination: 'localSettings' },
  { type: 'setMode', mode: 'acceptEdits', destination: 'session' },
  { type: 'addDirectories', directories: ['/tmp/elsewhere'], destination: 'session' },
  { type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'rm -rf x' }], behavior: 'deny', destination: 'session' },
]
