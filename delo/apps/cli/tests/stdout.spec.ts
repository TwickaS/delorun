import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import { endQuietlyWhenStdoutCloses } from '../src/stdout.ts'

/** A standard output stand-in that emits errors on demand. */
function stream(): EventEmitter {
  return new EventEmitter()
}

describe('a closed standard output', () => {
  it('ends the process with 0 when its reader has closed', () => {
    const out = stream()
    const codes: number[] = []
    endQuietlyWhenStdoutCloses(out, code => codes.push(code))
    out.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }))
    expect(codes).toEqual([0])
  })

  it('rethrows any other stream error, so the last-resort report shows it', () => {
    const out = stream()
    const codes: number[] = []
    endQuietlyWhenStdoutCloses(out, code => codes.push(code))
    const failure = Object.assign(new Error('write ENOSPC'), { code: 'ENOSPC' })
    expect(() => out.emit('error', failure)).toThrow(failure)
    expect(codes).toEqual([])
  })
})
