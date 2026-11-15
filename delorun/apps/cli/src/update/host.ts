/**
 * What the CLI's Host reports to the home process (contracts C19 and C3): its running chats, counted from upstream's
 * `agent/status` event with each agent's own cancellation and from the job registry's events with each job's kill, the
 * held state of the gate, which `@delorun/bundle-local`'s `delorunTurnGate` service reads to refuse new turns, and C3's
 * health check H1 to H5 over the booted rows, the studio listener's health route ({@link serveHealth}), the runtime's
 * files and the profile's bundle list.
 *
 * @module @delorun/cli/update/host
 */
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import type { IncomingMessage } from 'node:http'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { JobId } from '@deepseek-ai/dsh-jobs'
import type {} from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@delorun/bundle-local/update-gate'
import { protectedPluginsIn } from '@delorun/home-auth'
import type { BootRow, CountingChatGate, HealthExpectations, HealthVerdict, HostProtection } from '@delorun/home-process'
import { bundleListOf } from '@delorun/profile-safety'
import type { BootedRow } from '../delorun-bundles.ts'
import { hostProtectionOf, protectionWeakenings, SANDBOX_ROW, settingsBeyondProtection } from '../sandbox-protection.ts'

/** How long the Host's health route has to answer H2's request. */
export const STUDIO_HEALTH_TIMEOUT_MS = 10_000

/** The path of the Host's health route, which H2 requests on the studio's loopback listener. */
export const HEALTH_PATH = '/delorun/health'

/** The reason a turn or a job cancelled by the gate carries. */
export const STOP_REASON = 'Delorun is stopping or updating'

/**
 * Count the Host's running chats into the gate, and refuse new turns while it is held. A running chat is an agent
 * between its `running` and `idle` statuses, or a job of the job registry between its `registered` and `settled`
 * events; either is counted from the event that reports it, so work that began before this call is not. While the
 * `delorunTurnGate` service is present, its held state is the gate's, so the first step of a new turn is refused with
 * `UPDATE_PENDING`; without the service a turn that starts while the gate is held is counted and the wait lasts until
 * it ends.
 * @param ctx - the booted profile's root context.
 * @param gate - the home process's gate.
 * @returns nothing; the listeners and the attachment are effects of `ctx` and go with it.
 */
export function watchChats(ctx: Context, gate: CountingChatGate): void {
  const ends = new Map<Agent, () => void>()
  ctx.on('agent/status', ({ agent, status }) => {
    if (status === 'running') {
      if (!ends.has(agent)) ends.set(agent, gate.track(() => { agent.cancel({ kind: 'hook', reason: STOP_REASON }) }))
      return
    }
    ends.get(agent)?.()
    ends.delete(agent)
  })
  ctx.inject(['jobs'], (scope) => {
    const jobs = new Map<JobId, () => void>()
    scope.effect(() => scope.jobs.events.subscribe({ owners: 'all' }, (event) => {
      if (event.type === 'registered') {
        const { id, owner } = event.job
        jobs.set(id, gate.track(() => {
          try {
            scope.jobs.kill(id, owner, STOP_REASON)
          } catch (error) {
            scope.logger.warn(`the job ${id} could not be cancelled for the update or stop: ${String(error)}`)
          }
        }))
        return
      }
      if (event.type !== 'settled' && event.type !== 'removed') return
      jobs.get(event.job.id)?.()
      jobs.delete(event.job.id)
    }))
    // The registry settles its jobs when it goes; a job it never reported settled is not running either.
    scope.effect(() => () => {
      for (const end of jobs.values()) end()
      jobs.clear()
    })
  })
  ctx.inject(['delorunTurnGate'], (scope) => {
    scope.effect(() => scope.delorunTurnGate.attach(() => gate.held))
  })
}

/** What the health check reads from the booted Host. */
export interface HostHealthFacts {
  /** The Loader's rows after startup settled. */
  readonly rows: () => readonly BootedRow[]
  /** The studio's loopback listener, or `undefined` when it has none. */
  readonly studio: () => { readonly host: string, readonly port: number } | undefined
  /** The profile directory, whose `package.json` holds the bundle list. */
  readonly profileDir: string
  /**
   * H1: check the running runtime's files against its signed file list, or nothing when it does not run from the store.
   * @throws when a file differs.
   */
  readonly verifyRuntime: () => Promise<void>
}

