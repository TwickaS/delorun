/**
 * Every `tailscale` invocation the reach provider makes, through an injected runner, and what it reads from the
 * answers (contract C7, "Tailscale serve target").
 *
 * - The runner starts `tailscale` itself with an argument list, never a shell and never `sudo`. When the person's user
 *   may not configure `tailscale serve`, the provider prints {@link TAILSCALE_OPERATOR_COMMAND} for the person to run.
 * - `tailscale version` answers whether Tailscale is installed; `tailscale status --json` whether it runs and is logged
 *   in, this machine's `ts.net` name, and whether the tailnet has HTTPS certificates on.
 * - The serve target is configured with `tailscale serve --bg --https=<servePort> http://127.0.0.1:<bound port>` and
 *   removed with `tailscale serve --https=<servePort> off`.
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
 * Configure the serve target.
 * @param run - the runner.
 * @param servePort - the port Tailscale serves HTTPS on.
 * @param port - the reach listener's bound port on `127.0.0.1`.
 * @throws {ReachError} `TAILSCALE_SERVE_NOT_PERMITTED` with the one command to run when the person's user may not
 *   configure it; `TAILSCALE_NOT_LOGGED_IN` for any other failure.
 */
export async function serve(run: TailscaleRunner, servePort: number, port: number): Promise<void> {
  const result = await run(['serve', '--bg', `--https=${String(servePort)}`, `http://${REACH_LISTENER_BIND_HOST}:${String(port)}`])
  if (result.code === 0) return
  if (isPermissionRefusal(result.stderr)) {
    throw new ReachError('TAILSCALE_SERVE_NOT_PERMITTED', `Your user may not configure tailscale serve yet. Run this once yourself, then try again: ${TAILSCALE_OPERATOR_COMMAND}`)
  }
  throw new ReachError('TAILSCALE_NOT_LOGGED_IN', `tailscale serve failed: ${firstLine(result.stderr)}`)
}

/**
 * Remove the serve target.
 * @param run - the runner.
 * @param servePort - the port Tailscale serves HTTPS on.
 * @returns whether Tailscale accepted the removal.
 */
export async function unserve(run: TailscaleRunner, servePort: number): Promise<boolean> {
  return (await run(['serve', `--https=${String(servePort)}`, 'off'])).code === 0
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
 * The first line of a text, for a refusal that quotes a tool's error.
 * @param text - the text.
 * @returns its first non-empty line, at most 200 characters.
 */
function firstLine(text: string): string {
  return (text.split('\n').find(line => line.trim() !== '') ?? 'no reason given').trim().slice(0, 200)
}
