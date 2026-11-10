/**
 * `delorun status`: the home, the CLI profile, an inherited `DSH_HOME` that `delorun` ignored (contract C1, "The
 * home directory"), and the home process's own `status` answer over the update channel (contract C19, "Commands"):
 * its state, process id, start id, the `current`, `previous` and running runtime versions, the running chats, the
 * update in progress and the studio's loopback address, with the command that opens the studio. The address is printed
 * without any query, fragment or credentials, so no token reaches the output. `--json` prints the `status` answer alone. It creates nothing. Exit codes follow C19: 0 when
 * a home process runs, 3 when none runs, 1 on an error, such as a live lock holder whose channel does not answer.
 * While a work session is open (contract C21, "Work sessions"), the text output names its plugin, start and end time.
 * It also names the plugins approved at upgrade that no terminal has shown yet, the changes waiting for review and a
 * lowered protection setting (C21, "What verify and doctor report"), since `delorun start` shows its start's notice
 * only in the log.
 *
 * @module @delo/cli/status
 */
import { workSessionFact } from '@delo/changes'
import { DSH_HOME_ENV, HOME_STATUS_TIMEOUT_MS } from '@delo/contract-home-layout'
import type { HomeStatus } from '@delo/contract-home-process'
import { holderAlive, readHomeLock, resolveDeloHome, runDirectory } from '@delo/home'
import { queryHomeStatus } from '@delo/home-process'
import { EXIT } from './exit.ts'
import { parseOptions, type CliCommand } from './command.ts'
import { selectProfile } from './profile.ts'
import { printable } from './terminal-text.ts'
import { changesNotice } from './verify/changes.ts'

/**
 * The line that names the profile's open work session.
 * @param home - the Delo home.
 * @param profile - the profile's name.
 * @returns the line with its line ending; empty when no session is open.
 */
async function workSessionLine(home: string, profile: string): Promise<string> {
  try {
    const session = await workSessionFact(home, profile)
    return session === undefined ? '' : `work session: ${printable(session.plugin)} since ${session.startedAt}, ends at ${session.endsAt}\n`
  } catch (error) {
    // workSessionFact refuses a record Delo did not write with a ChangesError, whose message is its detail.
    return `work session: unreadable: ${printable((error as Error).message)}\n`
  }
}

/** The line that follows the studio's address. */
export const OPEN_HINT = 'Run delorun open to open the studio in your browser.'

/**
 * The studio's address from a `status` answer, read at the update channel's wire boundary: an `http:` or `https:` URL
 * with its query, fragment and credentials removed.
 * @param studio - the answer's `studio` field.
 * @returns the address, or `undefined` when the answer has none or it is not such a URL.
 */
export function studioAddress(studio: string | undefined): URL | undefined {
  if (studio === undefined || !URL.canParse(studio)) return undefined
  const url = new URL(studio)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined
  url.search = ''
  url.hash = ''
  url.username = ''
  url.password = ''
  return url
}

/**
 * The lines `delorun status` prints for a home process's answer.
 * @param status - the answer.
 * @returns the lines.
 */
function statusLines(status: HomeStatus): string {
  const studio = studioAddress(status.studio)
  return [
    `state: ${status.state}`,
    `pid: ${String(status.pid)}`,
    `startId: ${status.startId}`,
    `runtime: ${status.runtime.running} (current ${status.runtime.current}${status.runtime.previous === undefined ? '' : `, previous ${status.runtime.previous}`})`,
    `chats: ${String(status.chats)}`,
    ...status.update === undefined ? [] : [`update: ${status.update.phase} to ${status.update.target}`],
    ...studio === undefined ? [] : [`studio: ${studio.href}`, OPEN_HINT],
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
      context.stdout(await workSessionLine(home.path, profile))
      context.stdout(await changesNotice(home.path, profile))
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
    context.stdout(json ? `${JSON.stringify({ ok: true, status: answer })}\n` : statusLines(answer as HomeStatus))
    return EXIT.ok
  },
}
