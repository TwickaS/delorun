/**
 * The four checks `delorun doctor` runs: the Delo home and its private
 * directories (contract C1), the Docker engine's version through one read-only
 * probe (contract C9), the DeepSeek API key's format, and the studio's loopback
 * port. Each check takes its inputs as arguments and returns one
 * {@link CheckResult} whose message is one line. None of them contacts
 * DeepSeek, starts a container, or runs a command other than `docker version`.
 *
 * @module @delo/cli/doctor/checks
 */
import { execFile } from 'node:child_process'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { DELO_HOME_ENTRIES } from '@delo/contract-home-layout'
import { SETUP_DEFAULT_CREDENTIAL_VARIABLE } from '@delo/contract-setup-answers'
import { checkPrivateDirectory, HomeLayoutError, resolveDeloHome, runDirectory, type DeloHome } from '@delo/home'

/** A check's name, as `delorun doctor` prints it. */
export type CheckName = 'home' | 'docker' | 'key' | 'port'

/**
 * A check's verdict. `pass` needs nothing. `warn` names something optional or
 * unverified and leaves the exit code at 0. `fail` names a problem to fix and
 * makes the exit code 1.
 */
export type CheckStatus = 'pass' | 'warn' | 'fail'

/** One check's outcome. */
export interface CheckResult {
  /** The check's name. */
  readonly name: CheckName
  /** The verdict. */
  readonly status: CheckStatus
  /** What was found and what to do, on one line without a line break. */
  readonly message: string
}

/** What `docker version` found. */
export type DockerProbe =
  /** The `docker` program is not on the search path. */
  | { readonly kind: 'missing' }
  /** The program ran, but the engine gave no usable server version: it exited non-zero, timed out or printed nothing. */
  | { readonly kind: 'unanswered' }
  /** The engine answered with its server version. */
  | { readonly kind: 'answered', readonly serverVersion: string }

/** Runs the Docker probe. The command passes {@link runDockerVersion}; specs pass a fake. */
export type DockerRunner = () => Promise<DockerProbe>

/** The longest the engine probe may run, in milliseconds. */
export const DOCKER_PROBE_TIMEOUT_MILLIS = 5000

/** A server version as the engine prints it: a digit, then at most 63 letters, digits or version punctuation. */
const SERVER_VERSION = /^[0-9][0-9A-Za-z.+~_-]{0,63}$/

/** The shortest DeepSeek API key the format check accepts, in characters. */
const MIN_KEY_LENGTH = 20

/** The loopback address the studio binds. */
const LOOPBACK = '127.0.0.1'

/**
 * The studio's default port. The web application's `webserver` row binds
 * `ctx.webStartup.port ?? 3080` (`packages/bundle/web-app/cordis.patch.yml`),
 * and `delorun start` passes no port, so the studio listens on this one.
 */
export const STUDIO_DEFAULT_PORT = 3080

/**
 * The code a Node.js error carries, such as `ENOENT`.
 * @param error - the caught value.
 * @returns the code, or `undefined` when the value has none.
 */
function errorCode(error: unknown): string | undefined {
  return error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : undefined
}

/**
 * Fail on a case that a closed union lists and no branch handles.
 * @param value - the unhandled value.
 * @returns never.
 * @throws always.
 */
function assertNever(value: never): never {
  throw new Error(`unhandled case: ${JSON.stringify(value)}`)
}

/**
 * Build one check's result.
 * @param name - the check's name.
 * @param status - its verdict.
 * @param message - one line.
 * @returns the result.
 */
function outcome(name: CheckName, status: CheckStatus, message: string): CheckResult {
  return { name, status, message }
}

/**
 * Run `docker version --format {{.Server.Version}}` with no shell, bounded by a timeout.
 * @param timeoutMillis - the longest the probe may run.
 * @returns what the probe found; the promise does not reject.
 */
export function runDockerVersion(timeoutMillis = DOCKER_PROBE_TIMEOUT_MILLIS): Promise<DockerProbe> {
  return new Promise((resolve) => {
    execFile('docker', ['version', '--format', '{{.Server.Version}}'], { timeout: timeoutMillis, windowsHide: true }, (error, stdout) => {
      if (error !== null && errorCode(error) === 'ENOENT') {
        resolve({ kind: 'missing' })
        return
      }
      const serverVersion = error === null ? stdout.trim() : ''
      resolve(SERVER_VERSION.test(serverVersion) ? { kind: 'answered', serverVersion } : { kind: 'unanswered' })
    })
  })
}

/**
 * Classify the Docker probe. Docker is optional, so a missing program and an
 * unanswering engine both warn, and the exit code stays 0.
 * @param runner - runs the probe.
 * @returns the check's result.
 */
