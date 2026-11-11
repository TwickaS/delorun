/**
 * `delorun status`: the home, the CLI profile, an inherited `DSH_HOME` that `delorun` ignored (contract C1, "The
 * home directory"), and the home process's own `status` answer over the update channel (contract C19, "Commands"):
 * its state, process id, start id, the `current`, `previous` and running runtime versions, the running chats and
 * the update in progress, and whether its debugger is open (`delorun start --inspect`, [inspector](./inspector.ts)).
 * `--json` prints the `status` answer, with an `inspector` field while the debugger is open. It creates nothing. Exit codes follow C19: 0 when
 * a home process runs, 3 when none runs, 1 on an error, such as a live lock holder whose channel does not answer.
 *
 * @module @delo/cli/status
 */
import { DSH_HOME_ENV, HOME_STATUS_TIMEOUT_MS } from '@delo/contract-home-layout'
import type { HomeStatus } from '@delo/contract-home-process'
import { holderAlive, readHomeLock, resolveDeloHome, runDirectory } from '@delo/home'
import { queryHomeStatus } from '@delo/home-process'
import { EXIT } from './exit.ts'
import { parseOptions, type CliCommand } from './command.ts'
import { selectProfile } from './profile.ts'
import { readInspectorRecord, type InspectorRecord } from './inspector.ts'

/**
 * The lines `delorun status` prints for a home process's answer.
 * @param status - the answer.
 * @param inspector - the debugger the home process keeps open, if any.
 * @returns the lines.
 */
function statusLines(status: HomeStatus, inspector: InspectorRecord | undefined): string {
  return [
    `state: ${status.state}`,
    `pid: ${String(status.pid)}`,
    `startId: ${status.startId}`,
    `runtime: ${status.runtime.running} (current ${status.runtime.current}${status.runtime.previous === undefined ? '' : `, previous ${status.runtime.previous}`})`,
    `chats: ${String(status.chats)}`,
    ...status.update === undefined ? [] : [`update: ${status.update.phase} to ${status.update.target}`],
    ...inspector === undefined ? [] : [`inspector: open at ${inspector.url} since ${inspector.openedAt}; any process on this computer, including commands the agent runs inside the sandbox, can run code as Delo outside the sandbox until Delo restarts without --inspect`],
    '',
  ].join('\n')
}

/** `delorun status [--profile <name>] [--json]`. */
export const statusCommand: CliCommand = {
  name: 'status',
  summary: 'Show the home, the CLI profile and the state of its home process',
  async run(args, context) {
    const values = parseOptions('status', args, { profile: { type: 'string' }, json: { type: 'boolean', default: false } })
    const profile = selectProfile(values.profile, context.env)
    const home = await resolveDeloHome(context.env)
    const json = values.json === true
    if (!json) {
      context.stdout(`home: ${home.path}\nprofile: ${profile}\n`)
      if (home.ignoredDshHome !== undefined) {
        context.stdout(`note: ${DSH_HOME_ENV} is set to ${home.ignoredDshHome}; delorun ignores it and runs with ${DSH_HOME_ENV}=${home.path}\n`)
      }
    }
    const record = readHomeLock(runDirectory(home.path, profile))
    if (record === undefined || !holderAlive(record)) {
      if (json) context.stdout(`${JSON.stringify({ ok: false, state: 'not-running' })}\n`)
      else context.stdout(record === undefined ? 'state: not running\n' : `state: not running (a lock left by process ${String(record.pid)}, which has exited, is replaced at the next start)\n`)
      return EXIT.notRunning
    }
    let answer
    try {
      answer = await queryHomeStatus(home.path, profile, HOME_STATUS_TIMEOUT_MS)
    } catch (error) {
      context.stderr(`delorun status: process ${String(record.pid)} holds the profile's lock but its update channel did not answer: ${error instanceof Error ? error.message : String(error)}\n`)
      return EXIT.failed
    }
    if (!('state' in answer)) {
      context.stderr(`delorun status: the home process refused the request: ${String(answer.error)}\n`)
      return EXIT.failed
    }
    const inspector = readInspectorRecord(home.path, profile, record.pid)
    context.stdout(json ? `${JSON.stringify({ ok: true, status: answer, ...inspector === undefined ? {} : { inspector: { url: inspector.url, openedAt: inspector.openedAt } } })}\n` : statusLines(answer as HomeStatus, inspector))
    return EXIT.ok
  },
}
