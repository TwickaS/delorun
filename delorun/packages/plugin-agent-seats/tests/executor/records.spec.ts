/** The executor's records without a model: ledger order, a lost or missing program, and the call ledger. */
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { defineTool, ToolBatchExecutionError as BatchError } from '@deepseek-ai/dsh-tools'
import { describe, expect, it, vi } from 'vitest'
import { CallRecordLedger, RECORD_PROGRAM_LOST, SeatProgramMissingError } from '../../src/executor/index.ts'
import { PREFIX, setup } from './helpers.ts'

const call = (id: string, name = `${PREFIX}Bash`) => ({ type: 'tool-call' as const, id: ToolCallId(id), name, arguments: '{}' })

describe('call records', () => {
  it('announces each call record before the program result is awaited', async () => {
    const { executor, programs, seatAgent } = await setup()
    const { agent, program } = await seatAgent('announce')
    const trace: string[] = []
    executor.onCallRecorded(({ sessionId, callId }) => {
      trace.push(`recorded:${callId}:asked=${program.asked.length}:logged=${agent.session.snapshotEvents().filter(e => e.type === 'tool/call').length}`)
      expect(sessionId).toBe(agent.id)
    })
    const settled = executor.execute({ calls: [call('a'), call('b')], signal: new AbortController().signal, agent, log: { turn: 1, step: 1 } })
    await executor.recorded(agent.id, 'b')
    expect(trace).toEqual(['recorded:a:asked=0:logged=1', 'recorded:b:asked=0:logged=2'])
    await expect(programs.records.recorded(agent.id, 'a')).resolves.toBeUndefined()
    program.finish('a', 'one')
    program.finish('b', 'two')
    await settled
  })

  it('lets a waiter resume as soon as its own call is logged, while an earlier call still runs', async () => {
    const { executor, seatAgent } = await setup()
    const { agent, program } = await seatAgent('waiter')
    const waiting = executor.recorded(agent.id, 'b')
    const settled = executor.execute({ calls: [call('a'), call('b')], signal: new AbortController().signal, agent, log: { turn: 1, step: 1 } })
    await waiting
    expect(program.asked).toEqual(['a'])
    program.finish('a', 'one')
    program.finish('b', 'two')
    await settled
  })

  it('closes the remaining records when the program is lost, without waiting on them', async () => {
    const { executor, seatAgent } = await setup()
    const { agent, program } = await seatAgent('lost')
    program.lose('a', new Error('pipe closed'))
    const batch = await executor.execute({ calls: [call('a'), call('b')], signal: new AbortController().signal, agent, log: { turn: 1, step: 1 } })

    expect(program.asked).toEqual(['a'])
    expect(batch.results.map(({ result }) => result.isError)).toEqual([true, true])
    const logged = agent.session.snapshotEvents().filter(event => event.type === 'tool/result')
    expect(logged.map(event => event.data.error)).toEqual([
      expect.objectContaining({ code: RECORD_PROGRAM_LOST }), expect.objectContaining({ code: RECORD_PROGRAM_LOST }),
    ])
  })

  it('fails loud with nothing logged when the seat has no live program', async () => {
    const { executor, programs, seatAgent } = await setup()
    const { agent } = await seatAgent('missing')
    programs.live.delete(agent.id)
    const failure = await executor.execute({ calls: [call('a')], signal: new AbortController().signal, agent, log: { turn: 1, step: 1 } }).catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(BatchError)
    expect((failure as BatchError).cause).toBeInstanceOf(SeatProgramMissingError)
    expect(agent.session.snapshotEvents().filter(event => event.type === 'tool/call')).toHaveLength(0)
  })

  it('keeps what a record committed when a harness batch fails after it', async () => {
    const { executor, scope, seatAgent } = await setup()
    scope.ctx.tools.register(defineTool({
      name: 'send_note', description: 'a harness tool', parameters: {},
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      execute: async () => 'noted',
    }))
    vi.spyOn(scope.ctx.tools, 'executable').mockImplementation(() => { throw new Error('policy broke') })
    const { agent, program } = await seatAgent('harness-fails')
    program.finish('a', 'one')
    const failure = await executor.execute({
      calls: [call('a'), call('h1', 'send_note')], signal: new AbortController().signal, agent, log: { turn: 1, step: 1 },
    }).catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(BatchError)
    expect(((failure as BatchError).cause as Error).message).toBe('policy broke')
    expect((failure as BatchError).partial.results.map(({ callId }) => callId)).toEqual(['a'])
  })

  it('runs a harness tool alone under the executor\'s own concurrency limit', async () => {
    const { executor, scope, seatAgent } = await setup()
    scope.ctx.tools.register(defineTool({
      name: 'send_note', description: 'a harness tool', parameters: {},
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      execute: async () => 'noted',
    }))
    const { agent } = await seatAgent('harness-only')
    const batch = await executor.execute({ calls: [call('h1', 'send_note')], signal: new AbortController().signal, agent, log: { turn: 1, step: 1 } })

    expect(batch.results[0]?.result.content).toEqual([{ type: 'text', text: 'noted' }])
  })

  it('needs the seat Agent', async () => {
    const { executor } = await setup()
    await expect(executor.execute({ calls: [call('a')], signal: new AbortController().signal })).rejects.toThrow(/need the seat Agent/)
  })

  it('logs no records but still settles the calls when the batch has no log step', async () => {
    const { executor, seatAgent } = await setup()
    const { agent, program } = await seatAgent('unlogged')
    program.finish('a', 'out')
    const batch = await executor.execute({ calls: [call('a')], signal: new AbortController().signal, agent })

    expect(batch.results[0]?.result.isError).toBe(false)
    expect(agent.session.snapshotEvents().filter(event => event.type === 'tool/call')).toHaveLength(0)
  })

  it('reports a failing Stop and still closes the record as stopped', async () => {
    const { executor, seatAgent } = await setup()
    const { agent, program } = await seatAgent('stop-fails')
    program.failStop = true
    const abort = new AbortController()
    const settled = executor.execute({ calls: [call('a')], signal: abort.signal, agent, log: { turn: 1, step: 1 } })
    await executor.recorded(agent.id, 'a')
    abort.abort(new Error('stop'))
    const batch = await settled

    expect(program.stops).toBe(1)
    expect(batch.results[0]?.result.isError).toBe(true)
  })

  it('does not ask the program for a result once the signal is already aborted', async () => {
    const { executor, seatAgent } = await setup()
    const { agent, program } = await seatAgent('aborted-first')
    const abort = new AbortController()
    abort.abort(new Error('stop'))
    await executor.execute({ calls: [call('a')], signal: abort.signal, agent, log: { turn: 1, step: 1 } })

    expect(program.asked).toEqual([])
    expect(program.stops).toBe(1)
  })
})

