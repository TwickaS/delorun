/**
 * What a seat's program receives from a request: only text a person or another agent wrote to it, exactly as written.
 * Delorun adds no text to the program's conversation (owner decision, 2026-11-17), so the wrapping the subagent
 * runtime puts around the first task and around `send_message` texts is taken off before the text goes on.
 * @module @delorun/plugin-agent-seats/adapter/input
 */
import type { RequestMessage } from '@deepseek-ai/dsh-llm'

/**
 * The result-delivery guidance the subagent runtime appends, as its own text block, to the first task of a
 * parent-delivered child (`withResultDeliveryGuidance`). A spec compares it with the runtime's text.
 */
export const RESULT_DELIVERY_GUIDANCE = 'Your final answer is delivered automatically if your '
  + 'parent is still online. Include the result and relevant evidence in that answer; the parent does not '
  + 'receive your full transcript, tool output, or reasoning. If your last action is a message to your '
  + 'parent, the completion notice omits your final answer; include the result and relevant evidence in that message.'

/** A phrase of the guidance that no remaining first-task text may keep (the guidance could not be separated). */
const GUIDANCE_MARKER = 'Your final answer is delivered automatically'

/** The block the subagent runtime puts before an agent's `send_message` text (`createAgentMessage`). */
const AGENT_MESSAGE_PREFIX = /^Agent .+ sent a message: $/

/** The result of a harness tool the program called, going back to it as that tool's result. */
export interface HarnessResult {
  /** The program's id for the call. */
  readonly callId: string
  /** The tool's output text. */
  readonly output: string
  /** Whether the tool failed. */
  readonly isError: boolean
}

/** What the adapter forwards from one request. */
export type NewInput =
  /** The cursor names no message of this history: the harness changed history the program has seen (§4). */
  | { readonly kind: 'parted' }
  /** The first task still carries the result-delivery guidance after the expected block was taken off. */
  | { readonly kind: 'unseparable'; readonly text: string }
  /** Texts for the program, in history order, and harness-tool results; `lastId` is absent when nothing is new. */
  | {
    readonly kind: 'input'
    readonly texts: readonly string[]
    readonly harnessResults: readonly HarnessResult[]
    readonly lastId: string | undefined
  }

/** What {@link newInput} needs besides the history. */
export interface NewInputOptions {
  /** Id of the last message already handed to the program; absent before the first input. */
  readonly cursor: string | undefined
  /**
   * Whether a tool call is one the program made on a harness tool, so its result goes back to the program. Results
   * of the program's own recorded calls are never forwarded.
   */
  readonly isHarnessCall?: (callId: string) => boolean
}

/**
 * Pick the program's new input: after the cursor, `user` and agent messages as text, and results of harness tool
 * calls. Assistant messages, recorded tool results, system and developer messages, and runtime context are dropped;
 * the log still holds them, so the program's input is a subset of the log.
 * @param messages - the request's derived history.
 * @param options - the cursor and the harness-call test.
 * @returns the new input, or why none can be picked.
 */
export function newInput(messages: readonly RequestMessage[], options: NewInputOptions): NewInput {
  const { cursor, isHarnessCall } = options
  let start = 0
  if (cursor !== undefined) {
    const at = messages.findIndex(message => message.id === cursor)
    if (at < 0) return { kind: 'parted' }
    start = at + 1
  }
  const texts: string[] = []
  const harnessResults: HarnessResult[] = []
  let lastId: string | undefined
  for (const message of messages.slice(start)) {
    if (message.id === undefined || message.source === undefined) continue
    if (message.role === 'tool') {
      if (isHarnessCall?.(message.toolCallId) !== true) continue
      harnessResults.push({
        callId: message.toolCallId,
        output: message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n'),
        isError: message.isError === true,
      })
      lastId = message.id
      continue
    }
    if (message.role !== 'user') continue
    const kind = message.source.kind
    if (kind !== 'user' && kind !== 'agent-message') continue
    let blocks = message.content
    if (kind === 'agent-message') {
      const first = blocks[0]
      if (first?.type === 'text' && AGENT_MESSAGE_PREFIX.test(first.text)) blocks = blocks.slice(1)
    } else if (cursor === undefined && texts.length === 0) {
      const last = blocks.at(-1)
      if (last?.type === 'text' && last.text === RESULT_DELIVERY_GUIDANCE) blocks = blocks.slice(0, -1)
    }
    const text = blocks.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
    if (cursor === undefined && texts.length === 0 && text.includes(GUIDANCE_MARKER)) return { kind: 'unseparable', text }
    if (text.length === 0) continue
    texts.push(text)
    lastId = message.id
  }
  return { kind: 'input', texts, harnessResults, lastId }
}
