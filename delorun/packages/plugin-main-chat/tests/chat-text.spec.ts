/**
 * Another chat's conversation as `chat_read` text: one line per message,
 * tool call and notice, and the newest lines within a byte budget.
 */
import { createAssistantMessage, createUserMessage, ToolCallId, type ContextFormed } from '@deepseek-ai/dsh-llm'
import { SessionSeq, type SurfaceEvent } from '@deepseek-ai/dsh-session'
import { describe, expect, it } from 'vitest'
import { chatLines, newestWithin } from '../src/chat-text.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'main-chat-test': { kind: 'main-chat-test' } & ContextFormed
  }
}

const user = (seq: number, text: string, source: Parameters<typeof createUserMessage>[0]['source'] = { kind: 'user' }): SurfaceEvent => ({
  type: 'user/message', seq: SessionSeq(seq), time: 0, surfaceOp: 'append',
  data: createUserMessage({ content: [{ type: 'text', text }], source }),
})

const assistant = (seq: number, content: Parameters<typeof createAssistantMessage>[0]['content']): SurfaceEvent => ({
  type: 'assistant/message', seq: SessionSeq(seq), time: 0, surfaceOp: 'append',
  data: { turn: 1, step: 1, message: createAssistantMessage({ content, source: { provider: 'mock', model: 'mock' } }), stream: [] },
})

describe('chatLines', () => {
  it('writes the person\'s messages, the agent\'s replies, its tool calls and notices, and leaves out the harness\'s own messages', () => {
    expect(chatLines([
      user(0, 'Fix the footer.'),
      user(1, 'The job finished.', { kind: 'main-chat-test', form: 'notice', summary: 'The tests passed' }),
      user(2, 'Context the harness added.', { kind: 'main-chat-test' }),
      assistant(3, [{ type: 'text', text: 'Looking. ' }, { type: 'tool-call', id: ToolCallId('call-1'), name: 'read', arguments: '{}' }]),
      assistant(4, [{ type: 'tool-call', id: ToolCallId('call-2'), name: 'edit', arguments: '{}' }]),
      assistant(5, [{ type: 'text', text: 'Fixed.' }]),
    ])).toEqual([
      'Person: Fix the footer.',
      'Notice: The tests passed',
      'Agent: Looking.',
      'Agent called read',
      'Agent called edit',
      'Agent: Fixed.',
    ])
  })
})

describe('newestWithin', () => {
  const lines = ['Person: one', 'Agent: two', 'Person: three']

  it('keeps every line that fits', () => {
    expect(newestWithin(lines, 1_000)).toBe('Person: one\nAgent: two\nPerson: three')
    expect(newestWithin([], 10)).toBe('')
  })

  it('keeps the newest lines within the budget after a count of the ones left out', () => {
    const long = [`Person: ${'a'.repeat(30)}`, `Agent: ${'b'.repeat(30)}`, `Person: ${'c'.repeat(30)}`]
    expect(newestWithin(long, 110)).toBe(`(1 earlier message left out)\n${long[1]!}\n${long[2]!}`)
    expect(new TextEncoder().encode(newestWithin(long, 110)).length).toBeLessThanOrEqual(110)
    expect(newestWithin(long, 100)).toBe(`(2 earlier messages left out)\n${long[2]!}`)
  })

  it('cuts a newest line larger than the budget on its own, by characters, ending with ...', () => {
    expect(newestWithin(['Person: one', `Agent: ${'é'.repeat(40)}`], 50)).toBe(`(1 earlier message left out)\nAgent: ${'é'.repeat(5)}...`)
    expect(newestWithin([`Agent: ${'x'.repeat(40)}`], 20)).toBe(`Agent: ${'x'.repeat(10)}...`)
  })
})
