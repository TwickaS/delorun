/**
 * Review probe child (not part of the package): runs one store operation named in argv and prints the outcome.
 *
 * - `switch <home> <from> <to>`: `switchTo(from, to)`, printing the pointer state or the error's code.
 * - `lockhold <home> <ms>`: takes `store.lock` and holds it for <ms> while announcing `locked`.
 */
import { brandString } from '@deepseek-ai/dsh-brand'
import type { RuntimeVersion } from '@delorun/contract-home-layout'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { withStoreLock } from '../../src/lock.ts'
import { StorePaths } from '../../src/paths.ts'
import { RuntimeStore } from '../../src/store.ts'
import { PLATFORM, RecordingLogger } from '../support.ts'

const [mode = '', home = '', a = '', b = ''] = process.argv.slice(2)
const runtime = (text: string): RuntimeVersion => brandString<RuntimeVersion>(text)

if (mode === 'switch') {
  const store = new RuntimeStore({ home, platform: PLATFORM, logger: new RecordingLogger() })
  try {
    await store.switchTo(runtime(a), runtime(b))
    const pointers = await store.pointers()
    process.stdout.write(`switched ${JSON.stringify(pointers)}\n`)
  } catch (error) {
    process.stdout.write(`refused ${(error as { code?: string }).code ?? String(error)}\n`)
  }
} else if (mode === 'lockhold') {
  const paths = new StorePaths(home, PLATFORM)
  await withStoreLock(paths.lock, 1_000, async () => {
    // the marker file, not stdout, tells the parent the lock is held: a pipe can deliver the line late
    writeFileSync(join(home, 'lock-held.marker'), String(process.pid), { mode: 0o600 })
    await new Promise(resolve => setTimeout(resolve, Number(a)))
  })
  process.stdout.write('released\n')
} else {
  throw new Error(`unknown mode ${mode}`)
}
