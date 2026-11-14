/**
 * The last-resort handler of a Delorun command-line program: an uncaught exception or an unhandled rejection prints as a
 * redacted refusal with the record's pointer, never a stack, and the process exits 1, once per process.
 */
import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import { claimFatalHandler, FATAL_EXIT, installLastResort, refusalDescriber, renderFatal, UNRECORDED_POINTER, type FatalEvent, type FatalRecord, type LastResortOptions } from '../src/index.ts'

const SECRET = ['sk', '0123456789abcdef0123456789abcdef'].join('-')
const MARK = { text: (text: string): string => text.replaceAll(SECRET, '[redacted:provider-key]') }

class KnownFailure extends Error {}
const known = refusalDescriber(KnownFailure, error => ({ lead: 'Delorun stopped a known failure.', reason: error.message, remedies: ['Do this.'] }))

/**
 * A handler installed on an emitter of its own, with what it wrote, recorded and exited with.
 * @param record - the program's record.
 * @returns the emitter, the output, the records, the exits and the uninstaller.
 */
function installed(record: LastResortOptions['record'] = () => ({ pointer: 'See the log.' })) {
  const emitter = new EventEmitter()
  const output: string[] = []
  const records: Array<readonly [unknown, FatalEvent]> = []
  const exits: number[] = []
  const uninstall = installLastResort({
    process: emitter,
    stderr: text => { output.push(text) },
    exit: code => { exits.push(code) },
    describers: [known],
    context: { profile: 'work' },
    redactor: MARK,
    record: (error, event) => {
      records.push([error, event])
      return record(error, event)
    },
  })
  return { emitter, output, records, exits, uninstall }
}

describe('the last-resort handler', () => {
  it('prints an uncaught exception no describer knows as a redacted refusal with the pointer, without its stack, and exits 1', () => {
    const { emitter, output, records, exits } = installed()
    const error = new TypeError(`the key ${SECRET} is not a function`)
    emitter.emit('uncaughtException', error)
    expect(output.join('')).toBe('Delorun stopped: the key [redacted:provider-key] is not a function\nWhat you can do:\n  See the log.\n')
    expect(output.join('')).not.toContain('    at ')
    expect(records).toEqual([[error, 'uncaughtException']])
    expect(exits).toEqual([FATAL_EXIT])
    expect(FATAL_EXIT).toBe(1)
  })

  it('describes a rejection through the program\'s describers and redacts the described text', () => {
    const { emitter, output, records, exits } = installed()
    const error = new KnownFailure(`the key ${SECRET} was refused`)
    emitter.emit('unhandledRejection', error)
    expect(output.join('')).toBe('Delorun stopped a known failure.\nWhy: the key [redacted:provider-key] was refused\nWhat you can do:\n  Do this.\n  See the log.\n')
    expect(records).toEqual([[error, 'unhandledRejection']])
    expect(exits).toEqual([1])
  })

  it('redacts with the record\'s redactor when the log that took the detail names one', () => {
    const logRedactor = { text: (text: string): string => text.replaceAll('start-token-value', '[redacted:start-token]') }
    const { emitter, output } = installed((): FatalRecord => ({ pointer: 'See the home log.', redactor: logRedactor }))
    emitter.emit('uncaughtException', new Error('token start-token-value leaked'))
    expect(output.join('')).toBe('Delorun stopped: token [redacted:start-token] leaked\nWhat you can do:\n  See the home log.\n')
  })

  it('still prints and exits 1 when recording the detail throws, and says the detail is lost', () => {
    const { emitter, output, exits } = installed(() => { throw new Error('the log is gone') })
    emitter.emit('uncaughtException', new Error('boom'))
    expect(output.join('')).toBe(`Delorun stopped: boom\nWhat you can do:\n  ${UNRECORDED_POINTER}\n`)
    expect(exits).toEqual([1])
  })

  it('exits 1 when standard error cannot take the report', () => {
    const emitter = new EventEmitter()
    const exits: number[] = []
    installLastResort({ process: emitter, stderr: () => { throw new Error('EPIPE') }, exit: code => { exits.push(code) }, describers: [], context: {}, redactor: MARK, record: () => ({ pointer: 'p' }) })
    expect(() => emitter.emit('uncaughtException', new Error('boom'))).toThrow('EPIPE')
    expect(exits).toEqual([1])
  })

  it('installs once per process, and the uninstaller removes both listeners and the claim', () => {
    const { emitter, uninstall } = installed()
    expect(emitter.listenerCount('uncaughtException')).toBe(1)
    expect(emitter.listenerCount('unhandledRejection')).toBe(1)
    expect(() => installLastResort({ process: emitter, stderr: () => {}, exit: () => {}, describers: [], context: {}, redactor: MARK, record: () => ({ pointer: 'p' }) })).toThrow('already installed')
    expect(() => claimFatalHandler(emitter)).toThrow('already installed')
    uninstall()
    expect(emitter.listenerCount('uncaughtException')).toBe(0)
    expect(emitter.listenerCount('unhandledRejection')).toBe(0)
    claimFatalHandler(emitter)()
  })

  it('renders a fatal report as the refusal with the pointer last', () => {
    expect(renderFatal('plain text', { pointer: 'See the log.' }, { describers: [], context: {}, redactor: MARK })).toBe('Delorun stopped: plain text\nWhat you can do:\n  See the log.\n')
  })
})
