/**
 * Test-only lock contender: takes the home lock of the run directory in
 * argv[2], prints one JSON line with the outcome, holds a taken lock until its
 * standard input closes, then releases it and exits.
 */
import { brandString } from '@deepseek-ai/dsh-brand'
import type { RuntimeVersion } from '@delo/contract-home-layout'
import { acquireHomeLock, HomeLayoutError } from '../../src/home/index.ts'

const runDirectory = process.argv[2] as string
try {
  const lock = await acquireHomeLock({ runDirectory, runtime: brandString<RuntimeVersion>('0.0.0'), probe: () => Promise.resolve('answered') })
  process.stdout.write(`${JSON.stringify({ outcome: 'held', startId: lock.record.startId })}\n`)
  process.stdin.resume()
  process.stdin.on('end', () => {
    lock.release()
    process.exit(0)
  })
} catch (error) {
  process.stdout.write(`${JSON.stringify({ outcome: error instanceof HomeLayoutError ? error.code : String(error) })}\n`)
  process.exit(0)
}
