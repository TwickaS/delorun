/**
 * Test support for the seat adapter specs: a scripted program session standing in for Claude Code or Codex, a
 * scripted start gate, a scripted host, and message builders. No process starts.
 */
import type { GenerateOptions, Message, RequestMessage, StreamChunk } from '@deepseek-ai/dsh-llm'
import { MessageId, ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type {
  ProgramApprovalAnswer, ProgramApprovalRequest, ProgramEvent, ProgramInterruptOutcome, SeatRecord, SeatSession, SeatStartRequest,
} from '@delorun/external-agents/contract'
import { SeatAdapter, type SeatAdapterOptions, type SeatHost } from '../../src/adapter/adapter.ts'
import type {
  ModelNotOffered, SeatAdapterEvents, SeatModelChoices, SeatState, SeatStateStore,
} from '../../src/adapter/state-port.ts'

declare module '@deepseek-ai/dsh-llm/types' {
  interface LlmRequestPurposeMap {
    'compaction': true
    'session-title': true
  }
}

/** The route the specs register. */
export const ROUTE = 'delorun-seat-claude-code'
/** The seat child. */
export const CHILD = SessionId('child-1')

/** A program session that does only what a spec tells it to, and records what it receives. */
export class ScriptedProgram implements SeatSession {
  readonly allowedBy = 'consent-off' as const
  readonly sent: Array<{ readonly text: string, readonly mode: 'start' | 'steer' }> = []
  interrupts = 0
  closed = false
  interruptOutcome: ProgramInterruptOutcome = 'interrupted'
  turnRunning = false
  sandboxUnavailable: boolean | undefined
  sendError: Error | undefined
  private readonly queue: ProgramEvent[] = []
  private waiter: PromiseWithResolvers<ProgramEvent> | undefined

  readonly programSessionId: string

  /** @param programSessionId - the program's session id. */
  constructor(programSessionId = 'program-1') {
    this.programSessionId = programSessionId
  }

  /** @param events - events the program produces, in order. */
  emit(...events: ProgramEvent[]): void {
    for (const event of events) {
      if (event.kind === 'turn-end') this.turnRunning = false
      const waiter = this.waiter
      this.waiter = undefined
      if (waiter !== undefined) waiter.resolve(event)
      else this.queue.push(event)
    }
  }

  send(text: string, mode: 'start' | 'steer'): Promise<void> {
    if (this.sendError !== undefined) return Promise.reject(this.sendError)
    this.sent.push({ text, mode })
    this.turnRunning = true
    return Promise.resolve()
  }

  interrupt(): Promise<ProgramInterruptOutcome> {
    this.interrupts++
    if (this.interruptOutcome === 'interrupted') this.emit({ kind: 'turn-end', outcome: 'interrupted' })
    return Promise.resolve(this.interruptOutcome)
  }

  next(signal: AbortSignal): Promise<ProgramEvent> {
    const ready = this.queue.shift()
    if (ready !== undefined) return Promise.resolve(ready)
    const waiter = Promise.withResolvers<ProgramEvent>()
    this.waiter = waiter
    signal.addEventListener('abort', () => {
      if (this.waiter === waiter) this.waiter = undefined
      waiter.reject(signal.reason)
    }, { once: true })
    return waiter.promise
  }

  close(): Promise<void> {
    this.closed = true
    return Promise.resolve()
  }
}

/** The scripted start gate. */
export class ScriptedGate {
  readonly starts: SeatStartRequest[] = []
  readonly programs: ScriptedProgram[] = []
  /** What the gate holds a seat for. */
  readonly seats = new Map<SessionId, SeatRecord>()
  /** Throws this on the next start. */
  failure: unknown
  /** The program the next start returns. */
  next = (): ScriptedProgram => new ScriptedProgram(`program-${this.programs.length + 1}`)

  start(request: SeatStartRequest): Promise<SeatSession> {
    this.starts.push(request)
    if (this.failure !== undefined) return Promise.reject(this.failure)
    const program = this.next()
    this.programs.push(program)
    return Promise.resolve(program)
  }

  seat(child: SessionId): SeatRecord | undefined {
    return this.seats.get(child)
  }

  /** @returns the latest program started. */
  get latest(): ScriptedProgram {
    const program = this.programs.at(-1)
    if (program === undefined) throw new Error('no program started')
    return program
  }
}

/** An in-memory state store that records its writes. */
export class MemoryStates implements SeatStateStore {
  readonly states = new Map<SessionId, SeatState>()
  readonly writes: SeatState[] = []

  read(child: SessionId): SeatState | undefined {
    return this.states.get(child)
  }

  write(child: SessionId, state: SeatState): void {
    this.writes.push(state)
    this.states.set(child, state)
  }
}

/** An in-memory per-workspace model choice. */
export class MemoryModels implements SeatModelChoices {
  readonly choices = new Map<string, string>()

  get(workspace: string): string | undefined {
    return this.choices.get(workspace)
  }

  set(workspace: string, id: string): void {
    this.choices.set(workspace, id)
  }
}

/** Everything the adapter reports. */
export interface Reports {
  readonly starting: string[]
  readonly started: string[]
  readonly startFailed: string[]
  readonly notOffered: ModelNotOffered[]
  readonly failures: Array<{ readonly child: string, readonly category: string, readonly resetsAt?: number }>
}

/** A world for one adapter. */
export interface World {
  readonly adapter: SeatAdapter
  readonly gate: ScriptedGate
  readonly states: MemoryStates
  readonly models: MemoryModels
  readonly reports: Reports
  readonly approvals: ProgramApprovalRequest[]
}

/**
 * Build an adapter whose child `CHILD` is a seat of `claude-code` created by `root`, in the folder `/work`.
 * @param change - fields of the adapter's options or host to change.
 * @returns the world.
 */
export function world(change: { readonly host?: Partial<SeatHost>, readonly seat?: boolean, readonly answer?: ProgramApprovalAnswer } = {}): World {
  const gate = new ScriptedGate()
  if (change.seat !== false) gate.seats.set(CHILD, { child: CHILD, root: SessionId('root'), provider: 'claude-code' })
  const states = new MemoryStates()
  const models = new MemoryModels()
  const approvals: ProgramApprovalRequest[] = []
  const reports: Reports = { starting: [], started: [], startFailed: [], notOffered: [], failures: [] }
  const events: SeatAdapterEvents = {
    onStarting: (child, provider) => { reports.starting.push(`${child}:${provider}`) },
    onStarted: (child) => { reports.started.push(child) },
    onStartFailed: (child) => { reports.startFailed.push(child) },
    onModelNotOffered: (payload) => { reports.notOffered.push(payload) },
    onTurnFailure: (child, failure) => {
      reports.failures.push({ child, category: failure.category, ...failure.category === 'limit' && failure.resetsAt !== undefined ? { resetsAt: failure.resetsAt } : {} })
    },
  }
  const host: SeatHost = {
    descriptorProvider: child => child === CHILD ? 'claude-code' : undefined,
    creator: child => child === CHILD ? SessionId('root') : undefined,
    cwd: () => '/work',
    workspaceOf: () => 'workspace-1',
    approve: (_child, request) => {
      approvals.push(request)
      return Promise.resolve(change.answer ?? 'allow-once')
    },
    ...change.host,
  }
  const options: SeatAdapterOptions = {
    route: ROUTE, provider: 'claude-code', descriptorProvider: 'claude-code', displayName: 'Claude Code', recordPrefix: 'claude_code.', contextWindow: 200_000,
    gate, host, states, models, events,
  }
  return { adapter: new SeatAdapter(options), gate, states, models, reports, approvals }
}

let counter = 0

/**
 * @param text - the text.
 * @param kind - the message source kind.
 * @returns a user-role message with a durable id.
 */
export function user(text: string, kind: 'user' | 'system-prompt' = 'user'): Message {
  return { role: 'user', id: MessageId(`m${++counter}`), content: [{ type: 'text', text }], source: { kind } }
}

/**
 * @param blocks - the text blocks, in order.
 * @returns a user-role message from a person or the delegating model with several blocks.
 */
export function userBlocks(...blocks: string[]): Message {
  return { role: 'user', id: MessageId(`m${++counter}`), content: blocks.map(text => ({ type: 'text' as const, text })), source: { kind: 'user' } }
}

/**
 * @param senderName - the sending agent's name.
 * @param text - the message text.
 * @returns the message `send_message` writes into the child.
 */
export function agentMessage(senderName: string, text: string): Message {
  return {
    role: 'user',
    id: MessageId(`m${++counter}`),
    content: [{ type: 'text', text: `Agent ${senderName} sent a message: ` }, { type: 'text', text }],
    source: { kind: 'agent-message', form: 'relay', senderSessionId: SessionId('root') },
  }
}

/** @returns a system message. */
export function system(): Message {
  return { role: 'system', id: MessageId(`m${++counter}`), content: [{ type: 'text', text: 'You are a helpful agent.' }], source: { kind: 'system-prompt' } }
}

/** @returns a developer message (a tool-list change). */
export function developer(): Message {
  return { role: 'developer', id: MessageId(`m${++counter}`), content: [{ type: 'text', text: 'Tools changed.' }], source: { kind: 'user' } }
}

/**
 * @param callId - the call the result answers.
 * @param text - the output.
 * @returns a recorded tool result.
 */
export function toolResult(callId: string, text: string): Message {
  return { role: 'tool', id: MessageId(`m${++counter}`), content: [{ type: 'text', text }], source: { kind: 'tool', callId: ToolCallId(callId) }, toolCallId: ToolCallId(callId) }
}

/**
 * @param messages - the history.
 * @param extra - fields of the request to change.
 * @returns a request on the route for the child.
 */
export function request(messages: RequestMessage[], extra: Partial<GenerateOptions> = {}): GenerateOptions {
  return { provider: ROUTE, model: 'default', messages, sessionId: CHILD, ...extra }
}

/**
 * @param stream - an adapter stream.
 * @returns every chunk.
 */
export async function collect(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

/**
 * @param chunks - a stream's chunks.
 * @returns the finish chunk's reason.
 */
export function finishOf(chunks: readonly StreamChunk[]): Extract<StreamChunk, { type: 'finish' }>['reason'] {
  const finish = chunks.at(-1)
  if (finish?.type !== 'finish') throw new Error('the stream did not end with a finish')
  return finish.reason
}
