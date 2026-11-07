/**
 * Test-only lock contender: prints `ready`, waits for a line on standard input, takes the home
 * lock of the run directory in argv[2], prints one JSON line with the outcome
 * and its start id, holds a taken lock until its standard input closes, then
 * releases it and exits.
 */
import { createInterface } from 'node:readline'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { RuntimeVersion } from '@delo/contract-home-layout'
import { acquireHomeLock, HomeLayoutError, newStartId } from '../../src/index.ts'

const runDirectory = process.argv[2] as string
const input = createInterface({ input: process.stdin })
process.stdout.write('ready\n')
await new Promise<void>((resolve) => { input.once('line', () => { resolve() }) })
try {
  const lock = await acquireHomeLock({ startId: newStartId(), runDirectory, runtime: brandString<RuntimeVersion>('0.0.0'), probe: () => Promise.resolve('answered') })
  process.stdout.write(`${JSON.stringify({ outcome: 'held', startId: lock.record.startId, pid: process.pid })}\n`)
  input.once('close', () => {
    lock.release()
    process.exit(0)
  })
} catch (error) {
  process.stdout.write(`${JSON.stringify({ outcome: error instanceof HomeLayoutError ? error.code : String(error) })}\n`)
  process.exit(0)
}
