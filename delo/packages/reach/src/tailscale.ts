/**
 * Every `tailscale` invocation the reach provider makes, through an injected runner, and what it reads from the
 * answers (contract C7, "Tailscale serve target").
 *
 * - The runner starts `tailscale` itself with an argument list, never a shell and never `sudo`. When the person's user
 *   may not configure `tailscale serve`, the provider prints {@link TAILSCALE_OPERATOR_COMMAND} for the person to run.
 * - `tailscale version` answers whether Tailscale is installed; `tailscale status --json` whether it runs and is logged
 *   in, this machine's `ts.net` name, and whether the tailnet has HTTPS certificates on.
 * - The serve target is configured with `tailscale serve --bg --https=<servePort> http://127.0.0.1:<listenerPort>` and
 *   removed with `tailscale serve --https=<servePort> off`.
 * - `tailscale serve status --json` prints tailscaled's serve configuration, the JSON of Go's `ipn.ServeConfig`
 *   (tailscale/tailscale `ipn/serve.go`; `cmd/tailscale/cli/serve_legacy.go` `runServeStatus` marshals it, so an empty
 *   configuration prints `{}` and none prints `null`). {@link readServeRules} reads the fields for one `<host>:<port>`:
 *   `TCP["<port>"]` with `HTTPS`, `HTTP` or `TCPForward`, `Web["<host>:<port>"].Handlers` keyed by mount point with a
 *   `Proxy` target, `AllowFunnel["<host>:<port>"]`, and the same fields in each `Foreground` session's configuration.
 *
 * @module @delo/reach/tailscale
 */
import { execFile } from 'node:child_process'
import { REACH_LISTENER_BIND_HOST } from '@delo/contract-admission'
import { TAILSCALE_OPERATOR_COMMAND, type ReachErrorCode } from '@delo/contract-reach-providers'

/** What one `tailscale` invocation answered. */
export interface TailscaleResult {
  /** The exit code; `null` when the process did not start, which a missing binary causes. */
  readonly code: number | null
  readonly stdout: string
  readonly stderr: string
}

/** Runs `tailscale` with an argument list. */
export type TailscaleRunner = (args: readonly string[]) => Promise<TailscaleResult>

/** A provider refusal with C7's code and the sentence a person reads. */
export class ReachError extends Error {
  /**
   * @param code - C7's code.
   * @param detail - the sentence, which names what to do.
   */
  constructor(readonly code: ReachErrorCode, readonly detail: string) {
    super(`${code}: ${detail}`)
    this.name = 'ReachError'
  }
}

/**
 * The runner that starts the system's `tailscale` without a shell.
 * @param binary - the executable, `tailscale` on the person's path.
 * @param timeoutMs - the longest one invocation may take.
 * @returns the runner.
 */
export function systemTailscale(binary = 'tailscale', timeoutMs = 15_000): TailscaleRunner {
  return args => new Promise((resolve) => {
    execFile(binary, [...args], { timeout: timeoutMs, shell: false, windowsHide: true }, (error, stdout, stderr) => {
      const code = error === null ? 0 : typeof error.code === 'number' ? error.code : null
      resolve({ code, stdout, stderr })
    })
  })
}

/** What the provider reads from Tailscale before it turns reach on. */
export interface TailscaleFacts {
  /** This machine's `ts.net` name, without the trailing dot. */
  readonly dnsName: string
}

/**
 * Check that Tailscale is installed, runs, is logged in and has HTTPS certificates on for this machine.
 * @param run - the runner.
 * @returns this machine's `ts.net` name.
 * @throws {ReachError} `TAILSCALE_NOT_INSTALLED`, `TAILSCALE_NOT_LOGGED_IN` or `TAILSCALE_HTTPS_DISABLED`.
 */