/**
 * Whether a request arrived on the Host's loopback listener from this computer, under a loopback `Host`: the connection
 * comes from a loopback address to the listener's own port, so no reach listener, which listens on a port of its own,
 * and no other computer is answered, and a page that rebinds a name of its own to `127.0.0.1` is refused by its `Host`.
 * A listener bound to every address (`0.0.0.0` or `::`) also takes connections from other computers, which the first
 * condition refuses; an origin that names no port is on its scheme's default port.
 * @param request - the request.
 * @param origin - the loopback listener's origin, such as `http://127.0.0.1:3080`.
 * @returns true when all three hold.
 */
export function arrivedOnLoopbackListener(request: Pick<IncomingMessage, 'socket' | 'headers'>, origin: string): boolean {
  const remote = request.socket.remoteAddress ?? ''
  const fromLoopback = remote === '::1' || /^(?:::ffff:)?127(?:\.\d{1,3}){3}$/u.test(remote)
  const listener = new URL(origin)
  const listenerPort = listener.port === '' ? (listener.protocol === 'https:' ? '443' : '80') : listener.port
  const toListener = String(request.socket.localPort) === listenerPort
  const host = URL.parse(`http://${request.headers.host ?? ''}`)?.hostname.toLowerCase()
  const loopbackHost = host !== undefined && (host === 'localhost' || host.endsWith('.localhost') || host === '[::1]' || /^127(?:\.\d{1,3}){3}$/u.test(host))
  return fromLoopback && toListener && loopbackHost
}

/**
 * The URL H2 asks: the health route of the studio listener at its address, or at `127.0.0.1` for a listener bound to
 * every address (`0.0.0.0`, or `::`, which takes IPv4 connections too), so the request comes from and names a loopback
 * address, as {@link arrivedOnLoopbackListener} requires.
 * @param studio - the studio listener's bound address and port.
 * @returns the URL, with an IPv6 address bracketed.
 */
export function studioHealthUrl(studio: { readonly host: string, readonly port: number }): string {
  const address = studio.host === '0.0.0.0' || studio.host === '::' ? '127.0.0.1' : studio.host
  return `http://${address.includes(':') ? `[${address}]` : address}:${String(studio.port)}${HEALTH_PATH}`
}

/**
 * Serve H2's health route on the Host's web server, on its loopback listener only: a request that did not arrive there
 * ({@link arrivedOnLoopbackListener}) is answered `421`. `GET` and `HEAD` read the studio's index in this process, as the
 * owner's browser, through the web server's own responder, and answer `204` when it reads with status 200 and `503`
 * otherwise, always with no body and `no-store`; every other method answers `405`. The answer tells only whether the
 * studio could be served: it reads no cookie, returns no content and changes nothing, so the studio's sign-in still
 * guards every page and API. The route is an effect of `ctx` and goes with it.
 * @param ctx - the booted profile's root context.
 * @returns nothing; a Host without a web server serves no route, and H2 reports that it has no studio listener.
 */
export function serveHealth(ctx: Context): void {
  const server = ctx.get('webServer')
  if (server === undefined) return
  ctx.effect(() => server.register({
    kind: 'exact',
    path: HEALTH_PATH,
    handler: async (request, response) => {
      if (!arrivedOnLoopbackListener(request, server.getOrigin())) {
        response.writeHead(421, { 'cache-control': 'no-store' })
        response.end()
        return
      }
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        response.writeHead(405, { 'cache-control': 'no-store', allow: 'GET, HEAD' })
        response.end()
        return
      }
      let served = false
      const peer = ctx.get('connection')?.browserPeer
      if (peer !== undefined) {
        try {
          const index = await server.readResource(new Request(new URL('/', server.getOrigin())), peer)
          await index.body?.cancel()
          served = index.status === 200
        } catch (error) {
          // A responder that throws cannot serve the studio; the answer below says so, and the Host's log keeps why.
          ctx.logger.warn(error instanceof Error ? error : new Error(String(error)))
        }
      }
      response.writeHead(served ? 204 : 503, { 'cache-control': 'no-store' })
      response.end()
    },
  }), 'delorun health route')
}

