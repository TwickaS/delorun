/**
 * `delorun status`: the home, the CLI profile, an inherited `DSH_HOME` that `delorun` ignored (contract C1, "The
 * home directory"), and the home process's own `status` answer over the update channel (contract C19, "Commands"):
 * its state, process id, start id, the `current`, `previous` and running runtime versions, the running chats, the
 * update in progress, whether its debugger is open (`delorun start --inspect`, [inspector](./inspector.ts)) and the studio's loopback address, with the command that opens the studio. The address is printed
 * without any query, fragment or credentials, so no token reaches the output. `--json` prints the `status` answer, with an `inspector` field while the debugger is open. It creates nothing. Exit codes follow C19: 0 when
 * a home process runs, 3 when none runs, 1 on an error, such as a live lock holder whose channel does not answer.
 * While a work session is open (contract C21, "Work sessions"), the text output names its plugin, start and end time.
 * It also names the plugins approved at upgrade that no terminal has shown yet, the changes waiting for review and a
 * lowered protection setting (C21, "What verify and doctor report"), since `delorun start` shows its start's notice
 * only in the log.
 *
 * @module @delorun/cli/status
 */
import { workSessionFact } from '@delorun/changes'
import { DSH_HOME_ENV, HOME_STATUS_TIMEOUT_MS } from '@delorun/contract-home-layout'
import type { HomeStatus } from '@delorun/contract-home-process'
import { holderAlive, readHomeLock, resolveDelorunHome, runDirectory } from '@delorun/home'
import { queryHomeStatus } from '@delorun/home-process'
import { fileURLToPath } from 'node:url'
import { EXIT } from './exit.ts'
import { runtimeOfFile } from './update/runtime.ts'
import { parseOptions, type CliCommand } from './command.ts'
import { profileDirectory, selectProfile } from './profile.ts'
import { readInspectorRecord, type InspectorRecord } from './inspector.ts'
import { dangerousModeLine } from './setup/dangerous.ts'
import { autostartStatusLine } from './setup/autostart-section.ts'
import { notRunningText } from './messages.ts'
import { readableTime } from './output.ts'
import { commandRows, styleOf, type Style } from './style.ts'
import { printable } from './terminal-text.ts'
import { changesNotice } from './verify/changes.ts'

/**
 * The line that names the profile's open work session.
 * @param home - the Delorun home.
 * @param profile - the profile's name.
 * @returns the line with its line ending; empty when no session is open.
 */
async function workSessionLine(home: string, profile: string): Promise<string> {
  try {
    const session = await workSessionFact(home, profile)
    return session === undefined ? '' : `work session: ${printable(session.plugin)} since ${readableTime(session.startedAt)}, ends at ${readableTime(session.endsAt)}\n`
  } catch (error) {
    // workSessionFact refuses a record Delorun did not write with a ChangesError, whose message is its detail.
    return `work session: unreadable: ${printable((error as Error).message)}\n`
  }
}

/** What `delorun open` does, beside its command in the status output. */
export const OPEN_EXPLANATION = 'open the studio in your browser'

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
 * @param verbose - whether to add the process id, the start id and the previous version.
 * @param inspector - the debugger the home process keeps open, if any.
 * @param fromStore - whether this program runs from the runtime store; a source build has no release version to show.
 * @returns the lines.
 */
function statusLines(status: HomeStatus, verbose: boolean, inspector: InspectorRecord | undefined, fromStore: boolean, style: Style): string {
  const studio = studioAddress(status.studio)
  const details = [
    ...studio === undefined ? [] : [`Studio: ${studio.href}`],
    `Version: ${fromStore ? status.runtime.running : 'source build'}${verbose && status.runtime.previous !== undefined ? ` (previous ${status.runtime.previous})` : ''}`,
    `Running chats: ${String(status.chats)}`,
    ...status.update === undefined ? [] : [`Update: ${status.update.phase} to ${status.update.target}`],
    ...verbose ? [`Process id: ${String(status.pid)}`, `Start id: ${status.startId}`] : [],
    ...inspector === undefined ? [] : [`inspector: open at ${inspector.url} since ${readableTime(inspector.openedAt)}; any process on this computer, including commands the agent runs inside the sandbox, can run code as Delorun outside the sandbox until Delorun restarts without --inspect`],
  ]
  return [
    style.mark(status.state === 'running' ? 'ok' : 'warn', `Delorun is ${status.state}.`),
    ...details.map(line => `  ${line}`),
    ...studio === undefined ? [] : commandRows(style, [['delorun open', OPEN_EXPLANATION], ['delorun stop', 'stop it']]),
    '',
  ].join('\n')
}

/** `delorun status [--verbose] [--profile <name>] [--json]`. */
export const statusCommand: CliCommand = {
  name: 'status',
  summary: 'Show whether Delorun is running, its studio address and its running chats; --verbose adds process details',
  async run(args, context) {
    const values = parseOptions('status', args, { profile: { type: 'string' }, json: { type: 'boolean', default: false }, verbose: { type: 'boolean', default: false } })
    const profile = selectProfile(values.profile, context.env)
    const home = await resolveDelorunHome(context.env)
    const json = values.json === true
    const style = styleOf(context.env)
    const verbose = values.verbose === true
    if (!json) {
      if (verbose) context.stdout(`Home: ${home.path}\nProfile: ${profile}\n`)
      else if (profile !== 'default') context.stdout(`Profile: ${profile}\n`)
      const dangerous = await dangerousModeLine(home.path, profileDirectory(home.path, profile))
      if (dangerous !== undefined) context.stdout(`${dangerous}\n`)
      if (home.ignoredDshHome !== undefined) {
        context.stdout(`Note: ${DSH_HOME_ENV} is set to ${home.ignoredDshHome}; Delorun ignores it and uses ${DSH_HOME_ENV}=${home.path}\n`)
      }
      context.stdout(await workSessionLine(home.path, profile))
      context.stdout(await changesNotice(home.path, profile))
      context.stdout(await autostartStatusLine(context.env))
    }
    const record = readHomeLock(runDirectory(home.path, profile))
    if (record === undefined || !holderAlive(record)) {
      if (json) context.stdout(`${JSON.stringify({ ok: false, state: 'not-running' })}\n`)
      else context.stdout(`${style.mark('note', notRunningText(profile))}\n`)
      return EXIT.notRunning
    }
    let answer
    try {
      answer = await queryHomeStatus(home.path, profile, HOME_STATUS_TIMEOUT_MS)
    } catch (error) {
      context.stderr(`delorun status: Delorun looks to be running (process ${String(record.pid)}), but it did not answer: ${error instanceof Error ? error.message : String(error)}. Run delorun logs to see why.\n`)
      return EXIT.failed
    }
    if (!('state' in answer)) {
      context.stderr(`delorun status: Delorun refused the request: ${String(answer.error)}. Run delorun logs to see why.\n`)
      return EXIT.failed
    }
    const inspector = readInspectorRecord(home.path, profile, record.pid)
    context.stdout(json ? `${JSON.stringify({ ok: true, status: answer, ...inspector === undefined ? {} : { inspector: { url: inspector.url, openedAt: inspector.openedAt } } })}\n` : statusLines(answer as HomeStatus, verbose, inspector, runtimeOfFile(home.path, fileURLToPath(import.meta.url)).store, style))
    return EXIT.ok
  },
}
