/** Specs of one live seat: how the program's events reach the adapter and the executor, and how Stop settles. */
import type { ProgramEvent } from '@delorun/external-agents/contract'
import { describe, expect, it } from 'vitest'
import { SeatRun } from '../../src/adapter/run.ts'
import { ScriptedProgram } from './support.ts'

const signal = (): AbortSignal => new AbortController().signal
const text = (value: string): ProgramEvent => ({ kind: 'text', text: value })
const result = (id: string, output: string, isError = false): ProgramEvent => ({ kind: 'tool-result', id, output, isError })

describe('reading the program\'s events', () => {
  it('hands over events in order and keeps a tool result that arrives between them for its call', async () => {
    const program = new ScriptedProgram()
    const run = new SeatRun(program)
    program.emit(result('call-1', 'ls output'), text('Done.'))
    await expect(run.next(signal())).resolves.toEqual(text('Done.'))
    await expect(run.result('call-1', signal())).resolves.toEqual({ output: 'ls output', isError: false })
  })
})

describe('waiting for a recorded call\'s result', () => {
  it('returns a result that is already in, once', async () => {
    const program = new ScriptedProgram()
    const run = new SeatRun(program)
    program.emit(result('call-1', 'boom', true), text('after'))
    await run.next(signal())
    await expect(run.result('call-1', signal())).resolves.toEqual({ output: 'boom', isError: true })
    expect(run.waitSignal).toBeUndefined()
  })

  it('reads on until the result comes, and holds the other events for the adapter in order', async () => {
    const program = new ScriptedProgram()
    const run = new SeatRun(program)
    program.emit(text('thinking'), result('other', 'not mine'), result('call-1', 'mine'))
    await expect(run.result('call-1', signal())).resolves.toEqual({ output: 'mine', isError: false })
    program.emit(text('later'))
    await expect(run.next(signal())).resolves.toEqual(text('thinking'))
    await expect(run.next(signal())).resolves.toEqual(text('later'))
    await expect(run.result('other', signal())).resolves.toEqual({ output: 'not mine', isError: false })
  })

  it('settles a call as failed when the turn ended without reporting it', async () => {
    const program = new ScriptedProgram()
    const run = new SeatRun(program)
    program.emit(text('hm'), { kind: 'turn-end', outcome: 'completed' })
    await expect(run.result('call-1', signal())).resolves.toEqual({ output: 'The agent ended its turn before reporting this tool\'s result.', isError: true })
  })

  it('shows the signal of the wait while it lasts', async () => {
    const program = new ScriptedProgram()
    const run = new SeatRun(program)
    const own = signal()
    const waiting = run.result('call-1', own)
    expect(run.waitSignal).toBe(own)
    program.emit(result('call-1', 'ok'))
    await waiting
    expect(run.waitSignal).toBeUndefined()
  })
})

describe('telling when a call was recorded', () => {
  it('resolves at once for a call already recorded', async () => {
    const run = new SeatRun(new ScriptedProgram())
    run.result('call-1', signal()).catch(() => {})
    await expect(run.whenRecorded('call-1', signal())).resolves.toBeUndefined()
  })

  it('resolves when the executor starts waiting for the call\'s result', async () => {
    const program = new ScriptedProgram()
    const run = new SeatRun(program)
    let recorded = false
    const waiting = run.whenRecorded('call-1', signal()).then(() => { recorded = true })
    await Promise.resolve()
    expect(recorded).toBe(false)
    program.emit(result('call-1', 'ok'))
    await run.result('call-1', signal())
    await waiting
    expect(recorded).toBe(true)
  })

  it('stops waiting with the signal\'s reason when the turn is aborted first', async () => {
    const run = new SeatRun(new ScriptedProgram())
    const controller = new AbortController()
    const waiting = run.whenRecorded('call-1', controller.signal)
    controller.abort(new Error('stopped'))
    await expect(waiting).rejects.toThrow('stopped')
  })

  it('does not wait at all on a turn that is already aborted', async () => {
    const run = new SeatRun(new ScriptedProgram())
    const controller = new AbortController()
    controller.abort(new Error('already stopped'))
    await expect(run.whenRecorded('call-1', controller.signal)).rejects.toThrow('already stopped')
  })
})

describe('stopping the program\'s turn', () => {
  it('does nothing when no turn runs or Stop was already pressed', async () => {
    const program = new ScriptedProgram()
    const run = new SeatRun(program)
    await run.stop()
    run.turnEnded = false
    await run.stop()
    await run.stop()
    expect(program.interrupts).toBe(1)
  })

  it('drops what the program does until its turn ends, keeping nothing of it', async () => {
    const program = new ScriptedProgram()
    const run = new SeatRun(program)
    run.turnEnded = false
    program.emit(text('late'), result('call-9', 'late result'))
    await run.stop()
    await expect(run.settleStop(signal())).resolves.toEqual([text('late')])
    expect([run.interrupted, run.turnEnded]).toEqual([false, true])
  })

  it('has nothing to settle when no Stop is pending', async () => {
    await expect(new SeatRun(new ScriptedProgram()).settleStop(signal())).resolves.toEqual([])
  })

  it('records that the program was closed to stop it, so its session resumes next time', async () => {
    const program = new ScriptedProgram()
    program.interruptOutcome = 'closed'
    const run = new SeatRun(program)
    run.turnEnded = false
    await run.stop()
    expect([run.closed, run.interrupted, run.turnEnded]).toEqual([true, false, true])
  })
})