/**
 * Whether a row's id is one the Loader made up because the row's patch gives it none: the Loader's `ensureId` takes
 * eight hexadecimal digits of `Math.random()` (`vendor/loader/src/config/tree.ts`), new at each boot. A patch id of that
 * form is read as generated too, which only lets the check match that row by its plugin.
 * @param id - the row's id.
 * @returns true for six to eight lowercase hexadecimal digits.
 */
export function isGeneratedRowId(id: string): boolean {
  return /^[0-9a-f]{6,8}$/u.test(id)
}

/**
 * The plugins the CLI profile protects: the `protectedPlugins` of its `plugin-manager` row, whose guard, consent and
 * sandbox rows the `plugin_manager` tool may not disable or reconfigure.
 * @param rows - the Loader's rows.
 * @returns the plugin names, read as the reach policy reads them (`protectedPluginsIn`); none when no `plugin-manager`
 * row names any or its list is not a list of names.
 */
export function protectedPluginsOf(rows: readonly BootedRow[]): ReadonlySet<string> {
  return protectedPluginsIn(rows.find(row => row.id === 'plugin-manager')?.config) ?? new Set()
}

/**
 * JSON with each object's keys in sorted order, so the same config always gives the same text.
 * @param value - the value.
 * @returns the text.
 */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value !== null && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(',')}}`
  return JSON.stringify(value) ?? 'null'
}

/**
 * The rows a Host had at boot as the next release's health check compares them: id, plugin, whether the Loader made
 * the id up, and the config hash of a protected plugin's row. The sandbox row's hash leaves out its protection
 * ({@link settingsBeyondProtection}), which H3 compares on its own ({@link bootProtectionOf}).
 * @param rows - the Loader's rows.
 * @returns the rows.
 */
export function bootRowsOf(rows: readonly BootedRow[]): BootRow[] {
  const protectedPlugins = protectedPluginsOf(rows)
  return rows.map(row => ({
    id: row.id,
    name: row.name,
    generated: isGeneratedRowId(row.id),
    ...protectedPlugins.has(row.name) ? { configHash: createHash('sha256').update(canonicalJson((row.id === SANDBOX_ROW ? settingsBeyondProtection(row.config) : row.config) ?? null)).digest('hex') } : {},
  }))
}

/**
 * The rows that were disabled or did not load at boot: disabled, failed, pending or not imported, which the next
 * release's health check allows.
 * @param rows - the Loader's rows.
 * @returns those rows, as {@link bootRowsOf} describes them.
 */
export function inactiveRows(rows: readonly BootedRow[]): BootRow[] {
  const inactive = new Set(rows.filter(row => row.disabled || row.state !== 'active').map(row => row.id))
  return bootRowsOf(rows).filter(row => inactive.has(row.id))
}

/**
 * The protection a Host's sandbox row booted with, as the next release's H3 holds its own to: without the sockets only
 * the Host's start denied, found on the computer and listed by no layer, which the next start may find otherwise.
 * @param rows - the Loader's rows.
 * @param observed - the sockets to leave out: only the start's, or none to keep every socket the row denies.
 * @returns the protection, or `undefined` without a sandbox row that names a protected home.
 */
export function bootProtectionOf(rows: readonly BootedRow[], observed: readonly string[]): HostProtection | undefined {
  return hostProtectionOf(rows.find(row => row.id === SANDBOX_ROW)?.config, observed)
}

/**
 * Take one row of a plugin from a count of unclaimed rows.
 * @param pool - unclaimed rows by plugin.
 * @param name - the plugin.
 * @returns true when one was left.
 */
function claim(pool: Map<string, number>, name: string): boolean {
  const left = pool.get(name) ?? 0
  if (left === 0) return false
  pool.set(name, left - 1)
  return true
}

/**
 * Count rows by plugin.
 * @param rows - the rows.
 * @returns the count of each plugin's rows.
 */
function countByPlugin(rows: readonly { readonly name: string }[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const row of rows) counts.set(row.name, (counts.get(row.name) ?? 0) + 1)
  return counts
}

/**
 * Contract C3's health check over a booted Host.
 * @param facts - the rows, the studio's listener, the profile and the runtime check.
 * @param expect - what the report predicted, or `undefined` for H1 and H2 alone.
 * @returns the verdict, naming the first criterion that failed.
 */
export async function checkHealth(facts: HostHealthFacts, expect: HealthExpectations | undefined): Promise<HealthVerdict> {
  try {
    await facts.verifyRuntime()
  } catch (error) {
    return { passed: false, criterion: 'H1-release-verified', detail: error instanceof Error ? error.message : String(error) }
  }
  const studio = facts.studio()
  if (studio === undefined) return { passed: false, criterion: 'H2-host-ready', detail: 'the Host has no studio listener' }
  try {
    const answer = await fetch(studioHealthUrl(studio), { signal: AbortSignal.timeout(STUDIO_HEALTH_TIMEOUT_MS) })
    await answer.body?.cancel()
    if (answer.status !== 204) return { passed: false, criterion: 'H2-host-ready', detail: `the studio listener's health route answered ${String(answer.status)}` }
  } catch (error) {
    return { passed: false, criterion: 'H2-host-ready', detail: `the studio listener's health route did not answer: ${error instanceof Error ? error.message : String(error)}` }
  }
  if (expect === undefined) return { passed: true }
  // The report names a row by its patch id, or by its plugin when the patch gives it none; it disables plugins by name.
  const named = new Set(expect.namedRows)
  const disabledPlugins = new Set(expect.disabledPlugins)
  // A bundle-patch item names its row by id alone: its id may equal a plugin name that other rows load.
  const bundleRows = new Set(expect.bundleRows ?? [])
  const reported = (row: { readonly id: string, readonly name: string }): boolean => named.has(row.id) || named.has(row.name) || bundleRows.has(row.id) || disabledPlugins.has(row.name)
  const target = bootRowsOf(facts.rows())
  const failedBefore = new Set(expect.previousFailures.map(row => row.id))
  // A row the Loader gave a new id is matched by its plugin, one previous row for one target row; no other row is.
  const failedSpares = countByPlugin(expect.previousFailures.filter(row => row.generated))
  for (const row of facts.rows()) {
    if (!row.disabled && row.state === 'active') continue
    if (reported(row) || failedBefore.has(row.id)) continue
    if (isGeneratedRowId(row.id) && claim(failedSpares, row.name)) continue
    return row.disabled
      ? { passed: false, criterion: 'H3-only-named-disabled', detail: `row ${row.id} is disabled and the report did not name it` }
      : { passed: false, criterion: 'H4-unnamed-rows-load', detail: `row ${row.id} did not load (${row.state}) and the report did not name it` }
  }
  const present = new Map(target.map(row => [row.id, row]))
  const previousIds = new Set(expect.previousRows.map(row => row.id))
  const spares = countByPlugin(target.filter(row => row.generated && !previousIds.has(row.id)))
  for (const row of expect.previousRows) {
    const now = present.get(row.id)
    if (now !== undefined) {
      if (row.configHash !== undefined && now.configHash !== row.configHash && !reported(row)) {
        return { passed: false, criterion: 'H3-only-named-disabled', detail: `the settings of protected row ${row.id} changed and the report did not name it` }
      }
      continue
    }
    if (reported(row)) continue
    if (row.generated && claim(spares, row.name)) continue
    return { passed: false, criterion: 'H3-only-named-disabled', detail: `row ${row.id} was in the profile before the update, is gone, and the report did not name it or disable its plugin` }
  }
  if (expect.previousProtection !== undefined) {
    // Every socket the target's row denies counts, those its start found on the computer included; a report cannot excuse a weaker one.
    const now = bootProtectionOf(facts.rows(), [])
    const weaker = now === undefined ? ['sets no protected home'] : protectionWeakenings(expect.previousProtection, now)
    if (weaker.length > 0) return { passed: false, criterion: 'H3-only-named-disabled', detail: `the ${SANDBOX_ROW} row's protection is weaker than before the update: it ${weaker.join('; it ')}` }
  }
  if (expect.bundles !== undefined) {
    const path = join(facts.profileDir, 'package.json')
    const manifest: unknown = JSON.parse(await readFile(path, 'utf8'))
    const bundles = bundleListOf(manifest, path)
    if (bundles.length !== expect.bundles.length || bundles.some((bundle, at) => expect.bundles?.[at] !== bundle)) {
      return { passed: false, criterion: 'H5-bundle-list-predicted', detail: `the bundle list is ${bundles.join(', ')}; the report predicted ${expect.bundles.join(', ')}` }
    }
  }
  return { passed: true }
}
