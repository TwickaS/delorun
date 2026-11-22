/**
 * A Delorun home in a WSL2 distribution, reached through `wsl.exe`: discovery, status and the one-time sign-in link.
 * Every `wsl.exe` call has a deadline, because it can hang with no output while a distribution starts for the first time
 * or the WSL service is stuck. The sign-in link is read from the child's stdout, never placed on a command line, and
 * never written to a log or an error message (F24, A604).
 */

import { spawn } from 'node:child_process'
import { isUsableDistroName } from './home-source.ts'

/** Deadlines of the `wsl.exe` calls, in milliseconds. */
export const WSL_TIMEOUTS_MS = { list: 10_000, shell: 10_000, status: 20_000, link: 20_000 } as const

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
  /** Stable failure code. */
  readonly code: WslHomeFailure
  /** Safe extra text for the page. */
  readonly detail: Readonly<Record<string, string>>

  /**
   * @param code - Stable failure code.
   * @param detail - Safe extra text for the page, such as a distribution or version name.
   * @param options - The original error, kept for crash reports.
   */
  constructor(code: WslHomeFailure, detail: Readonly<Record<string, string>> = {}, options?: ErrorOptions) {
    super(`desktop WSL home: ${code}`, options)
    this.code = code
    this.detail = detail
  }
}

/**
 * Run `wsl.exe` with a deadline and no Windows shell.
 * @param args - Arguments, passed one by one.
 * @param timeoutMs - Deadline; the call rejects on its own timer and kills the child, without waiting for the child's
 *   output pipe to close, which a process that `wsl.exe` started can keep open.
 * @returns exit code and standard output.
 * @throws {WslHomeError} `wsl-unavailable` when `wsl.exe` cannot start, `wsl-timeout` when the deadline passes or the output is too long.
 */
