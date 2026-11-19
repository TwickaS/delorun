/**
 * A stand-in Host for the live Host-kill run: it opens a Claude Code session in a task folder through the driver, has
 * it start a 40-second command, prints `{"programSessionId": …}` once the command runs, and waits to be killed.
 *
 *   node --import tsx/esm delorun/packages/agent-claude-code/live/host.ts <task folder> <log file name>
 * @module @delorun/agent-claude-code/live/host
 */
import { driver, Log, readTurn, runtime } from './common.ts'
import type { SessionId } from '@delorun/external-agents/contract'

const [task, name] = process.argv.slice(2)
if (task === undefined || name === undefined) throw new Error('usage: host.ts <task folder> <log name>')
const log = new Log(name)
const rt = await runtime(task)
const session = await driver().open({
  sessionId: 'live-host' as SessionId, cwd: task, level: 'standard', runRules: [], harnessTools: [], sharesFolder: () => false, spawn: rt.spawn,
  onApproval: (request) => {
    log.line('question', `${request.toolName} ${request.reason}`)
    return Promise.resolve('allow-once')
  },
  onLimits: (observation) => { log.line('limits', observation) },
  signal: new AbortController().signal,
})
await session.send('Run this shell command exactly, in the foreground, and wait for it: python3 -c "import time; time.sleep(40)" && echo late > late.txt. Then say done.', 'start')
await readTurn(session, log, async (event) => {
  if (event.kind !== 'tool-call') return
  await new Promise(resolve => setTimeout(resolve, 5000))
  console.log(JSON.stringify({ programSessionId: session.programSessionId }))
})
