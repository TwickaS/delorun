/**
 * A Delorun home in a WSL2 distribution, reached through `wsl.exe`: discovery, status and the one-time sign-in link.
 * Every `wsl.exe` call has a deadline, because it can hang with no output while a distribution starts for the first time
 * or the WSL service is stuck. The sign-in link is read from the child's stdout, never placed on a command line, and
 * never written to a log or an error message.
 */

import { spawn } from 'node:child_process'
import { isUsableDistroName } from './home-source.ts'

/** Deadlines of the `wsl.exe` calls, in milliseconds. */
export const WSL_TIMEOUTS_MS = { list: 10_000, status: 20_000, link: 20_000 } as const

/** Most bytes read from one `wsl.exe` call; anything longer is an error, not truncated output. */
const MAX_OUTPUT_BYTES = 1024 * 1024

/** Distributions that Docker Desktop adds and that never hold a Delorun home. */
const SYSTEM_DISTROS: ReadonlySet<string> = new Set(['docker-desktop', 'docker-desktop-data'])

/** The result of one `wsl.exe` call. */
export interface WslResult {
  /** Exit code, or `null` when the process was ended by a signal. */
  readonly code: number | null
  /** Raw standard output. */
  readonly stdout: Buffer
}

/** Runs `wsl.exe`; replaced in specs. */
export type WslRunner = (args: readonly string[], timeoutMs: number) => Promise<WslResult>

/** Why a WSL home could not be opened; each code has its own plain-language page. */
export type WslHomeFailure =
  | 'wsl-unavailable'
  | 'wsl-timeout'
  | 'distro-missing'
  | 'delorun-missing'
  | 'home-not-running'
  | 'status-unreadable'
  | 'link-refused'
  | 'link-unusable'
  | 'exchange-failed'
  | 'forwarding-unreachable'
  | 'version-unreadable'
  | 'home-too-old'
  | 'home-too-new'
  | 'rows-unavailable'

/** A failure with a stable code; `detail` never holds a sign-in link or a cookie. */
export class WslHomeError extends Error {
  /**
   * @param code - Stable failure code.
   * @param detail - Safe extra text for the page, such as a distribution or version name.
   * @param options - The original error, kept for crash reports.
   */
  constructor(readonly code: WslHomeFailure, readonly detail: Readonly<Record<string, string>> = {}, options?: ErrorOptions) {
    super(`desktop WSL home: ${code}`, options)
  }
}

/**
 * Run `wsl.exe` with a deadline and no shell.
 * @param args - Arguments, passed one by one.
 * @param timeoutMs - Deadline; the process is killed when it passes.
 * @returns exit code and standard output.
 * @throws {WslHomeError} `wsl-unavailable` when `wsl.exe` cannot start, `wsl-timeout` when the deadline passes or the output is too long.
 */
export const runWsl: WslRunner = (args, timeoutMs) => new Promise((resolve, reject) => {
  const child = spawn('wsl.exe', [...args], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true })
  const chunks: Buffer[] = []
  let size = 0
  let failed = false
  // The deadline is our own timer, not a signal check: Windows does not always report the signal that ended a child.
  const timer = setTimeout(() => { failed = true; child.kill('SIGKILL') }, timeoutMs)
  child.stdout.on('data', (chunk: Buffer) => {
    size += chunk.length
    if (size > MAX_OUTPUT_BYTES) { failed = true; child.kill('SIGKILL'); return }
    chunks.push(chunk)
  })
  child.once('error', (error) => {
    clearTimeout(timer)
    reject(new WslHomeError('wsl-unavailable', {}, { cause: error }))
  })
  child.once('close', (code) => {
    clearTimeout(timer)
    if (failed) reject(new WslHomeError('wsl-timeout'))
    else resolve({ code, stdout: Buffer.concat(chunks) })
  })
})

/**
 * Read the output of `wsl.exe -l -q`, which is UTF-16 little-endian (usually with a byte-order mark).
 * @param output - Raw standard output.
 * @returns distribution names in the order listed, without Docker Desktop's.
 */
export function parseDistroList(output: Buffer): string[] {
  const start = output.length >= 2 && output[0] === 0xff && output[1] === 0xfe ? 2 : 0
  const text = output.subarray(start).toString('utf16le')
  return text.split(/\r?\n/u).map(line => line.replaceAll('\u0000', '').trim())
    .filter(name => name !== '' && !SYSTEM_DISTROS.has(name) && isUsableDistroName(name))
}

/**
 * List the installed WSL distributions.
 * @param run - How `wsl.exe` is run.
 * @returns distribution names; empty when none is installed.
 * @throws {WslHomeError} when `wsl.exe` cannot start or does not answer in time.
 */
