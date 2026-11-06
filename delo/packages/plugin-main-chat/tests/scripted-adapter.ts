/**
 * A model adapter for loop tests: each request streams the next step of its
 * script, and records the tools it was offered.
 */
import { LlmAdapter, ToolCallId, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'

const usage = { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } } as const

/**
 * A step that calls one tool.
 * @param id - the call's id.
 * @param name - the tool.
 * @param args - its arguments.
 * @returns the step's chunks.
 */
export function toolCall(id: string, name: string, args: object = {}): StreamChunk[] {
  const callId = ToolCallId(id)
  const json = JSON.stringify(args)
  return [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id: callId, name, argumentsDelta: json },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id: callId, name, arguments: json } },
    usage,
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}

/**
 * A step that answers with text and ends the turn.
 * @param value - the text.
 * @returns the step's chunks.
 */
export function text(value: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: value },
    { type: 'block-end', index: 0, block: { type: 'text', text: value } },
    usage,
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

/** Streams its script one step per request. */
export class ScriptedAdapter extends LlmAdapter {
  /** The tool names each request offered, in request order. */
  readonly offered: string[][] = []
  /** Each request's messages as JSON, in request order. */
  readonly requests: string[] = []

  /** @param script - the steps, consumed in order; each test pushes its own. */
  constructor(readonly script: StreamChunk[][] = []) {
    super()
  }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.offered.push((options.tools ?? []).map(tool => tool.name))
    this.requests.push(JSON.stringify(options.messages))
    const step = this.script.shift()
    if (step === undefined) throw new Error('the script has no step for this request')
    yield * step
  }
}
