/**
 * Delorun's watcher between the Host and Claude Code on POSIX. It starts the program, relays the Host's pipe to the
 * program's standard input, and ends the program's whole process group when that pipe closes, which is how it learns
 * the Host has gone: SIGTERM at once, SIGKILL five seconds later. Claude Code otherwise finishes a running tool call
 * after the Host dies.
 *
 *   node watcher.mjs <program> [args...]
 *
 * The gate's subprocess owner starts the watcher as the leader of its own process group, so the program stays in that
 * group and inside the owner's managed range; the owner's own TERM and KILL reach it directly. A watcher started
 * outside a group of its own puts the program in a group of the program's own and passes its signals on.
 * @module @delorun/agent-claude-code/watcher
 */
import { spawn } from 'node:child_process'
import { constants } from 'node:os'

/** Time between SIGTERM and SIGKILL to the program's group after the Host's pipe closes. */
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

const leader = leadsGroup()
const child = spawn(command, args, { stdio: ['pipe', 'inherit', 'inherit'], detached: !leader })
const group = leader ? -process.pid : -child.pid

/**
 * Send a signal to the program's group.
 * @param signal - the signal.
 */
function signalGroup(signal) {
  try {
    process.kill(group, signal)
  } catch (_gone) {
    // ESRCH: every process in the group has already exited, so there is nothing left to signal.
  }
}

process.stdin.pipe(child.stdin)
// The program may exit while the Host still writes; the write error then means only that the program is gone.
child.stdin.on('error', () => {})
process.stdin.on('end', () => {
  signalGroup('SIGTERM')
  setTimeout(() => { signalGroup('SIGKILL') }, KILL_AFTER_MS).unref()
})
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
  process.on(signal, () => {
    // A leader's group signal already reached the program; a program in its own group needs it passed on.
    if (!leader) signalGroup(signal)
  })
}
child.on('error', () => { process.exit(127) })
child.on('exit', (code, signal) => {
  process.exit(code ?? 128 + (signal === null ? 0 : constants.signals[signal]))
})