export const runWsl: WslRunner = (args, timeoutMs) => new Promise((resolve, reject) => {
  const child = spawn('wsl.exe', [...args], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true })
  const chunks: Buffer[] = []
  let size = 0
  let settled = false
  const fail = (error: WslHomeError): void => {
    if (settled) return
    settled = true
    clearTimeout(timer)
    child.kill('SIGKILL')
    reject(error)
  }
  // The deadline is our own timer, not a signal check: Windows does not always report the signal that ended a child.
  const timer = setTimeout(() => { fail(new WslHomeError('wsl-timeout')) }, timeoutMs)
  child.stdout.on('data', (chunk: Buffer) => {
    size += chunk.length
    if (size > MAX_OUTPUT_BYTES) { fail(new WslHomeError('wsl-timeout')); return }
    if (!settled) chunks.push(chunk)
  })
  child.once('error', (error) => { fail(new WslHomeError('wsl-unavailable', {}, { cause: error })) })
  child.once('close', (code) => {
    if (settled) return
    settled = true
    clearTimeout(timer)
    resolve({ code, stdout: Buffer.concat(chunks) })
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

/**
 * How the app starts `delorun` in a distribution. `direct` runs it with `--exec`, so no shell parses anything and the
 * PATH is the bare one `wsl.exe` hands over. A `delorun` that `npm install -g` put under a version manager such as nvm is
 * on the PATH only through the person's shell start-up files, so the app falls back to the person's own login shell
 * (`login-shell`), which loads them.
 */
export type DelorunLauncher =
  | { readonly kind: 'direct' }
  | { readonly kind: 'login-shell'; readonly shell: LoginShell }

/** A login shell the app accepts: an absolute path from a short list, and how its `-c` script reads the arguments. */
export interface LoginShell {
  /** Absolute path, one of the accepted shells in `/bin`, `/usr/bin` or `/usr/local/bin`. */
  readonly path: string
  /** `posix` for bash, zsh and sh, which read `$@`; `fish`, which reads `$argv`. */
  readonly flavour: 'posix' | 'fish'
}

/** The launcher used when nothing else is chosen. */
export const DIRECT_LAUNCHER: DelorunLauncher = { kind: 'direct' }

/** The shells the app accepts as a login shell, by absolute path. Anything else, `nologin` and `false` included, is refused. */
const LOGIN_SHELL_PATH = /^\/(?:bin|usr\/bin|usr\/local\/bin)\/(bash|zsh|sh|fish)$/u

/** An account name as `id -un` prints it; anything else is not passed to `getent`. */
const ACCOUNT_NAME = /^[a-z_][a-z0-9_-]{0,31}$/u

/**
 * The fixed `-c` script of each flavour. It holds no quote, no variable the app sets and no text from the person: the
 * arguments follow it as positional parameters, which the shell does not parse, and `wsl.exe` has no quote to misread.
 */
const SHELL_SCRIPT = { posix: 'exec delorun $@', fish: 'exec delorun $argv' } as const

/**
 * Read the login shell from an entry of the account database (`name:x:uid:gid:gecos:home:shell`).
 * @param entry - One line of `getent passwd <name>` output.
 * @param account - The account name the entry must be for.
 * @returns the shell, or `undefined` when the entry is malformed, is for another account, or names a shell outside the list.
 */
export function parseLoginShell(entry: string, account: string): LoginShell | undefined {
  const fields = entry.trim().split(':')
  if (fields.length < 7 || fields[0] !== account) return undefined
  const path = fields[6] ?? ''
  const match = LOGIN_SHELL_PATH.exec(path)
  if (match === null) return undefined
  return { path, flavour: match[1] === 'fish' ? 'fish' : 'posix' }
}

/**
 * Find the login shell of the distribution's default account, without any shell: `id -un`, then `getent passwd <name>`.
 * @param distro - Distribution name; it is listed and matches the strict pattern.
 * @param run - How `wsl.exe` is run.
 * @returns the shell, or `undefined` when the account or its shell is not one the app accepts.
 * @throws {WslHomeError} the `wsl.exe` failures.
 */
export async function findLoginShell(distro: string, run: WslRunner = runWsl): Promise<LoginShell | undefined> {
  const who = await run(['-d', distro, '--exec', 'id', '-un'], WSL_TIMEOUTS_MS.shell)
  const account = who.stdout.toString('utf8').trim()
  if (who.code !== 0 || !ACCOUNT_NAME.test(account)) return undefined
  const entry = await run(['-d', distro, '--exec', 'getent', 'passwd', account], WSL_TIMEOUTS_MS.shell)
  return entry.code === 0 ? parseLoginShell(entry.stdout.toString('utf8').split(/\r?\n/u)[0] ?? '', account) : undefined
}

/**
 * The arguments that run `delorun <command…>` in a distribution and profile. The distribution and profile names match
 * strict patterns before they get here, so every argument after the script is a word of letters, digits, `.`, `_` and `-`.
 * The login shell is started interactively as well as as a login shell, because the lines that put nvm on the PATH usually
 * sit below the guard that stops a non-interactive `~/.bashrc` early.
 * @param distro - Distribution name.
 * @param profile - Delorun profile name.
 * @param command - The `delorun` arguments before `--profile`; constants.
 * @param launcher - How `delorun` is started.
 * @returns the `wsl.exe` arguments.
 */
export function delorunArgs(
  distro: string, profile: string, command: readonly string[], launcher: DelorunLauncher = DIRECT_LAUNCHER,
): string[] {
  const words = [...command, '--profile', profile]
  if (launcher.kind === 'direct') return ['-d', distro, '--exec', 'delorun', ...words]
  // POSIX shells take the program name as the word after the script (`$0`); fish takes none.
  return ['-d', distro, '--exec', launcher.shell.path, '-l', '-i', '-c', SHELL_SCRIPT[launcher.shell.flavour],
    ...launcher.shell.flavour === 'fish' ? [] : ['delorun'], ...words]
}

/** The last line of a text that starts a JSON object: an interactive shell can print noise before it. */
function lastJsonLine(text: string): string {
  return text.split(/\r?\n/u).findLast(line => line.trimStart().startsWith('{')) ?? ''
}

/**
 * Ask a distribution's home for its status.
 * @param distro - Distribution name.
 * @param profile - Delorun profile name.
 * @param run - How `wsl.exe` is run.
 * @param launcher - How `delorun` is started.
 * @returns the home's status.
 * @throws {WslHomeError} `distro-missing`, `delorun-missing`, `status-unreadable` or the `wsl.exe` failures.
 */
export async function readHomeStatus(
  distro: string, profile: string, run: WslRunner = runWsl, launcher: DelorunLauncher = DIRECT_LAUNCHER,
): Promise<WslHomeStatus> {
  const result = await run(delorunArgs(distro, profile, ['status', '--json'], launcher), WSL_TIMEOUTS_MS.status)
  const text = result.stdout.toString('utf8')
  const status = parseHomeStatus(text) ?? parseHomeStatus(lastJsonLine(text))
  if (status !== undefined) return status
  // `wsl.exe` answers 1 (a Windows error, in UTF-16 text we do not read) when the distribution does not exist; a shell
  // answers 127 when `delorun` is not on its PATH.
  if (result.code === 127) throw new WslHomeError('delorun-missing', { distro })
  if ((await listDistros(run)).includes(distro)) throw new WslHomeError('status-unreadable', { distro })
  throw new WslHomeError('distro-missing', { distro })
}

/**
 * Read the status and choose how `delorun` is started: directly first, then through the person's login shell when the
 * direct start finds no `delorun` or no status. A hostile or unknown shell is never run.
 * @param distro - Distribution name.
 * @param profile - Delorun profile name.
 * @param run - How `wsl.exe` is run.
 * @returns the status and the launcher that produced it.
 * @throws {WslHomeError} the failure of the last attempt: `delorun-missing`, `status-unreadable` or the `wsl.exe` failures.
 */
export async function selectLauncher(
  distro: string, profile: string, run: WslRunner = runWsl,
): Promise<{ readonly status: WslHomeStatus; readonly launcher: DelorunLauncher }> {
  try { return { status: await readHomeStatus(distro, profile, run, DIRECT_LAUNCHER), launcher: DIRECT_LAUNCHER } } catch (error) {
    if (!(error instanceof WslHomeError) || (error.code !== 'delorun-missing' && error.code !== 'status-unreadable')) throw error
    const shell = await findLoginShell(distro, run)
    if (shell === undefined) throw error
    const launcher: DelorunLauncher = { kind: 'login-shell', shell }
    return { status: await readHomeStatus(distro, profile, run, launcher), launcher }
  }
}

/**
 * Whether a printed link is a one-time sign-in link for the home's own loopback studio address.
 * @param line - One line of `delorun open --print`'s output.
 * @param studio - The studio address `delorun status --json` reported.
 * @returns the link, or `undefined` when it is for another origin, carries no query or is not an http link.
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
 * and not logged. It is the caller's to use once and drop. The link is the last line that is a link for the studio's own
 * address; any other line, such as text a start-up file prints, is ignored.
 * @param distro - Distribution name.
 * @param profile - Delorun profile name.
 * @param studio - The studio address `delorun status --json` reported; the link must be for the same origin.
 * @param run - How `wsl.exe` is run.
 * @param launcher - How `delorun` is started.
 * @returns the link.
 * @throws {WslHomeError} `home-not-running` (exit 3), `link-refused` or `link-unusable`; none carries the link.
 */
export async function readSignInLink(
  distro: string, profile: string, studio: string, run: WslRunner = runWsl, launcher: DelorunLauncher = DIRECT_LAUNCHER,
): Promise<string> {
  const result = await run(delorunArgs(distro, profile, ['open', '--print'], launcher), WSL_TIMEOUTS_MS.link)
  if (result.code === 3) throw new WslHomeError('home-not-running', { distro })
  if (result.code !== 0) throw new WslHomeError('link-refused', { distro })
  const link = result.stdout.toString('utf8').split(/\r?\n/u).map(line => acceptLink(line, studio))
    .findLast(accepted => accepted !== undefined)
  if (link === undefined) throw new WslHomeError('link-unusable', { distro })
  return link
}

/**
 * Require that a distribution is one `wsl.exe -l -q` lists, by its exact name, before anything runs in it.
 * @param distro - Distribution name.
 * @param run - How `wsl.exe` is run.
 * @throws {WslHomeError} `distro-missing` when the list does not hold the name, or the `wsl.exe` failures.
 */
export async function requireListedDistro(distro: string, run: WslRunner = runWsl): Promise<void> {
  if (!(await listDistros(run)).includes(distro)) throw new WslHomeError('distro-missing', { distro })
}
