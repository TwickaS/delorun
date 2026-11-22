/**
 * Connect to a Delorun home in WSL2: status, the version guard, the one-time sign-in link, the exchange for the home's
 * cookie, and the boot rows. The cookie and the link stay in the main process: this module returns the cookie to main
 * and never to a renderer, a log or an error.
 */

import { checkHomeVersion } from './version-skew.ts'
import { INDEX_INJECTIONS_PATH, parseHomeInjections, type HomeInjection } from './home-injections.ts'
import { readSignInLink, requireListedDistro, runWsl, selectLauncher, WslHomeError, type WslRunner } from './wsl-home.ts'
import { authenticateWebHost } from './web-document.ts'

/** What a connected home gives the main process. */
export interface WslHomeConnection {
  /** The home's loopback origin, `http://127.0.0.1:<port>`, with no token. */
  readonly origin: string
  /** The cookie header for requests to the home; main keeps it and no renderer sees it. */
  readonly cookie: string
  /** The home version `delorun status --json` reported. */
  readonly version: string
  /** Boot rows for the bundled client. */
  readonly injections: readonly HomeInjection[]
}

/** The calls {@link connectWslHome} makes; replaced in specs. */
export interface WslConnectionDeps {
  /** How `wsl.exe` is run. */
  readonly run?: WslRunner
  /** Exchange the one-time link for a cookie header. */
  readonly exchange?: (link: string) => Promise<string>
  /** Fetch the home's boot rows with the cookie; the parsed JSON answer. */
  readonly fetchRows?: (origin: string, cookie: string) => Promise<unknown>
}

/**
 * Deadline of each request to the home during connection, in milliseconds; a forwarded port that accepts the connection
 * and then hangs would otherwise wait far longer.
 */
export const HOME_REQUEST_TIMEOUT_MS = 20_000

async function fetchHomeRows(origin: string, cookie: string): Promise<unknown> {
  const response = await fetch(new URL(INDEX_INJECTIONS_PATH, origin), {
    headers: { cookie }, redirect: 'manual', signal: AbortSignal.timeout(HOME_REQUEST_TIMEOUT_MS),
  })
  if (response.status !== 200) {
    await response.body?.cancel()
    return undefined
  }
  return response.json().catch(() => undefined /* not JSON: not a Delorun home's answer */)
}

/**
 * Connect to the home a source names.
 * @param distro - WSL distribution name.
 * @param profile - Delorun profile name.
 * @param deps - Replaceable calls.
 * @returns the connection.
 * @throws {WslHomeError} with the code that names the step that failed; its detail never holds the link or the cookie.
 */
export async function connectWslHome(distro: string, profile: string, deps: WslConnectionDeps): Promise<WslHomeConnection> {
  const run = deps.run ?? runWsl
  await requireListedDistro(distro, run)
  const { status, launcher } = await selectLauncher(distro, profile, run)
  if (status.state === 'not-running') throw new WslHomeError('home-not-running', { distro })
  const verdict = checkHomeVersion(status.version)
  if (verdict.kind === 'unreadable') throw new WslHomeError('version-unreadable', { distro, range: verdict.range })
  if (verdict.kind === 'older') throw new WslHomeError('home-too-old', { distro, version: verdict.version, range: verdict.range })
  if (verdict.kind === 'newer') throw new WslHomeError('home-too-new', { distro, version: verdict.version, range: verdict.range })
  // F24 (A604): the link is used once here and dropped; no command line, log, error or renderer holds it.
  const link = await readSignInLink(distro, profile, status.studio, run, launcher)
  const origin = new URL(link).origin
  let cookie: string
  try { cookie = await (deps.exchange ?? authenticateWebHost)(link) } catch (error) {
    // A connection that fails outright, or does not answer in time, means the forwarding did not reach the home; a refusal
    // means the link was stale or used. The original error is not kept: a transport error can name the request it carried.
    const unreachable = error instanceof TypeError || (error instanceof Error && error.name === 'TimeoutError')
    throw new WslHomeError(unreachable ? 'forwarding-unreachable' : 'exchange-failed', { distro })
  }
  // A transport error or a timeout reading the rows is the same plain failure as a home that answers no rows.
  const answer = await (deps.fetchRows ?? fetchHomeRows)(origin, cookie).catch(() => undefined)
  const injections = parseHomeInjections(answer)
  if (injections === undefined) throw new WslHomeError('rows-unavailable', { distro, version: status.version })
  return { origin, cookie, version: status.version, injections }
}
