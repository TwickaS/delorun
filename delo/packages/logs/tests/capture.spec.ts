/**
 * Captured output: one record per line, lines held across writes up to 65,536 bytes, the rest of a longer line
 * dropped and counted, PEM blocks redacted line by line, and this process's own streams captured with the keys of
 * the code that wrote them.
 */
import { CAPTURED_LINE_MAX_BYTES, RECORD_MAX_BYTES } from '@delo/contract-operational-logs'
import { SessionId } from '@deepseek-ai/dsh-session'
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it } from 'vitest'
import { captureStream, interceptStdio, LineCapture } from '../src/index.ts'
import { canary, openLog, patternCanaries, pemLine, recordsOf, tempHome, type TempHome } from './support.ts'

let temp: TempHome | undefined
afterEach(() => {
  temp?.remove()
  temp = undefined
})

function setup() {
  temp = tempHome()
  return openLog(temp.home)
}

describe('LineCapture', () => {
  it('writes one record per line, joining a line split across writes and holding a partial line until the end', () => {
    const { log, location } = setup()
    const capture = new LineCapture(log, 'stderr', 'warn')
    capture.write('first li')
    capture.write(Buffer.from('ne\r\nsecond\n\nthi'))
    capture.write('rd')
    capture.end()
    expect(recordsOf(location.file).map(record => [record.logger, record.source, record.level, record.msg])).toEqual([
      ['stderr', 'captured', 'warn', 'first line'],
      ['stderr', 'captured', 'warn', 'second'],
      ['stderr', 'captured', 'warn', ''],
      ['stderr', 'captured', 'warn', 'third'],
    ])
  })

  it('keeps a multi-byte character split across writes whole', () => {
    const { log, location } = setup()
    const capture = new LineCapture(log, 'stdout', 'info')
    const bytes = Buffer.from('café\n')
    capture.write(bytes.subarray(0, 4))
    capture.write(bytes.subarray(4))
    expect(recordsOf(location.file).map(record => record.msg)).toEqual(['café'])
  })

  it('redacts a secret split across two writes', () => {
    const { log, redactor, location } = setup()
    const value = canary('helper-key')
    redactor.register(value, 'helper-key')
    const capture = new LineCapture(log, 'stdout', 'info')
    capture.write(`key ${value.slice(0, 10)}`)
    capture.write(`${value.slice(10)} loaded\n`)
    expect(readFileSync(location.file, 'utf8')).not.toContain(value)
    expect(recordsOf(location.file)[0]?.msg).toBe('key [redacted:helper-key] loaded')
  })

  it('holds at most 65,536 bytes of a line, redacts them whole, and drops and counts the rest up to the newline', () => {
    const { log, redactor, location } = setup()
    const value = canary('model-key')
    redactor.register(value, 'model-key')
    const capture = new LineCapture(log, 'stdout', 'info')
    const head = `${value} ${'a'.repeat(100)}`
    const overflow = 'b'.repeat(70_000)
    capture.write(head)
    capture.write(`${'c'.repeat(CAPTURED_LINE_MAX_BYTES - head.length)}${overflow}`)
    capture.write(`${value}\nnext\n`)
    const [long, next] = recordsOf(location.file)
    expect(readFileSync(location.file, 'utf8')).not.toContain(value)
    expect(long?.msg.startsWith('[redacted:model-key] ')).toBe(true)
    const dropped = overflow.length + value.length
    const cut = Buffer.byteLength(redactor.text(head + 'c'.repeat(CAPTURED_LINE_MAX_BYTES - head.length))) - Buffer.byteLength(long?.msg ?? '')
    expect(long?.truncated).toBe(dropped + cut)
    expect(next?.msg).toBe('next')
    expect(Buffer.byteLength(readFileSync(location.file, 'utf8').split('\n')[0] ?? '') + 1).toBeLessThanOrEqual(RECORD_MAX_BYTES)
  })

  it('redacts every line of a PEM private key block and returns to plain lines after it', () => {
    const { log, location } = setup()
    const body = patternCanaries().pemBody
    const capture = new LineCapture(log, 'stderr', 'warn')
    capture.write(`loaded key:\n${pemLine('BEGIN')}\nProc-Type: 4,ENCRYPTED\n\n${body.join('\n')}\n${pemLine('END')}\nafter the key\n`)
    const text = readFileSync(location.file, 'utf8')
    for (const line of body) expect(text).not.toContain(line)
    expect(recordsOf(location.file).map(record => record.msg)).toEqual([
      'loaded key:',
      '[redacted:private-key]',
      '[redacted:private-key]',
      '[redacted:private-key]',
      ...body.map(() => '[redacted:private-key]'),
      '[redacted:private-key]',
      'after the key',
    ])
  })

  it('ends a PEM block at a line that cannot belong to it', () => {
    const { log, location } = setup()
    const capture = new LineCapture(log, 'stderr', 'warn')
    capture.write(`${pemLine('BEGIN')}\nabc\nthis is prose, not base64\n`)
    expect(recordsOf(location.file).map(record => record.msg)).toEqual(['[redacted:private-key]', '[redacted:private-key]', 'this is prose, not base64'])
  })
})

describe('captureStream', () => {
  it('captures a child process\'s output until it ends', async () => {
    const { log, redactor, location } = setup()
    const value = canary('repository-token')
    redactor.register(value, 'repository-token')
    const child = spawn(process.execPath, ['-e', 'process.stderr.write("using " + process.argv[1] + "\\npartial")', value], { stdio: ['ignore', 'ignore', 'pipe'] })
    captureStream(child.stderr, new LineCapture(log, 'stderr', 'warn'))
    await new Promise(resolve => child.on('close', resolve))
    expect(recordsOf(location.file).map(record => record.msg)).toEqual(['using [redacted:repository-token]', 'partial'])
  })

  it('writes the held partial line when it stops capturing', async () => {
    const { log, location } = setup()
    const readable = new PassThrough()
    const stop = captureStream(readable, new LineCapture(log, 'stdout', 'info'))
    readable.write('held')
    await new Promise(resolve => setImmediate(resolve))
    stop()
    expect(readable.listenerCount('data')).toBe(0)
    expect(recordsOf(location.file).map(record => record.msg)).toEqual(['held'])
  })
})

describe('interceptStdio', () => {
  it('captures this process\'s streams with the keys of the code that wrote them, and restores them', () => {
    const { log, location } = setup()
    const before = process.stdout.write
    const stopKeys = log.useKeys(() => ({ sessionId: SessionId('s-intercept'), turn: 3 }))
    const stop = interceptStdio(log, { stdoutLevel: 'info', stderrLevel: 'warn', passThrough: false })
    let called = false
    process.stdout.write('from stdout\n', () => { called = true })
    process.stderr.write(Buffer.from('from stderr\n'))
    process.stdout.write('held')
    stop()
    stopKeys()
    expect(process.stdout.write).toBe(before)
    expect(recordsOf(location.file).map(record => [record.logger, record.level, record.msg, record.sessionId, record.turn])).toEqual([
      ['stdout', 'info', 'from stdout', 's-intercept', 3],
      ['stderr', 'warn', 'from stderr', 's-intercept', 3],
      ['stdout', 'info', 'held', 's-intercept', 3],
    ])
    return new Promise<void>((resolve) => { queueMicrotask(() => { expect(called).toBe(true); resolve() }) })
  })
})
