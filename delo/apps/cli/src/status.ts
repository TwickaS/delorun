/**
 * `delorun status`: the home, the CLI profile, an inherited `DSH_HOME` that `delorun` ignored (contract C1, "The
 * home directory"), and the home process's own `status` answer over the update channel (contract C19, "Commands"):
 * its state, process id, start id, the `current`, `previous` and running runtime versions, the running chats, the
 * update in progress and the studio's loopback address, with the command that opens the studio. The address is printed
 * without any query, fragment or credentials, so no token reaches the output. `--json` prints the `status` answer alone. It creates nothing. Exit codes follow C19: 0 when
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
import { profileDirectory, selectProfile } from './profile.ts'
import { dangerousModeLine } from './setup/dangerous.ts'

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
 * @param verbose - whether to add the process id, the start id and the previous version.
 * @returns the lines.
 */
function statusLines(status: HomeStatus, verbose: boolean): string {
  const studio = studioAddress(status.studio)
  return [
    `Delorun is ${status.state}.`,
    ...studio === undefined ? [] : [`Studio: ${studio.href}`],
    `Version: ${status.runtime.running}${verbose && status.runtime.previous !== undefined ? ` (previous ${status.runtime.previous})` : ''}`,
    `Running chats: ${String(status.chats)}`,
    ...status.update === undefined ? [] : [`Update: ${status.update.phase} to ${status.update.target}`],
    ...verbose ? [`Process id: ${String(status.pid)}`, `Start id: ${status.startId}`] : [],
    ...studio === undefined ? [] : [OPEN_HINT],
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
    const home = await resolveDeloHome(context.env)
    const json = values.json === true
    const verbose = values.verbose === true
    if (!json) {
      if (verbose) context.stdout(`Home: ${home.path}\nProfile: ${profile}\n`)
      else if (profile !== 'default') context.stdout(`Profile: ${profile}\n`)
      const dangerous = await dangerousModeLine(home.path, profileDirectory(home.path, profile))
      if (dangerous !== undefined) context.stdout(`${dangerous}\n`)
      if (home.ignoredDshHome !== undefined) {
        context.stdout(`Note: ${DSH_HOME_ENV} is set to ${home.ignoredDshHome}; Delorun ignores it and uses ${DSH_HOME_ENV}=${home.path}\n`)
      }
    }
    const record = readHomeLock(runDirectory(home.path, profile))
    if (record === undefined || !holderAlive(record)) {
      if (json) context.stdout(`${JSON.stringify({ ok: false, state: 'not-running' })}\n`)
      else context.stdout('Delorun is not running. Start it with delorun start.\n')
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
    context.stdout(json ? `${JSON.stringify({ ok: true, status: answer })}\n` : statusLines(answer as HomeStatus, verbose))
    return EXIT.ok
  },
}
