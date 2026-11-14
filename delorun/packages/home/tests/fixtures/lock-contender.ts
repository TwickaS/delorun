/**
 * Test-only lock contender: prints `ready`, waits for a line on standard input, takes the home
 * lock of the run directory in argv[2], prints one JSON line with the outcome
 * and its start id, holds a taken lock until its standard input closes, then
 * releases it and exits.
 *
 * `--probe real|answered|silent` chooses the holder probe: `answered`, the default, answers at
 * once as a live home process would; `silent` never answers; `real` asks the update channel through
 * the production `updateChannelProbe` of the home and profile the run directory belongs to, so a
 * spec can exercise the takeover against the probe the product runs.
 */
import { createInterface } from 'node:readline'
import { basename, dirname } from 'node:path'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { RuntimeVersion } from '@delorun/contract-home-layout'
import { acquireHomeLock, HomeLayoutError, newStartId, type HolderProbe } from '../../src/index.ts'
import { updateChannelProbe } from '../../../home-process/src/index.ts'

const args = process.argv.slice(2)
const runDirectory = args[0] as string
const probeFlag = args.indexOf('--probe')
const probeKind = probeFlag !== -1 ? args[probeFlag + 1] : args.find(arg => arg.startsWith('--probe='))?.slice('--probe='.length)

/** The probe the contender takes the lock with, by its `--probe` argument. */
function probeOf(): HolderProbe {
  if (probeKind === undefined || probeKind === 'answered') return () => Promise.resolve('answered')
  if (probeKind === 'silent') return () => Promise.resolve('silent')
  if (probeKind !== 'real') throw new Error(`unknown --probe kind ${probeKind}; use real, answered or silent`)
  // The run directory is `<home>/run/<profile>`: the channels the production probe reads live under it.
  return updateChannelProbe(dirname(dirname(runDirectory)), basename(runDirectory))
}

const input = createInterface({ input: process.stdin })
process.stdout.write('ready\n')
await new Promise<void>((resolve) => { input.once('line', () => { resolve() }) })
try {
  const lock = await acquireHomeLock({ startId: newStartId(), runDirectory, runtime: brandString<RuntimeVersion>('0.0.0'), probe: probeOf() })
  process.stdout.write(`${JSON.stringify({ outcome: 'held', startId: lock.record.startId, pid: process.pid })}\n`)
  input.once('close', () => {
    lock.release()
    process.exit(0)
  })
} catch (error) {
  process.stdout.write(`${JSON.stringify({ outcome: error instanceof HomeLayoutError ? error.code : String(error) })}\n`)
  process.exit(0)
}