export async function readTailscale(run: TailscaleRunner): Promise<TailscaleFacts> {
  const version = await run(['version'])
  if (version.code === null) {
    throw new ReachError('TAILSCALE_NOT_INSTALLED', 'Tailscale is not installed on this computer. Install it from tailscale.com/download, sign in, and try again')
  }
  const status = await run(['status', '--json'])
  const parsed = parseStatus(status.stdout)
  if (status.code !== 0 || parsed === undefined || parsed.backendState !== 'Running' || parsed.dnsName === '') {
    throw new ReachError('TAILSCALE_NOT_LOGGED_IN', 'Tailscale is not running and signed in to a tailnet on this computer. Run tailscale up, sign in, and try again')
  }
  if (!parsed.certDomains.includes(parsed.dnsName)) {
    throw new ReachError('TAILSCALE_HTTPS_DISABLED', 'Your tailnet does not have HTTPS certificates turned on. Turn on HTTPS in the DNS page of the Tailscale admin console, then try again')
  }
  return { dnsName: parsed.dnsName }
}

/**
 * The serve target this home configures: its fixed listener port on `127.0.0.1`.
 * @param listenerPort - the fixed listener port.
 * @returns `http://127.0.0.1:<listenerPort>`.
 */
export function serveTarget(listenerPort: number): string {
  return `http://${REACH_LISTENER_BIND_HOST}:${String(listenerPort)}`
}

/**
 * Configure the serve target.
 * @param run - the runner.
 * @param servePort - the port Tailscale serves HTTPS on.
 * @param port - the fixed listener port on `127.0.0.1`.
 * @throws {ReachError} `TAILSCALE_SERVE_NOT_PERMITTED` with the one command to run when the person's user may not
 *   configure it; `TAILSCALE_NOT_LOGGED_IN` for any other failure.
 */
export async function serve(run: TailscaleRunner, servePort: number, port: number): Promise<void> {
  const result = await run(['serve', '--bg', `--https=${String(servePort)}`, serveTarget(port)])
  if (result.code === 0) return
  if (isPermissionRefusal(result.stderr)) {
    throw new ReachError('TAILSCALE_SERVE_NOT_PERMITTED', `Your user may not configure tailscale serve yet. Run this once yourself, then try again: ${TAILSCALE_OPERATOR_COMMAND}`)
  }
  throw new ReachError('TAILSCALE_NOT_LOGGED_IN', `tailscale serve failed: ${firstLine(result.stderr)}`)
}

/** What `tailscale serve status --json` says about one `<host>:<port>`. */
export interface ServeRules {
  /** Whether Tailscale serves anything on the port, in the background configuration or a foreground session's. */
  readonly present: boolean
  /**
   * Whether what it serves there is exactly this home's rule: HTTPS on the port, in the background configuration only,
   * with the one mount point `/` proxying to the expected target.
   */
  readonly own: boolean
  /** Whether Funnel is allowed for `<host>:<port>`, in any configuration. */
  readonly funnel: boolean
  /** The `tailscale serve` flag that removes the port's background rule: `--https=`, `--http=` or `--tcp=` with the port. */
  readonly removal: string
}

/**
 * Read what Tailscale serves on one `<host>:<port>`.
 * @param run - the runner.
 * @param host - this machine's `ts.net` name.
 * @param servePort - the port.
 * @param target - this home's serve target, {@link serveTarget}.
 * @returns the rules.
 * @throws {ReachError} `TAILSCALE_NOT_INSTALLED` when `tailscale` does not start, `TAILSCALE_SERVE_NOT_PERMITTED` when
 *   the person's user may not read the serve configuration, and `TAILSCALE_NOT_LOGGED_IN` for any other failure or
 *   output that is not the configuration's JSON.
 */
export async function readServeRules(run: TailscaleRunner, host: string, servePort: number, target: string): Promise<ServeRules> {
  const result = await run(['serve', 'status', '--json'])
  if (result.code === null) {
    throw new ReachError('TAILSCALE_NOT_INSTALLED', 'Tailscale is not installed on this computer. Install it from tailscale.com/download, sign in, and try again')
  }
  if (result.code !== 0 && isPermissionRefusal(result.stderr)) {
    throw new ReachError('TAILSCALE_SERVE_NOT_PERMITTED', `Your user may not configure tailscale serve yet. Run this once yourself, then try again: ${TAILSCALE_OPERATOR_COMMAND}`)
  }
  const rules = result.code === 0 ? parseServeRules(result.stdout, host, servePort, target) : undefined
  if (rules === undefined) {
    throw new ReachError('TAILSCALE_NOT_LOGGED_IN', `tailscale serve status failed: ${firstLine(result.code === 0 ? 'its output is not the serve configuration' : result.stderr)}`)
  }
  return rules
}