export async function listDistros(run: WslRunner = runWsl): Promise<string[]> {
  const result = await run(['-l', '-q'], WSL_TIMEOUTS_MS.list)
  return result.code === 0 ? parseDistroList(result.stdout) : []
}

/** What the app needs of `delorun status --json`. */
export type WslHomeStatus =
  | { readonly state: 'not-running' }
  | { readonly state: 'running'; readonly version: string; readonly studio: string }

/**
 * Read `delorun status --json`'s output.
 * @param stdout - Output text.
 * @returns the status; `undefined` when the text is not a status answer the app understands.
 */
export function parseHomeStatus(stdout: string): WslHomeStatus | undefined {
  let value: unknown
  try { value = JSON.parse(stdout.trim()) } catch (_error) { return undefined /* not JSON: a shell error message instead of a status */ }
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as Record<string, unknown>
  if (record.ok === false) return record.state === 'not-running' ? { state: 'not-running' } : undefined
  const status = record.status
  if (record.ok !== true || typeof status !== 'object' || status === null) return undefined
  const fields = status as Record<string, unknown>
  const runtime = fields.runtime
  const running = typeof runtime === 'object' && runtime !== null ? (runtime as Record<string, unknown>).running : undefined
  if (typeof running !== 'string' || running === '' || typeof fields.studio !== 'string') return undefined
  return { state: 'running', version: running, studio: fields.studio }
}

/** The arguments that run `delorun <command…>` in a distribution and profile. */
function delorunArgs(distro: string, profile: string, command: readonly string[]): string[] {
  return ['-d', distro, '--', 'delorun', ...command, '--profile', profile]
}

/**
 * Ask a distribution's home for its status.
 * @param distro - Distribution name.
 * @param profile - Delorun profile name.
 * @param run - How `wsl.exe` is run.
 * @returns the home's status.
 * @throws {WslHomeError} `distro-missing`, `delorun-missing`, `status-unreadable` or the `wsl.exe` failures.
 */
export async function readHomeStatus(distro: string, profile: string, run: WslRunner = runWsl): Promise<WslHomeStatus> {
  const result = await run(delorunArgs(distro, profile, ['status', '--json']), WSL_TIMEOUTS_MS.status)
  const status = parseHomeStatus(result.stdout.toString('utf8'))
  if (status !== undefined) return status
  // `wsl.exe` answers 1 (a Windows error, in UTF-16 text we do not read) when the distribution does not exist; the
  // shell answers 127 when `delorun` is not on the PATH of a non-interactive shell.
  if (result.code === 127) throw new WslHomeError('delorun-missing', { distro })
  if ((await listDistros(run)).includes(distro)) throw new WslHomeError('status-unreadable', { distro })
  throw new WslHomeError('distro-missing', { distro })
}

/**
 * Whether a printed link is a one-time sign-in link for the home's own loopback studio address.
 * @param line - First line of `delorun open --print`.
 * @param studio - The studio address `delorun status --json` reported.
 * @returns the link, or `undefined` when it is for another origin, carries no token or is not an http link.
 */
export function acceptLink(line: string, studio: string): string | undefined {
  const link = URL.parse(line.trim())
  const home = URL.parse(studio)
  if (link === null || home === null || link.protocol !== 'http:' || link.hostname !== '127.0.0.1') return undefined
  if (link.origin !== home.origin || link.username !== '' || link.password !== '' || link.search === '') return undefined
  return link.href
}

/**
 * Get a one-time sign-in link from the home. The link crosses only the `wsl.exe` pipe: it is not put on a command line
 * and not logged. It is the caller's to use once and drop.
 * @param distro - Distribution name.
 * @param profile - Delorun profile name.
 * @param studio - The studio address `delorun status --json` reported; the link must be for the same origin.
 * @param run - How `wsl.exe` is run.
 * @returns the link.
 * @throws {WslHomeError} `home-not-running` (exit 3), `link-refused` or `link-unusable`; none carries the link.
 */
export async function readSignInLink(distro: string, profile: string, studio: string, run: WslRunner = runWsl): Promise<string> {
  const result = await run(delorunArgs(distro, profile, ['open', '--print']), WSL_TIMEOUTS_MS.link)
  if (result.code === 3) throw new WslHomeError('home-not-running', { distro })
  if (result.code !== 0) throw new WslHomeError('link-refused', { distro })
  const link = acceptLink(result.stdout.toString('utf8').split(/\r?\n/u)[0] ?? '', studio)
  if (link === undefined) throw new WslHomeError('link-unusable', { distro })
  return link
}
