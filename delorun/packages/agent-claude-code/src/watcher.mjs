/**
 * Delorun's watcher between the Host and Claude Code on POSIX. It starts the program, relays the Host's pipe to the
 * program's standard input, and ends its own process group when that pipe closes, which is how it learns the Host has
 * gone: SIGTERM at once, SIGKILL five seconds later. Claude Code otherwise finishes a running tool call after the Host
 * dies.
 *
 *   node watcher.mjs <program> [args...]
 *
 * The gate's subprocess owner starts the watcher as the leader of a process group of its own. The program and every
 * command it runs stay in that group, never detached, so the owner's TERM and KILL reach them all. A watcher outside a
 * group of its own would signal its starter's group, so it refuses to start there (exit 126). A terminating signal the
 * watcher itself receives ends the group in the same way; the program's own exit otherwise ends the watcher with the
 * program's exit code.
 * @module @delorun/agent-claude-code/watcher
 */
import { spawn } from 'node:child_process'
import { constants } from 'node:os'

/** Time between SIGTERM and SIGKILL to the group after the Host's pipe closes. */
const KILL_AFTER_MS = 5000

const [command, ...args] = process.argv.slice(2)
if (command === undefined) {
  process.stderr.write('usage: node watcher.mjs <program> [args...]\n')
  process.exit(2)
}

/**
 * Whether this process leads a process group of its own: a group whose id is this process's id exists only then.
 * @returns true when it leads its group.
 */
function leadsGroup() {
  try {
    process.kill(-process.pid, 0)
    return true
  } catch (_notLeader) {
    // ESRCH: no group has this process's id, so this process was started inside another group.
    return false
  }
}

if (!leadsGroup()) {
  process.stderr.write('watcher.mjs: not the leader of a process group of its own; refusing to start the program\n')
  process.exit(126)
}

/**
 * Send a signal to the watcher's own group, which holds the program and its commands.
 * @param signal - the signal.
 */
function signalGroup(signal) {
  try {
    process.kill(-process.pid, signal)
  } catch (_gone) {
    // ESRCH: every process in the group has already exited, so there is nothing left to signal.
  }
}

let ending = false

/**
 * End the group once: SIGTERM now, SIGKILL after {@link KILL_AFTER_MS}. The watcher stays until the SIGKILL, which
 * ends it too, so a command that outlives the program still gets it.
 */
function endGroup() {
  if (ending) return
  ending = true
  signalGroup('SIGTERM')
  setTimeout(() => { signalGroup('SIGKILL') }, KILL_AFTER_MS)
}

const child = spawn(command, args, { stdio: ['pipe', 'inherit', 'inherit'] })
process.stdin.pipe(child.stdin)
// The program may exit while the Host still writes; the write error then means only that the program is gone.
child.stdin.on('error', () => {})
process.stdin.on('end', endGroup)
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(signal, endGroup)
child.on('error', () => { process.exit(127) })
child.on('exit', (code, signal) => {
  // While the group is ending, the pending SIGKILL ends the watcher with the rest of the group.
  if (!ending) process.exit(code ?? 128 + (signal === null ? 0 : constants.signals[signal]))
})