/**
 * Remove whatever Tailscale serves on one `<host>:<port>`, and read the configuration again to confirm it is gone.
 * Nothing runs when nothing is served there.
 * @param run - the runner.
 * @param host - this machine's `ts.net` name.
 * @param servePort - the port.
 * @param target - this home's serve target.
 * @throws {ReachError} `TAILSCALE_SERVE_CONFLICT` naming the command to run when the removal fails or the port is
 *   still served after it; a refusal of {@link readServeRules} when the configuration cannot be read.
 */
export async function removeServe(run: TailscaleRunner, host: string, servePort: number, target: string): Promise<void> {
  const before = await readServeRules(run, host, servePort, target)
  if (!before.present) return
  const command = ['serve', before.removal, 'off']
  const removed = await run(command)
  if (removed.code !== 0) {
    throw new ReachError('TAILSCALE_SERVE_CONFLICT', `tailscale ${command.join(' ')} failed (${firstLine(removed.stderr)}), so Tailscale may still serve ${host}:${String(servePort)}. Run it yourself, or stop the tailscale serve or funnel that holds the port`)
  }
  const after = await readServeRules(run, host, servePort, target)
  if (after.present) {
    throw new ReachError('TAILSCALE_SERVE_CONFLICT', `Tailscale still serves ${host}:${String(servePort)} after tailscale ${command.join(' ')}. Stop the tailscale serve or funnel running in a terminal that holds the port, then try again`)
  }
}

/**
 * Whether `tailscale serve` refused for lack of permission, as it does on Linux when the user is not the operator.
 * @param stderr - its standard error.
 * @returns whether it names an access refusal.
 */
export function isPermissionRefusal(stderr: string): boolean {
  return /access denied|permission denied|operator|not permitted/i.test(stderr)
}

/**
 * The fields of `tailscale status --json` the provider reads.
 * @param text - the output.
 * @returns the fields, or undefined when the output is not that JSON.
 */
function parseStatus(text: string): { readonly backendState: string; readonly dnsName: string; readonly certDomains: readonly string[] } | undefined {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    // Output that is not JSON is a Tailscale that cannot answer, which the caller reports as not running.
    return undefined
  }
  if (typeof value !== 'object' || value === null) return undefined
  const backendState = Reflect.get(value, 'BackendState')
  const self: unknown = Reflect.get(value, 'Self')
  const dns = typeof self === 'object' && self !== null ? Reflect.get(self, 'DNSName') : undefined
  const domains: unknown = Reflect.get(value, 'CertDomains')
  return {
    backendState: typeof backendState === 'string' ? backendState : '',
    dnsName: typeof dns === 'string' ? dns.replace(/\.$/, '').toLowerCase() : '',
    certDomains: Array.isArray(domains) ? domains.filter((domain): domain is string => typeof domain === 'string').map(domain => domain.toLowerCase()) : [],
  }
}

/**
 * Read one `<host>:<port>`'s rules from `tailscale serve status --json`.
 * @param text - the output.
 * @param host - this machine's `ts.net` name.
 * @param servePort - the port.
 * @param target - this home's serve target.
 * @returns the rules, or undefined when the output is not that JSON.
 */
export function parseServeRules(text: string, host: string, servePort: number, target: string): ServeRules | undefined {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    // Output that is not JSON is a Tailscale that cannot answer, which the caller reports.
    return undefined
  }
  // `null` is the JSON of an absent configuration.
  if (value === null) return { present: false, own: false, funnel: false, removal: `--https=${String(servePort)}` }
  if (typeof value !== 'object' || Array.isArray(value)) return undefined
  const hostPort = `${host.toLowerCase()}:${String(servePort)}`
  const background = portRules(value, hostPort, String(servePort))
  const foreground: unknown = Reflect.get(value, 'Foreground')
  const sessions = isRecord(foreground) ? Object.values(foreground).filter(isRecord).map(config => portRules(config, hostPort, String(servePort))) : []
  const handlers = background.handlers
  const own = background.tcp !== undefined && Reflect.get(background.tcp, 'HTTPS') === true && !hasForward(background.tcp)
    && handlers.length === 1 && handlers[0]?.[0] === '/' && proxyOf(handlers[0][1]) === target
    && sessions.every(session => !session.present)
  return {
    present: background.present || sessions.some(session => session.present),
    own,
    funnel: background.funnel || sessions.some(session => session.funnel),
    removal: `--${removalKind(background.tcp)}=${String(servePort)}`,
  }
}

