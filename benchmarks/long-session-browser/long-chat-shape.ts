/** Synthetic long-chat fixture shaped like the owner's largest real Session. */
import { createAssistantMessage, createSystemMessage, createUserMessage, createToolResultMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { AssistantStreamAccumulator } from '@deepseek-ai/dsh-llm/assistant-stream'
import { Session, SessionId, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-title'

/** Target logical events, matching the owner's 6,306-event largest Session. */
export const TARGET_EVENTS = 6306
/** Session identity used by the fixture. */
export const SESSION_ID = 'perf-long-chat'

const TITLE = 'PERF_LONG_CHAT'
const VOCABULARY_WORDS = 8_192
const POOL_WORDS = 400_000

function vocabularyWord(rank: number): string {
  let value = rank + VOCABULARY_WORDS
  let word = ''
  const letters = 'etaoinsrhdlucmfywgpbvkxqjz'
  while (value > 0) {
    word += letters[value % letters.length]
    value = Math.floor(value / letters.length)
  }
  return word
}

/** Mulberry32: a small deterministic generator for fixture construction only. */
function random(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6D2B79F5) >>> 0
    let value = state
    value = Math.imul(value ^ (value >>> 15), value | 1)
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296
  }
}

/** Zipf-distributed prose, so the fixture compresses like real conversation. */
class TextPool {
  private readonly text: string

  constructor() {
    const next = random(1)
    const cumulative: number[] = []
    let total = 0
    for (let rank = 1; rank <= VOCABULARY_WORDS; rank++) {
      total += 1 / rank
      cumulative.push(total)
    }
    const words = Array.from({ length: VOCABULARY_WORDS }, (_, rank) => vocabularyWord(rank))
    const parts: string[] = []
    for (let index = 0; index < POOL_WORDS; index++) {
      const target = next() * total
      let low = 0
      let high = cumulative.length - 1
      while (low < high) {
        const middle = (low + high) >>> 1
        if ((cumulative[middle] as number) < target) low = middle + 1
        else high = middle
      }
      parts.push(words[low] as string, index % 13 === 12 ? '.\n' : ' ')
    }
    this.text = parts.join('')
  }

  slice(next: () => number, length: number): string {
    if (length <= 0) return ''
    const span = Math.min(length, this.text.length)
    const start = Math.floor(next() * (this.text.length - span))
    return this.text.slice(start, start + span)
  }
}

/** Build the fixture as per-turn append batches, as a real Session writes them.
 * @returns the header line, one batch per turn, and the logical event count.
 */
export function longChatBatches(): { readonly header: string; readonly batches: readonly (readonly unknown[])[]; readonly events: number } {
  const pool = new TextPool()
  const next = random(7)
  const session = Session.create(SessionId(SESSION_ID))
  const batches: unknown[][] = []
  let turn = 0
  while (session.seq < TARGET_EVENTS) {
    turn++
    const before = session.seq
    session.append('turn/start', { turn })
    session.append('step/start', { turn, step: 1 })
    if (turn === 1) session.append('system/message', { turn, step: 1, message: createSystemMessage('') }, { surfaceOp: 'append' })
    const user = session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: pool.slice(next, 760) }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    if (turn === 1) session.append('session/title', { title: TITLE, messageSeqs: [user.seq], source: { kind: 'fallback' } })
    const callId = ToolCallId('perf-tool-' + String(turn))
    const tool = turn % 4 === 0
    const code = turn % 9 === 0
      ? '\n\n```ts\n' + Array.from({ length: 40 }, (_, i) => 'const value' + String(i) + ' = ' + String(i)).join('\n') + '\n```'
      : ''
    const reasoning = pool.slice(next, 1_180)
    const text = pool.slice(next, 1_350) + code
    const args = '{"path":"src/example.ts"}'
    const stream = new AssistantStreamAccumulator()
    let time = 1700000000000 + turn * 10000
    const push = (chunk: StreamChunk): void => { stream.push({ time: time++, chunk }) }
    for (const [index, block] of [{ type: 'reasoning' as const, text: reasoning }, { type: 'text' as const, text }].entries()) {
      push({ type: 'block-start', index, blockType: block.type })
      for (let offset = 0; offset < block.text.length; offset += 12) {
        push({ type: block.type === 'reasoning' ? 'reasoning-delta' : 'text-delta', index, text: block.text.slice(offset, offset + 12) })
      }
      push({ type: 'block-end', index, block })
    }
    if (tool) {
      push({ type: 'block-start', index: 2, blockType: 'tool-call' })
      for (let offset = 0; offset < args.length; offset += 8) {
        push({ type: 'tool-call-delta', index: 2, id: callId, ...offset === 0 ? { name: 'synthetic_tool' } : {}, argumentsDelta: args.slice(offset, offset + 8) })
      }
      push({ type: 'block-end', index: 2, block: { type: 'tool-call', id: callId, name: 'synthetic_tool', arguments: args } })
    }
    push({ type: 'usage', usage: { inputTokens: 4000, outputTokens: 800 } })
    push({ type: 'finish', reason: { kind: tool ? 'tool-calls' : 'stop' } })
    session.append('assistant/message', {
      turn, step: 1, stream: [...stream.snapshot()],
      message: createAssistantMessage({
        source: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
        content: [
          { type: 'reasoning', text: reasoning },
          { type: 'text', text },
          ...tool ? [{ type: 'tool-call' as const, id: callId, name: 'synthetic_tool', arguments: args }] : [],
        ],
      }),
      usage: { inputTokens: 4000, outputTokens: 800 },
    }, { surfaceOp: 'append' })
    if (tool) {
      const call = session.append('tool/call', { turn, step: 1, callId, name: 'synthetic_tool', arguments: args })
      session.append('tool/result', { turn, step: 1, message: createToolResultMessage({
        callId, isError: false, content: [{ type: 'text', text: pool.slice(next, 1_010) }],
      }) }, { surfaceOp: 'append', sourceEventSeqs: [call.seq] })
    }
    session.append('step/end', { turn, step: 1 })
    session.append('turn/end', { turn, reason: { kind: 'completed' } })
    batches.push(session.snapshotEvents().slice(before))
  }
  const header = JSON.stringify({ type: 'session', version: SESSION_FORMAT_VERSION, id: '{{sessionId}}', createdAt: 1700000000000, cwd: '{{cwd}}', isSeeded: false, delegationDepth: 0 })
  return { header, batches, events: session.seq }
}
