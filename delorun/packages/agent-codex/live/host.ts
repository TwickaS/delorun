/**
 * A stand-in Host for the `hostkill` live run: opens a thread in the given task folder, starts a 40 s command, prints
 * one JSON line with the thread id once the command has run for 3 s, then waits to be killed.
 * @module @delorun/agent-codex/live/host
 */
import { live, sleep } from './common.ts'

const task = process.argv[2]
if (task === undefined) throw new Error('usage: host.ts <task folder>')
const run = await live('hostkill-host', task)
run.answers = ['allow-once']
const session = await run.driver.open(run.request())
await session.send('Run this shell command exactly: sleep 40 && touch late.txt. Then say done.', 'start')
const signal = AbortSignal.timeout(240_000)
for (;;) {
  const event = await session.next(signal)
  if (event.kind !== 'tool-call') continue
  await sleep(3_000)
  console.log(JSON.stringify({ threadId: session.programSessionId }))
  break
}
await new Promise(() => {})
