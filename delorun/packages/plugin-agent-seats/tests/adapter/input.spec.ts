/**
 * Specs of what the program receives: only text a person or another agent wrote to it, exactly as written (owner
 * decision, 2026-11-17: Delorun adds no text to the program's conversation).
 */
import { createAgentMessage, withResultDeliveryGuidance } from '@deepseek-ai/dsh-subagent/src/continuation-messages.ts'
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
