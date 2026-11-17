/**
 * The seat tool executor: records a program's own tool calls in the seat child's log. The calls already ran inside the
 * program, so each is logged as `tool/call`, the program's result is awaited from the live program session, and
 * `tool/result` is logged citing the call, exactly as the native batch settlement does. No pre-execute listener, guard,
 * wrapper or spill policy sees a record (L17, D18). Calls to harness tools go through the native pipeline with every
 * policy.
 * @module @delorun/plugin-agent-seats/executor/executor
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createToolResultMessage, HarnessError, ToolCallId, type ToolCallBlock } from '@deepseek-ai/dsh-llm'
import type { SessionId, SessionSeq, UserMessage } from '@deepseek-ai/dsh-session'
import { formatSpillNotice } from '@deepseek-ai/dsh-spill-policy/notice'
import {
  projectToolSchema, ToolBatchExecutionError,
  type ToolBatchInput, type ToolBatchResult, type ToolCallResult, type ToolDefinition, type ToolExecutionResult,
  type ToolExecutor, type ToolModelInput,
} from '@deepseek-ai/dsh-tools'
import { executeToolBatch, ToolExecutionPipeline } from '@deepseek-ai/dsh-tools/pipeline'
import { cutOutput, type OutputCap } from './output-cap.ts'
import type { CallRecordedListener } from './ledger.ts'
import type { SeatProgram, SeatPrograms } from './types.ts'

/** The error code of a record that Stop closed before the program reported a result. */
export const RECORD_STOPPED = 'EXTERNAL_AGENT_STOPPED'

/** The error code of a record whose program was gone or failed before it reported a result. */
export const RECORD_PROGRAM_LOST = 'EXTERNAL_AGENT_PROGRAM_LOST'

/** The middle of a capped output. */
const GAP = '\n\n[...]\n\n'

/** The seat has no live program session to settle records against. */
export class SeatProgramMissingError extends HarnessError {
  /** @param sessionId - the seat child's Session id, for the message. */
  constructor(sessionId: string) {
    super(`The seat ${sessionId} has no live program session to settle its tool records.`, 'EXTERNAL_AGENT_PROGRAM_MISSING')
    this.name = 'SeatProgramMissingError'
  }
}

/** What the executor is built from. */
export interface SeatToolExecutorOptions {
  /** The seat preset's scope, which owns the harness-tool pipeline and the spill store lookup. */
  readonly ctx: Context
  /** The live program sessions and the ledger of written call records. */
  readonly programs: SeatPrograms
  /** The prefix every recorded tool name carries (`claude_code.`); a call with it is a record and is never run natively. */
  readonly recordPrefix: string
  /** How much of a large output stays inline. */
  readonly outputCap: OutputCap
  /** The most harness tools run at once. */
  readonly maxParallel: number
}

/** One run of consecutive calls of one kind, in program-message order. */
interface Segment {
  readonly kind: 'record' | 'harness'
  readonly calls: ToolCallBlock[]
}

/** Records program tool calls for seat children and runs the harness tools the program calls. */
export class SeatToolExecutor implements ToolExecutor {
  private readonly pipeline: ToolExecutionPipeline

  /** @param options - the scope, programs, record prefix, output cap and harness-tool concurrency. */
  constructor(private readonly options: SeatToolExecutorOptions) {
    this.pipeline = new ToolExecutionPipeline(options.ctx)
  }

  /**
   * Hear each call record as it is written, before the program's result is awaited.
   * @param listener - called with the seat Session and the program's call id.
   * @returns the disposer.
   */
  onCallRecorded(listener: CallRecordedListener): () => void {
    return this.options.programs.records.onCallRecorded(listener)
  }

  /**
   * Wait until a program call's record is written.
   * @param sessionId - the seat child's Session.
   * @param callId - the program's id for the call.
   * @param signal - rejects the wait when it aborts.
   * @returns once the `tool/call` record is in the log.
   */
  recorded(sessionId: SessionId, callId: string, signal?: AbortSignal): Promise<void> {
    return this.options.programs.records.recorded(sessionId, callId, signal)
  }

  /**
   * Describe the harness tools the seat scope shows. Record names are never offered to anything.
   * @param tools - the definitions visible in the seat scope after its restrictions.
   * @returns their model schemas.
   */
  describe(tools: readonly ToolDefinition[]): ToolModelInput {
    return { schemas: tools.map(definition => projectToolSchema(definition, false)) }
  }

  /**
   * Settle one program message's tool calls in message order.
   * @param input - the calls, signal, seat child Agent and logging step.
   * @returns the settled results and context from harness tools.
   * @throws ToolBatchExecutionError when a record cannot be settled or a harness batch fails, with what was committed.
   */
  async execute(input: ToolBatchInput): Promise<ToolBatchResult> {
    const { agent } = input
    if (agent === undefined) throw new Error('seat executor: tool records need the seat Agent')
    const results: ToolCallResult[] = []
    const additionalContexts: UserMessage[] = []
    let concluded = false
    const partial = (): ToolBatchResult => ({ results, additionalContexts, concluded })
    for (const segment of this.segments(input.calls)) {
      try {
        const settled = segment.kind === 'record'
          ? await this.settleRecords(input, agent, segment.calls)
          : await executeToolBatch({ ...input, calls: segment.calls }, this.pipeline, () => this.options.maxParallel)
        results.push(...settled.results)
        additionalContexts.push(...settled.additionalContexts)
        concluded ||= settled.concluded
      } catch (error: unknown) {
        if (error instanceof ToolBatchExecutionError) {
          results.push(...error.partial.results)
          additionalContexts.push(...error.partial.additionalContexts)
          throw new ToolBatchExecutionError(error.cause, partial())
        }
        throw new ToolBatchExecutionError(error, partial())
      }
    }
    return partial()
  }