/**
 * The `tailscale serve` flag kind whose `off` removes a port's background rule: `tcp` for a TCP forward (with or without
 * TLS termination, which `serve --tcp=<port> off` and `--tls-terminated-tcp` remove alike), `http` for plain HTTP, and
 * `https` otherwise.
 * @param tcp - the port's `TCP` entry, if any.
 * @returns the flag kind.
 */
function removalKind(tcp: object | undefined): 'tcp' | 'http' | 'https' {
  if (tcp === undefined) return 'https'
  if (hasForward(tcp)) return 'tcp'
  return Reflect.get(tcp, 'HTTPS') !== true && Reflect.get(tcp, 'HTTP') === true ? 'http' : 'https'
}

/** One configuration's entries for a `<host>:<port>`. */
interface PortRules {
  readonly present: boolean
  readonly funnel: boolean
  /** `TCP["<port>"]`, when the configuration has it. */
  readonly tcp: object | undefined
  /** `Web["<host>:<port>"].Handlers` as mount point and handler pairs. */
  readonly handlers: readonly (readonly [string, unknown])[]
}

/**
 * One configuration's entries for a `<host>:<port>`; the `Web` and `AllowFunnel` keys compare in lower case.
 * @param config - an `ipn.ServeConfig` object.
 * @param hostPort - `<host>:<port>` in lower case.
 * @param port - the port's decimal text, the `TCP` key.
 * @returns the entries.
 */
function portRules(config: object, hostPort: string, port: string): PortRules {
  const tcpMap: unknown = Reflect.get(config, 'TCP')
  const tcpEntry: unknown = isRecord(tcpMap) ? tcpMap[port] : undefined
  const tcp = isRecord(tcpEntry) ? tcpEntry : undefined
  const web = entryFor(Reflect.get(config, 'Web'), hostPort)
  const handlerMap: unknown = isRecord(web) ? web.Handlers : undefined
  const handlers = isRecord(handlerMap) ? Object.entries(handlerMap) : []
  return { present: tcp !== undefined || handlers.length > 0, funnel: entryFor(Reflect.get(config, 'AllowFunnel'), hostPort) === true, tcp, handlers }
}

/**
 * The value of a map keyed by `<host>:<port>`, comparing keys in lower case.
 * @param map - the map.
 * @param hostPort - `<host>:<port>` in lower case.
 * @returns the value, or undefined.
 */
function entryFor(map: unknown, hostPort: string): unknown {
  if (!isRecord(map)) return undefined
  return Object.entries(map).find(([key]) => key.toLowerCase() === hostPort)?.[1]
}

/**
 * Whether a `TCP` entry forwards raw TCP.
 * @param tcp - the entry.
 * @returns whether `TCPForward` is set.
 */
function hasForward(tcp: object): boolean {
  const forward: unknown = Reflect.get(tcp, 'TCPForward')
  return typeof forward === 'string' && forward !== ''
}

/**
 * A handler's proxy target without a trailing slash.
 * @param handler - a `Handlers` value.
 * @returns the target, or undefined for a handler that proxies nothing.
 */
function proxyOf(handler: unknown): string | undefined {
  const proxy: unknown = isRecord(handler) ? handler.Proxy : undefined
  return typeof proxy === 'string' ? proxy.replace(/\/$/, '') : undefined
}

/**
 * Whether a JSON value is an object that is not an array.
 * @param value - the value.
 * @returns whether it is.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * The first line of a text, for a refusal that quotes a tool's error.
 * @param text - the text.
 * @returns its first non-empty line, at most 200 characters.
 */
function firstLine(text: string): string {
  return (text.split('\n').find(line => line.trim() !== '') ?? 'no reason given').trim().slice(0, 200)
}
