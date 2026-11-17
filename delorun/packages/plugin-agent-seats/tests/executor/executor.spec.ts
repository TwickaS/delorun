/**
 * The seat tool executor on the production AgentLoop: a program's own tool calls become records, written like the
 * native batch settlement writes them, that no listener, guard or spill policy sees.
 */
import { describe, expect, it } from 'vitest'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { answer, calls, idle, ofType, PREFIX, say, setup, types, until } from './helpers.ts'
import { RECORD_STOPPED } from '../../src/executor/index.ts'

describe('seat records on the production loop', () => {
  it('logs the call, awaits the program, then logs the result citing the call', async () => {
    const { ctx, model, seatAgent } = await setup()
    const { agent, program } = await seatAgent('single')
    model.script.push(calls({ id: 'c1', name: 'claude_code.Bash', input: { command: 'ls' } }), answer('Listed.'))
    const done = idle(ctx, agent)
    agent.followup(say('list the files'))
    await until(() => program.asked.includes('c1'), 'the result wait')

    expect(types(agent)).toContain('tool/call')
    expect(types(agent)).not.toContain('tool/result')
    program.finish('c1', 'a.txt\nb.txt')
    await done

    const [call] = ofType(agent, 'tool/call')
    const [result] = ofType(agent, 'tool/result')
    expect(call?.data).toMatchObject({ callId: 'c1', name: 'claude_code.Bash', arguments: '{"command":"ls"}', step: 1 })
    expect(result?.data).toMatchObject({ step: 1, message: { toolCallId: 'c1', isError: false, content: [{ type: 'text', text: 'a.txt\nb.txt' }] } })
    expect(result?.sourceEventSeqs).toEqual([call?.seq])
    expect(ofType(agent, 'assistant/message').at(-1)?.data.message.content).toEqual([{ type: 'text', text: 'Listed.' }])
  })

  it('logs every call of one program message first and commits their results in message order', async () => {
    const { ctx, model, seatAgent } = await setup()
    const { agent, program } = await seatAgent('parallel')
    model.script.push(
      calls(
        { id: 'call-a', name: 'claude_code.Read', input: { file_path: 'a.txt' } },
        { id: 'call-b', name: 'claude_code.Bash', input: { command: 'ls' } },
        { id: 'call-c', name: 'claude_code.Grep', input: { pattern: 'x' } },
      ),
      answer('Done.'),
    )
    const done = idle(ctx, agent)
    agent.followup(say('look around'))
    await until(() => ofType(agent, 'tool/call').length === 3, 'three call records')

    // Results arrive in another order than the calls; none is logged before its turn in message order.
    program.finish('call-c', 'matches', false)
    program.finish('call-b', 'a.txt', true)
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(ofType(agent, 'tool/result')).toHaveLength(0)
    program.finish('call-a', 'contents of a')
    await done

    const logged = agent.session.snapshotEvents()
      .filter(event => event.type === 'tool/call' || event.type === 'tool/result')
      .map(event => event.type === 'tool/call' ? `call:${event.data.callId}` : `result:${event.data.message.toolCallId}`)
    expect(logged).toEqual(['call:call-a', 'call:call-b', 'call:call-c', 'result:call-a', 'result:call-b', 'result:call-c'])
    const results = ofType(agent, 'tool/result')
    const callSeqs = ofType(agent, 'tool/call').map(event => event.seq)
    expect(results.map(event => event.sourceEventSeqs)).toEqual(callSeqs.map(seq => [seq]))
    expect(results.map(event => event.data.message.isError)).toEqual([false, true, false])
    expect(new Set(ofType(agent, 'tool/call').map(event => event.data.step))).toEqual(new Set([1]))
    expect(ofType(agent, 'turn/end')).toHaveLength(1)
  })

  it('shows no record to a pre-execute listener, a guard or the native tool of the same name', async () => {
    const { ctx, model, seatAgent, scope } = await setup()
    const seen: string[] = []
    ctx.on('tools/pre-execute', async (exec, next) => { seen.push(`pre-execute:${exec.name}`); return next() })
    ctx.on('tools/post-execute', async (exec, _result, next) => { seen.push(`post-execute:${exec.name}`); return next() })
    ctx.tools.guard((exec) => { seen.push(`guard:${exec.name}`); return undefined })
    // A native tool that wears a record's name must not run: the prefix routes the call to the record path.
    let ran = 0
    scope.ctx.tools.register(defineTool({
      name: 'claude_code.Bash', description: 'a native tool that must not run', parameters: {},
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      execute: async () => { ran++; return 'native' },
    }))
    const { agent, program } = await seatAgent('hidden')
    model.script.push(calls({ id: 'c1', name: 'claude_code.Bash', input: { command: 'ls' } }), answer('ok'))
    const done = idle(ctx, agent)
    agent.followup(say('go'))
    await until(() => program.asked.length === 1, 'the result wait')
    program.finish('c1', 'from the program')
    await done

    expect(ran).toBe(0)
    expect(seen).toEqual([])
    expect(ofType(agent, 'tool/result')[0]?.data.message.content).toEqual([{ type: 'text', text: 'from the program' }])
  })

  it('offers the model only harness tools, never a record name', async () => {
    const { ctx, model, seatAgent, scope } = await setup()
    scope.ctx.tools.register(defineTool({
      name: 'team_note', description: 'a harness tool', parameters: {},
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      execute: async () => 'noted',
    }))
    const { agent } = await seatAgent('describe')
    model.script.push(answer('hello'))
    const done = idle(ctx, agent)
    agent.followup(say('hi'))
    await done

    const offered = (model.requests[0]?.tools ?? []).map(tool => tool.name)
    expect(offered).toEqual(['team_note'])
    expect(offered.some(name => name.startsWith(PREFIX))).toBe(false)
  })

  it('runs a harness tool through the native pipeline with its policy, between two records', async () => {
    const { ctx, model, seatAgent, scope } = await setup()
    const policy: string[] = []
    ctx.on('tools/pre-execute', async (exec, next) => { policy.push(exec.name); return next() })
    scope.ctx.tools.register(defineTool({
      name: 'send_note', description: 'a harness tool', parameters: {},
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      execute: async () => 'noted',
    }))
    const { agent, program } = await seatAgent('mixed')
    model.script.push(
      calls(
        { id: 'r1', name: 'claude_code.Read', input: { file_path: 'a' } },
        { id: 'h1', name: 'send_note' },
        { id: 'r2', name: 'claude_code.Bash', input: { command: 'ls' } },
      ),
      answer('done'),
    )
    const done = idle(ctx, agent)
    agent.followup(say('go'))
    await until(() => program.asked.includes('r1'), 'the first record wait')
    expect(types(agent).filter(type => type === 'tool/call')).toHaveLength(1)
    program.finish('r1', 'a')
    await until(() => program.asked.includes('r2'), 'the second record wait')
    program.finish('r2', 'b')
    await done

    expect(policy).toEqual(['send_note'])
    const order = agent.session.snapshotEvents()
      .filter(event => event.type === 'tool/call' || event.type === 'tool/result')
      .map(event => event.type === 'tool/call' ? `call:${event.data.callId}` : `result:${event.data.message.toolCallId}`)
    expect(order).toEqual(['call:r1', 'result:r1', 'call:h1', 'result:h1', 'call:r2', 'result:r2'])
    expect(ofType(agent, 'tool/result')[1]?.data.message.content).toEqual([{ type: 'text', text: 'noted' }])
  })

  it('ends cleanly when Stop arrives during the wait: every record closed as stopped, the program interrupted once', async () => {
    const { ctx, model, seatAgent } = await setup()
    const { agent, program } = await seatAgent('stop')
    model.script.push(
      calls({ id: 'c1', name: 'claude_code.Bash', input: { command: 'sleep 60' } }, { id: 'c2', name: 'claude_code.Read', input: { file_path: 'a' } }),
    )
    const stopped = idle(ctx, agent)
    agent.followup(say('long job'))
    await until(() => program.asked.includes('c1'), 'the result wait')
    agent.cancel({ kind: 'user' }, { keepInbox: true })
    await stopped

    const results = ofType(agent, 'tool/result')
    expect(results.map(event => event.data.message.toolCallId)).toEqual(['c1', 'c2'])
    expect(results.map(event => event.data.message.isError)).toEqual([true, true])
    expect(results.map(event => event.data.error)).toEqual([
      expect.objectContaining({ code: RECORD_STOPPED }), expect.objectContaining({ code: RECORD_STOPPED }),
    ])
    expect(program.stops).toBe(1)
    expect(ofType(agent, 'turn/end').at(-1)?.data.reason.kind).not.toBe('completed')
  })
})
