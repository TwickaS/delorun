/**
 * Test-only process that switches the store's pointers and is killed mid-switch.
 *
 * - `step <home> <pointer> <step> <from> <to>`: switch `from` to `to` under `store.lock` and end itself with
 *   `SIGKILL` just before the named durable step of the named pointer's write, or never when the pointer is `none`.
 * - `loop <home> <a> <b>`: switch between `a` and `b` through `RuntimeStore.switchTo` until the parent kills it;
 *   `ready` is printed after the first switch.
 */
import { brandString } from '@deepseek-ai/dsh-brand'
import { STORE_LOCK_WAIT_MS, type RuntimeVersion } from '@delo/contract-home-layout'
import { withStoreLock } from '../../src/lock.ts'
import { StorePaths } from '../../src/paths.ts'
import { readPointers, writePointers, type PointerStep } from '../../src/pointer.ts'
import { RuntimeStore } from '../../src/store.ts'
import { PLATFORM, RecordingLogger } from '../support.ts'

const [mode = '', home = '', ...rest] = process.argv.slice(2)
const runtime = (text: string | undefined): RuntimeVersion => brandString<RuntimeVersion>(text ?? '')

/** End this process at once, as a crash or `kill -9` would. */
function die(): never {
  process.kill(process.pid, 'SIGKILL')
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10_000)
  throw new Error('SIGKILL was not delivered')
}

if (mode === 'step') {
  const [pointer, step, from, to] = rest
  const paths = new StorePaths(home, PLATFORM)
  await withStoreLock(paths.lock, STORE_LOCK_WAIT_MS, async () => {
    const { current } = await readPointers(paths)
    if (current !== from) throw new Error(`current names ${current}, not ${String(from)}`)
    await writePointers(paths, { current: runtime(to), previous: runtime(from) }, (reached: PointerStep) => {
      if (reached.pointer === pointer && reached.step === step) die()
    })
  })
} else if (mode === 'loop') {
  const [a, b] = rest
  const store = new RuntimeStore({ home, platform: PLATFORM, logger: new RecordingLogger() })
  let announced = false
  for (;;) {
    const { current } = await store.pointers()
    await store.switchTo(current, current === runtime(a) ? runtime(b) : runtime(a))
    if (!announced) {
      process.stdout.write('ready\n')
      announced = true
    }
  }
} else {
  throw new Error(`unknown mode ${mode}`)
}
