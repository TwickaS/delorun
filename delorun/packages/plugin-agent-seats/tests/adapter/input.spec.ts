/**
 * Specs of what the program receives: only text a person or another agent wrote to it, exactly as written (owner
 * decision, 2026-11-17: Delorun adds no text to the program's conversation).
 */
import { createAgentMessage, withResultDeliveryGuidance } from '@deepseek-ai/dsh-subagent/src/continuation-messages.ts'
import { MessageId, ToolCallId, type Message, type RequestMessage } from '@deepseek-ai/dsh-llm'
import { describe, expect, it } from 'vitest'
import { newInput, RESULT_DELIVERY_GUIDANCE } from '../../src/adapter/input.ts'
import { agentMessage, developer, system, toolResult, user, userBlocks } from './support.ts'

describe('the result-delivery guidance the subagent runtime appends', () => {
  it('equals the text this package takes off', () => {
    const [, guidance] = withResultDeliveryGuidance([{ type: 'text', text: 'task' }])
    expect(guidance).toEqual({ type: 'text', text: RESULT_DELIVERY_GUIDANCE })
  })

  it('is taken off as the one block it is appended as', () => {
    const task = userBlocks('Fix the build.', RESULT_DELIVERY_GUIDANCE)
    expect(newInput([system(), task], { cursor: undefined })).toMatchObject({ kind: 'input', texts: ['Fix the build.'] })
  })
})

describe('the prefix the subagent runtime puts before a send_message text', () => {
  it('is taken off', () => {
    const real = createAgentMessage({ id: 'root' } as never, 'lead', [{ type: 'text', text: 'Use the staging folder.' }])
    expect(real.content[0]).toEqual({ type: 'text', text: 'Agent lead sent a message: ' })
    const input = newInput([agentMessage('lead', 'Use the staging folder.')], { cursor: undefined })
    expect(input).toMatchObject({ kind: 'input', texts: ['Use the staging folder.'] })
  })
})

describe('the new-input cursor', () => {
  it('forwards only user and agent messages after the cursor, in order', () => {
    const first = user('first')
    const dropped = [system(), developer(), user('runtime context', 'system-prompt'), toolResult('call-1', 'program output')]
    const second = user('second')
    const third = agentMessage('lead', 'third')
    const input = newInput([first, ...dropped, second, third], { cursor: first.id })
    expect(input).toEqual({ kind: 'input', texts: ['second', 'third'], harnessResults: [], lastId: third.id })
  })

  it('reports nothing new when only dropped messages follow the cursor', () => {
    const first = user('first')
    const input = newInput([first, developer(), toolResult('call-1', 'out')], { cursor: first.id })
    expect(input).toEqual({ kind: 'input', texts: [], harnessResults: [], lastId: undefined })
  })

  it('reports a history that no longer holds the cursor as parted, forwarding nothing', () => {
    expect(newInput([user('a'), user('b')], { cursor: 'gone' })).toEqual({ kind: 'parted' })
  })

  it('forwards the result of a harness tool call but never a recorded call\'s result', () => {
    const first = user('first')
    const harness = toolResult('harness-1', 'the answer')
    const input = newInput([first, toolResult('claude_code.Bash-1', 'ls output'), harness], {
      cursor: first.id, isHarnessCall: callId => callId === 'harness-1',
    })
    expect(input).toEqual({ kind: 'input', texts: [], harnessResults: [{ callId: 'harness-1', output: 'the answer', isError: false }], lastId: harness.id })
  })

  it('keeps the guidance off only the first task, never a later message', () => {
    const first = user('first')
    const later = userBlocks('Please also read this.', RESULT_DELIVERY_GUIDANCE)
    expect(newInput([first, later], { cursor: first.id })).toMatchObject({ texts: ['Please also read this.\n' + RESULT_DELIVERY_GUIDANCE] })
  })

  it('refuses a first task whose guidance is not a block of its own', () => {
    const task = user(`Fix the build. ${RESULT_DELIVERY_GUIDANCE}`)
    expect(newInput([task], { cursor: undefined })).toMatchObject({ kind: 'unseparable' })
  })
})

describe('what the program never receives', () => {
  const note = { type: 'reasoning', text: 'not for the program' } as const

  it('skips a message the log has not numbered or attributed', () => {
    const unnumbered: RequestMessage = { role: 'user', content: [{ type: 'text', text: 'draft' }] }
    const kept = user('real')
    expect(newInput([unnumbered, kept], { cursor: undefined })).toEqual({ kind: 'input', texts: ['real'], harnessResults: [], lastId: kept.id })
  })

  it('sends a harness tool\'s text and failure, and leaves out anything that is not text', () => {
    const result: Message = {
      role: 'tool', id: MessageId('tool-result'), toolCallId: ToolCallId('harness-1'), source: { kind: 'tool', callId: ToolCallId('harness-1') }, isError: true,
      content: [{ type: 'text', text: 'It failed.' }, note],
    }
    expect(newInput([result], { cursor: undefined, isHarnessCall: () => true })).toEqual({
      kind: 'input', texts: [], harnessResults: [{ callId: 'harness-1', output: 'It failed.', isError: true }], lastId: result.id,
    })
  })

  it('sends another agent\'s message whole when it carries no sender line', () => {
    const bare: Message = { ...agentMessage('lead', 'ignored'), content: [note, { type: 'text', text: 'Use staging.' }] }
    expect(newInput([bare], { cursor: undefined })).toMatchObject({ kind: 'input', texts: ['Use staging.'] })
  })

  it('sends nothing for a message that holds no text, and does not move the cursor to it', () => {
    const first = user('first')
    const silent: Message = { ...user('x'), content: [note] }
    expect(newInput([first, silent], { cursor: first.id })).toEqual({ kind: 'input', texts: [], harnessResults: [], lastId: undefined })
  })

  it('reads a first task whose guidance is not its last block as the task', () => {
    const task: Message = { ...user('x'), content: [{ type: 'text', text: 'Fix the build.' }, note] }
    expect(newInput([task], { cursor: undefined })).toMatchObject({ kind: 'input', texts: ['Fix the build.'] })
  })

  it('ignores the guidance in a second message of the first batch', () => {
    const first = user('Fix the build.')
    const second = userBlocks('Also this.', RESULT_DELIVERY_GUIDANCE)
    expect(newInput([first, second], { cursor: undefined })).toMatchObject({ texts: ['Fix the build.', 'Also this.\n' + RESULT_DELIVERY_GUIDANCE] })
  })
})
