/**
 * What the chat log scan leaves on its decompressor while a large log feeds
 * in: one wait for a `drain` or `close` event at a time, so the decompressor
 * never collects listeners past the one it is waiting for, and the scan reads
 * the same header and turn state as before.
 */
import { randomBytes } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { zstdCompressSync, type ZstdDecompress } from 'node:zlib'
import { ChatLogScan } from '../src/dsh-import/chats.ts'

/** The warnings the process emits while a test runs. */
const warnings: Error[] = []
const collect = (warning: Error): void => { warnings.push(warning) }

afterEach(() => {
  process.off('warning', collect)
  warnings.length = 0
})

describe('a chat log scan', () => {
  it('keeps at most one close listener while a large log waits for drain, and reads the same result', async () => {
    const records = [
      { type: 'session', version: 4, id: 'large', createdAt: 0, isSeeded: false, delegationDepth: 0, cwd: '/work/proj' },
      { type: 'turn/start', text: randomBytes(768 * 1024).toString('base64') },
      { type: 'turn/start', text: 'open' },
    ]
    const bytes = zstdCompressSync(Buffer.from(`${records.map(record => JSON.stringify(record)).join('\n')}\n`))
    process.on('warning', collect)

    const scan = new ChatLogScan(bytes.length)
    const decoder: ZstdDecompress = Reflect.get(scan, 'decoder')
    let drains = 0
    decoder.on('drain', () => { drains += 1 })
    let mostClose = 0
    const chunk = 64 * 1024
    for (let offset = 0; offset < bytes.length; offset += chunk) {
      await scan.feed(bytes.subarray(offset, offset + chunk))
      mostClose = Math.max(mostClose, decoder.listenerCount('close'))
    }
    const result = await scan.finish()
    await new Promise(resolve => { setImmediate(resolve) })

    expect(drains).toBeGreaterThan(10)
    expect(mostClose).toBeLessThanOrEqual(1)
    expect(decoder.listenerCount('close')).toBeLessThanOrEqual(1)
    expect(warnings.filter(warning => warning.name === 'MaxListenersExceededWarning')).toEqual([])
    expect(result).toEqual({ id: 'large', cwd: '/work/proj', openTurn: true })
  }, 60_000)
})