  private segments(calls: readonly ToolCallBlock[]): Segment[] {
    const segments: Segment[] = []
    for (const call of calls) {
      const kind = call.name.startsWith(this.options.recordPrefix) ? 'record' : 'harness'
      const last = segments.at(-1)
      if (last?.kind === kind) last.calls.push(call)
      else segments.push({ kind, calls: [call] })
    }
    return segments
  }

  /**
   * Log every call of a record segment first, since the program has started them all, then settle them in message
   * order. A question about a later call can then be asked while an earlier one still runs.
   */
  private async settleRecords(input: ToolBatchInput, agent: Agent, calls: readonly ToolCallBlock[]): Promise<ToolBatchResult> {
    const sessionId = agent.id
    const program = this.options.programs.program(sessionId)
    if (program === undefined) throw new SeatProgramMissingError(sessionId)
    const seqs = calls.map((call) => {
      const seq = this.logCall(input, agent, call)
      this.options.programs.records.mark(sessionId, call.id)
      return seq
    })
    const results: ToolCallResult[] = []
    let stopRequested = false
    let lost: unknown
    for (const [index, call] of calls.entries()) {
      let result: ToolExecutionResult
      if (lost !== undefined) {
        result = programLost()
      } else if (input.signal.aborted) {
        stopRequested = await this.stopOnce(program, stopRequested)
        result = stopped()
      } else {
        try {
          result = await this.fromProgram(agent, call, await program.result(call.id, input.signal))
        } catch (error: unknown) {
          if (input.signal.aborted) {
            stopRequested = await this.stopOnce(program, stopRequested)
            result = stopped()
          } else {
            lost = error
            this.options.ctx.logger.warn(`seat executor: the program of ${sessionId} failed while awaiting ${call.id}: ${String(error)}`)
            result = programLost()
          }
        }
      }
      this.logResult(input, agent, call, result, seqs[index])
      results.push({ callId: call.id, result })
    }
    return { results, additionalContexts: [], concluded: false }
  }

  private async stopOnce(program: SeatProgram, requested: boolean): Promise<boolean> {
    if (requested) return true
    try {
      await program.stop()
    } catch (error: unknown) {
      // Stop is best effort here: the records close as stopped and the adapter's own interrupt reports a dead program.
      this.options.ctx.logger.warn(`seat executor: interrupting the program failed: ${String(error)}`)
    }
    return true
  }

  private async fromProgram(agent: Agent, call: ToolCallBlock, reported: { readonly output: string; readonly isError: boolean }): Promise<ToolExecutionResult> {
    const text = await this.inline(agent, call, reported.output)
    const content = [{ type: 'text' as const, text }]
    return reported.isError
      ? { isError: true, content, error: { message: text } }
      : { isError: false, value: text, content }
  }

  /** Keep the ends of a large output inline and save the full text through the spill store. */
  private async inline(agent: Agent, call: ToolCallBlock, output: string): Promise<string> {
    const cut = cutOutput(output, this.options.outputCap)
    if (cut === undefined) return output
    const notice = await this.spillNotice(agent, call, output, cut.omittedBytes)
    return `${cut.head}${GAP}${cut.tail}\n\n${notice}`
  }

  private async spillNotice(agent: Agent, call: ToolCallBlock, output: string, omittedBytes: number): Promise<string> {
    const omitted = { kind: 'exact', count: omittedBytes } as const
    const store = this.options.ctx.get('spillStore')
    if (store === undefined) {
      this.options.ctx.logger.warn(`seat executor: no spill store is loaded; ${call.name} keeps only the ends of its output`)
      return `(${omittedBytes} bytes omitted. The full text could not be saved.)`
    }
    try {
      const ref = await store.saveText({
        owner: { sessionId: agent.session.header.id },
        source: { kind: 'tool', toolName: call.name, callId: ToolCallId(call.id), label: 'result' },
        suggestedName: `${call.name}.txt`,
        content: output,
      })
      return formatSpillNotice(omitted, ref)
    } catch (error: unknown) {
      this.options.ctx.logger.warn(`seat executor: saving the full output of ${call.name} failed: ${String(error)}`)
      return `(${omittedBytes} bytes omitted. The full text could not be saved.)`
    }
  }

  private logCall(input: ToolBatchInput, agent: Agent, call: ToolCallBlock): SessionSeq | undefined {
    if (input.log === undefined) return undefined
    const { turn, step } = input.log
    return agent.session.append('tool/call', {
      turn, step, callId: call.id, name: call.name, arguments: call.arguments,
    }).seq
  }

  private logResult(
    input: ToolBatchInput, agent: Agent, call: ToolCallBlock, result: ToolExecutionResult, callSeq: SessionSeq | undefined,
  ): void {
    if (input.log === undefined || callSeq === undefined) return
    const { turn, step } = input.log
    agent.session.append('tool/result', {
      turn, step,
      message: createToolResultMessage({ callId: call.id, content: result.content, isError: result.isError }),
      ...result.error?.info ? { error: result.error.info } : {},
    }, { surfaceOp: 'append', sourceEventSeqs: [callSeq] })
  }
}

function stopped(): ToolExecutionResult {
  const message = 'The agent was stopped before this tool finished.'
  return {
    content: [{ type: 'text', text: `Error: ${message}` }],
    isError: true,
    error: { message, info: { name: 'AbortError', code: RECORD_STOPPED } },
  }
}

function programLost(): ToolExecutionResult {
  const message = 'The agent\'s program ended before it reported this tool\'s result.'
  return {
    content: [{ type: 'text', text: `Error: ${message}` }],
    isError: true,
    error: { message, info: { name: 'Error', code: RECORD_PROGRAM_LOST } },
  }
}
