/**
 * C20's `log-session-keys` on the production agent loop: the process-log records a turn writes, through the Cordis
 * logger and as captured output, carry upstream's session id and turn number, records outside a turn carry none,
 * and the session log of a run with the exporter attached has exactly the events and fields of the same run without
 * it.
 */
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createUserMessage, LlmAdapter, ToolCallId, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { afterEach, describe, expect, it } from 'vitest'
import { attachCordisLogs } from '../../src/cordis.ts'
import { interceptStdio } from '../../src/index.ts'
import { openLog, recordsOf, tempHome, type TempHome } from '../support.ts'

const usage = { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } } as const

function toolCall(id: string, name: string): StreamChunk[] {
  const callId = ToolCallId(id)
  return [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id: callId, name, argumentsDelta: '{}' },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id: callId, name, arguments: '{}' } },
    usage,
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}

function text(value: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: value },
    { type: 'block-end', index: 0, block: { type: 'text', text: value } },
    usage,
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

/** Streams one scripted step per request. */
class ScriptedAdapter extends LlmAdapter {
  private readonly script: StreamChunk[][]

  constructor(script: StreamChunk[][]) {
    super()
    this.script = script
  }

  override async * stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    const step = this.script.shift()
    if (step === undefined) throw new Error('the script has no step for this request')
    yield * step
  }
}

let context: Context | undefined
let temp: TempHome | undefined
afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  temp?.remove()
  temp = undefined
})

/** Run two turns of one chat, each calling a tool that logs through Cordis and writes to standard output. */
async function run(options: { readonly attach: boolean }) {
  const ctx = context = new Context()
  temp = tempHome()
  const opened = openLog(temp.home)
  await mountAgentLoopTestDependencies(ctx)
  if (options.attach) attachCordisLogs(ctx, opened.log)
  const harness = await mountAgentLoopTestHarness(ctx)
  ctx.llm.registerAdapter(['mock'], new ScriptedAdapter([toolCall('c1', 'probe'), text('done'), toolCall('c2', 'probe'), text('done again')]))
  ctx.tools.register(defineTool({
    name: 'probe',
    description: 'Log one line.',
    parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    execute: () => {
      ctx.logger('probe-tool').info('probe ran')
      process.stdout.write('probe printed\n')
      return Promise.resolve('ok')
    },
  }))
  const agent: Agent = await harness.create(SessionId('s-keys'), { provider: 'mock', model: 'mock' })
  const stopCapture = interceptStdio(opened.log, { stdoutLevel: 'info', stderrLevel: 'warn', passThrough: false })
  try {
    for (const message of ['first', 'second']) {
      agent.followup(createUserMessage({ content: [{ type: 'text', text: message }], source: { kind: 'user' } }))
      await agent.whenIdle()
    }
    ctx.logger('outside').info('between chats')
  } finally {
    stopCapture()
  }
  return { ...opened, agent }
}

/** Every key path of a value, with array positions, so two event logs compare by their fields alone. */
function fieldPaths(value: unknown, prefix = ''): string[] {
  if (typeof value !== 'object' || value === null) return [prefix]
  return Object.entries(value).flatMap(([key, item]) => fieldPaths(item, `${prefix}/${key}`))
}

describe('log-session-keys', () => {
  it('keys the records of each turn by upstream\'s session id and turn number, and leaves other records unkeyed', async () => {
    const { location, agent } = await run({ attach: true })
    const records = recordsOf(location.file)
    const probe = records.filter(record => record.msg === 'probe ran')
    expect(probe.map(record => [record.logger, record.source, record.sessionId, record.turn])).toEqual([
      ['probe-tool', 'delo', 's-keys', 1],
      ['probe-tool', 'delo', 's-keys', 2],
    ])
    const printed = records.filter(record => record.msg === 'probe printed')
    expect(printed.map(record => [record.logger, record.source, record.sessionId, record.turn])).toEqual([
      ['stdout', 'captured', 's-keys', 1],
      ['stdout', 'captured', 's-keys', 2],
    ])
    const outside = records.find(record => record.msg === 'between chats')
    expect(outside).toBeDefined()
    expect(outside).not.toHaveProperty('sessionId')
    expect(outside).not.toHaveProperty('turn')
    const turns = agent.session.ownEvents().filter(event => event.type === 'turn/start').map(event => event.data.turn)
    expect(turns).toEqual([1, 2])
  })

  it('adds no event and no field to the session log', async () => {
    const without = (await run({ attach: false })).agent.session.ownEvents()
    await context?.fiber.dispose()
    temp?.remove()
    const withLogs = (await run({ attach: true })).agent.session.ownEvents()
    expect(withLogs.map(event => event.type)).toEqual(without.map(event => event.type))
    expect(withLogs.map(event => fieldPaths(event))).toEqual(without.map(event => fieldPaths(event)))
  })
})