export async function checkDocker(runner: DockerRunner): Promise<CheckResult> {
  const probe = await runner()
  switch (probe.kind) {
    case 'missing':
      return outcome('docker', 'warn', 'Docker is not installed; the Docker shapes stay unavailable, and native workspaces are unaffected.')
    case 'unanswered':
      return outcome('docker', 'warn', 'Docker is installed, but its engine does not answer; start Docker, then run delorun doctor again.')
    case 'answered':
      return outcome('docker', 'pass', `the Docker engine answers; its server version is ${probe.serverVersion}.`)
    default:
      return assertNever(probe)
  }
}

/**
 * Check the DeepSeek API key's format offline: it must be set, contain no
 * whitespace or control character, have at least 20 characters and start with
 * `sk-`. No message contains the key, and the key is never sent anywhere.
 * @param key - the key the model would use, as the caller resolved it; `undefined` or empty when none is set.
 * @returns the check's result.
 */
export function checkKey(key: string | undefined): CheckResult {
  const note = 'format only; the key was not sent to DeepSeek'
  if (key === undefined || key.length === 0) {
    return outcome('key', 'warn', `no DeepSeek API key is set; the model cannot answer. Set ${SETUP_DEFAULT_CREDENTIAL_VARIABLE}, or run delorun setup to store one (${note}).`)
  }
  if (/[\s\p{Cc}]/u.test(key) || key.length < MIN_KEY_LENGTH || !key.startsWith('sk-')) {
    return outcome('key', 'fail', `the DeepSeek API key is malformed; check it at the key page (${note}).`)
  }
  return outcome('key', 'pass', `the DeepSeek API key is set and has the expected format (${note}).`)
}

/**
 * Whether a port can be bound on the loopback address now. The socket is
 * closed again before the result is returned.
 * @param port - the TCP port, from 1 to 65535.
 * @returns the check's result: `fail` when the port is in use or cannot be bound, with its error code.
 */
export function checkPort(port: number): Promise<CheckResult> {
  return new Promise((resolve) => {
    const server = createServer()
    server.once('error', (error: Error) => {
      const code = errorCode(error)
      resolve(code === 'EADDRINUSE'
        ? outcome('port', 'fail', `port ${String(port)} is in use; stop the other process or pass --port`)
        : outcome('port', 'fail', `port ${String(port)} cannot be bound on ${LOOPBACK} (${code ?? 'unknown error'}); pass --port with another port`))
    })
    server.listen({ host: LOOPBACK, port }, () => {
      server.close(() => {
        resolve(outcome('port', 'pass', `port ${String(port)} on ${LOOPBACK} is free.`))
      })
    })
  })
}

/** How one directory C1 requires private looks to the home check. */
type DirectoryState =
  /** The directory exists and has no group or other access. */
  | { readonly kind: 'private' }
  /** The directory does not exist. */
  | { readonly kind: 'missing' }
  /** The directory is refused; the message names it and, where one exists, its fix. */
  | { readonly kind: 'refused', readonly message: string }

/**
 * Examine one directory without creating it.
 * @param path - the absolute directory path.
 * @returns its state.
 * @throws the filesystem error when the path cannot be examined for another reason.
 */
async function examineDirectory(path: string): Promise<DirectoryState> {
  try {
    await checkPrivateDirectory(path)
    return { kind: 'private' }
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return { kind: 'missing' }
    if (error instanceof HomeLayoutError) return { kind: 'refused', message: error.message }
    throw error
  }
}

/**
 * Resolve the Delo home and check its tree without creating anything. The home
 * must exist; `secrets/` and `run/<profile>/` are checked when they exist,
 * because the first start creates them. On Windows the permission check is not
 * implemented, so the check warns instead of passing.
 * @param env - the environment, read for `DELO_HOME` and `DSH_HOME`.
 * @param profile - the CLI profile, whose `run/<profile>/` directory is checked.
 * @returns the check's result.
 * @throws the error of {@link resolveDeloHome} when it fails for a reason other than a refusal.
 */
export async function checkHome(env: Readonly<Record<string, string | undefined>>, profile: string): Promise<CheckResult> {
  let home: DeloHome
  try {
    home = await resolveDeloHome(env)
  } catch (error) {
    if (error instanceof HomeLayoutError) return outcome('home', 'fail', error.message)
    throw error
  }
  if (process.platform === 'win32') {
    return outcome('home', 'warn', `the Delo home at ${home.path} resolves; the Windows permission check is not implemented yet, so its access is not verified.`)
  }
  const root = await examineDirectory(home.path)
  if (root.kind === 'missing') return outcome('home', 'warn', `the Delo home at ${home.path} does not exist yet; delorun setup creates it at mode 0700.`)
  if (root.kind === 'refused') return outcome('home', 'fail', root.message)
  for (const path of [join(home.path, DELO_HOME_ENTRIES.secrets), runDirectory(home.path, profile)]) {
    const state = await examineDirectory(path)
    if (state.kind === 'refused') return outcome('home', 'fail', state.message)
  }
  return outcome('home', 'pass', `the Delo home at ${home.path} resolves, and its private directories have no group or other access.`)
}