describe('CallRecordLedger', () => {
  const id = SessionId('ledger')

  it('rejects a waiter whose signal aborts, and does not wake it later', async () => {
    const ledger = new CallRecordLedger()
    const abort = new AbortController()
    const waiting = ledger.recorded(id, 'a', abort.signal)
    abort.abort(new Error('withdrawn'))
    await expect(waiting).rejects.toThrow('withdrawn')
    expect(() => ledger.mark(id, 'a')).not.toThrow()
  })

  it('rejects at once for a signal that is already aborted', async () => {
    const ledger = new CallRecordLedger()
    const abort = new AbortController()
    abort.abort(new Error('early'))
    await expect(ledger.recorded(id, 'a', abort.signal)).rejects.toThrow('early')
  })

  it('wakes every waiter of a call and tells every listener even when one throws', async () => {
    const ledger = new CallRecordLedger()
    const heard: string[] = []
    ledger.onCallRecorded(() => { throw new Error('listener broke') })
    const stop = ledger.onCallRecorded(({ callId }) => heard.push(callId))
    const first = ledger.recorded(id, 'a')
    const second = ledger.recorded(id, 'a')
    expect(() => ledger.mark(id, 'a')).toThrow(AggregateError)
    await Promise.all([first, second])
    expect(heard).toEqual(['a'])
    stop()
    expect(() => ledger.mark(id, 'b')).toThrow(AggregateError)
    expect(heard).toEqual(['a'])
  })

  it('forgets a Session, so a later wait for the same call id waits again', async () => {
    const ledger = new CallRecordLedger()
    ledger.mark(id, 'a')
    ledger.forget(id)
    let woke = false
    void ledger.recorded(id, 'a').then(() => { woke = true })
    await new Promise(resolve => setTimeout(resolve, 5))
    expect(woke).toBe(false)
  })
})
