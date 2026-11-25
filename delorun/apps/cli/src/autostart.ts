/**
 * The autostart hook: a systemd user unit that starts Delorun at login, and the checks that decide whether this
 * computer can have one.
 *
 * The unit runs `delorun start --foreground` through the launcher that installed this Delorun, so the home process is
 * the unit's own main process and `delorun stop` ends it. `Restart=no` is what keeps the two from fighting: a person
 * who stops Delorun leaves the unit inactive until they start it again or the machine restarts, and systemd never
 * brings a stopped home process back.
 *
 * A user unit needs no administrator rights. Starting it without a login session needs `loginctl enable-linger`, which
 * this module asks for and then reads back, because a machine may refuse it; the setup section says plainly when it did.
 *
 * @module @delorun/cli/autostart
 */
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { homedir, userInfo } from 'node:os'
import { join } from 'node:path'
import { DELORUN_HOME_ENV, DSH_HOME_ENV } from '@delorun/contract-home-layout'
import { writeProtectedFile } from '@delorun/home'

/** The unit's name under the user manager, without its `.service` suffix. */
export const AUTOSTART_UNIT = 'delorun'

/** How long a `systemctl` or `loginctl` call may take before it is given up on, in milliseconds. */
const COMMAND_TIMEOUT_MS = 15_000

/** What a command this module runs returned. */
export interface CommandOutcome {
  /** Whether it exited 0. */
  readonly ok: boolean
  /** Its standard output and standard error, trimmed. */
  readonly text: string
}

/**
 * Run a command and read its output.
 * @param file - the program.
 * @param args - its arguments.
 * @returns whether it succeeded and what it printed; a program that cannot be started is a failure with its reason.
 */
export function runCommand(file: string, args: readonly string[]): Promise<CommandOutcome> {
  return new Promise((resolve) => {
    execFile(file, [...args], { timeout: COMMAND_TIMEOUT_MS, windowsHide: true }, (error, stdout, stderr) => {
      const text = `${stdout}${stderr}`.trim()
      resolve({ ok: error === null, text })
    })
  })
}

/** What this computer offers for an autostart hook. */
export type AutostartSupport =
  /** A systemd user manager answers, so a unit can be installed. */
  | { readonly kind: 'systemd' }
  /** This computer has no systemd user manager, so no unit can be installed. */
  | { readonly kind: 'unsupported', readonly why: string }

/**
 * Whether this computer can run a systemd user unit.
 *
 * The check is the user manager's own answer rather than the presence of a file: a container or a machine without
 * systemd has `systemctl` on `PATH` and no manager behind it, and installing a unit there would leave a file that
 * never starts anything.
 * @param run - runs a command; {@link runCommand} by default.
 * @returns the support, with the reason when there is none.
 */
export async function autostartSupport(run: typeof runCommand = runCommand): Promise<AutostartSupport> {
  if (process.platform !== 'linux') return { kind: 'unsupported', why: `autostart uses a systemd user unit, and this is ${process.platform}` }
  const answer = await run('systemctl', ['--user', 'is-system-running'])
  // `is-system-running` exits non-zero for a degraded manager, which still runs units; only a manager that does not
  // answer at all, or answers `offline`, cannot start one.
  if (answer.text === '' || answer.text === 'offline') return { kind: 'unsupported', why: 'no systemd user manager answers on this computer' }
  return { kind: 'systemd' }
}

/**
 * The directory the user manager reads units from.
 *
 * The manager reads `XDG_CONFIG_HOME` from its own environment, which is the environment of the session that started
 * it, not the environment of the command that writes the unit. A unit written to the caller's `XDG_CONFIG_HOME` when
 * the two differ is a file systemd never reads, so the manager is asked for its own value.
 * @param env - the environment, read for `XDG_CONFIG_HOME` when the manager names none.
 * @param run - runs a command; {@link runCommand} by default.
 * @returns the directory, which may not exist yet.
 */
export async function unitDirectory(env: Readonly<Record<string, string | undefined>>, run: typeof runCommand = runCommand): Promise<string> {
  const manager = await managerConfigHome(run)
  const configured = manager ?? env['XDG_CONFIG_HOME']
  const base = configured !== undefined && configured.trim().length > 0 ? configured : join(homedir(), '.config')
  return join(base, 'systemd', 'user')
}

/**
 * The `XDG_CONFIG_HOME` the user manager itself runs with.
 * @param run - runs a command.
 * @returns the value, or `undefined` when the manager names none or does not answer.
 */
async function managerConfigHome(run: typeof runCommand): Promise<string | undefined> {
  const answer = await run('systemctl', ['--user', 'show-environment'])
  if (!answer.ok) return undefined
  const line = answer.text.split('\n').find(each => each.startsWith('XDG_CONFIG_HOME='))
  return line === undefined ? undefined : line.slice('XDG_CONFIG_HOME='.length)
}

/**
 * The unit file's path.
 * @param env - the environment, read for `XDG_CONFIG_HOME` when the manager names none.
 * @param run - runs a command; {@link runCommand} by default.
 * @returns the path of `delorun.service`.
 */
export async function unitPath(env: Readonly<Record<string, string | undefined>>, run: typeof runCommand = runCommand): Promise<string> {
  return join(await unitDirectory(env, run), `${AUTOSTART_UNIT}.service`)
}

/** What the unit runs, and for which home. */
export interface UnitRequest {
  /** The Delorun home the unit starts. */
  readonly home: string
  /** The CLI profile the unit starts. */
  readonly profile: string
  /** The launcher's entry file: the `delorun` program the person installed. */
  readonly entry: string
  /** The Node executable that runs the entry file. */
  readonly node: string
  /** The environment the unit is written with, read for `PATH` and `XDG_CONFIG_HOME`. */
  readonly env: Readonly<Record<string, string | undefined>>
}

/**
 * The unit file's text.
 *
 * `Type=exec` waits for the program to be executed, so a unit that cannot start the launcher is reported as failed
 * rather than as running. `--foreground` keeps the home process in the unit's own process, which is what makes
 * `delorun stop` end the unit; a detached start would leave the unit inactive while Delorun ran on.
 * @param request - the home, profile, launcher entry and environment.
 * @returns the unit file, ending with a newline.
 */
export function unitText(request: UnitRequest): string {
  const path = request.env['PATH'] ?? '/usr/local/bin:/usr/bin:/bin'
  return [
    '[Unit]',
    `Description=Delorun for the profile ${request.profile}`,
    'Documentation=https://docs.delorun.com',
    '',
    '[Service]',
    'Type=exec',
    `ExecStart=${request.node} ${request.entry} start --foreground --profile ${request.profile}`,
    `Environment=${DELORUN_HOME_ENV}=${request.home}`,
    `Environment=${DSH_HOME_ENV}=${request.home}`,
    `Environment=PATH=${path}`,
    'WorkingDirectory=%h',
    // A person who stops Delorun keeps it stopped until they start it again or the machine restarts.
    'Restart=no',
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n')
}

/** What installing or removing the unit did. */
export interface UnitOutcome {
  /** Whether the unit file is in place and enabled, or absent after a removal. */
  readonly ok: boolean
  /** What happened, as one sentence for the person. */
  readonly detail: string
  /** Whether the unit starts without a login session, when that was asked for. */
  readonly linger?: boolean
}

/**
 * Write the unit, enable it, and ask for linger.
 *
 * Enabling is what makes the unit start at login; linger is what makes it start at boot with nobody logged in. Linger
 * is asked for and then read back, because a machine may refuse it, and the outcome says which of the two the person
 * has.
 * @param request - the home, profile, launcher entry and environment.
 * @param run - runs a command; {@link runCommand} by default.
 * @param sleep - waits between linger reads; a real timer by default.
 * @returns what happened.
 */
export async function installUnit(request: UnitRequest, run: typeof runCommand = runCommand, sleep?: (ms: number) => Promise<void>): Promise<UnitOutcome> {
  const path = await unitPath(request.env, run)
  try {
    // systemd reads a user unit from this directory, which a fresh account does not have.
    mkdirSync(await unitDirectory(request.env, run), { recursive: true, mode: 0o700 })
    await writeProtectedFile(path, unitText(request))
  } catch (error) {
    return { ok: false, detail: `Delorun could not write ${path}: ${error instanceof Error ? error.message : String(error)}` }
  }
  const reload = await run('systemctl', ['--user', 'daemon-reload'])
  if (!reload.ok) return { ok: false, detail: `Delorun wrote ${path}, but systemd did not reload its units: ${reload.text}` }
  const enabled = await run('systemctl', ['--user', 'enable', `${AUTOSTART_UNIT}.service`])
  if (!enabled.ok) return { ok: false, detail: `Delorun wrote ${path}, but systemd did not enable it: ${enabled.text}` }
  const linger = await enableLinger(run, sleep)
  return {
    ok: true,
    detail: linger
      ? `Delorun starts at login and at boot, even with nobody logged in: systemd runs ${path}.`
      : `Delorun starts at login: systemd runs ${path}. It does not start at boot with nobody logged in, because this computer did not allow linger for your account.`,
    linger,
  }
}

/** How many times {@link enableLinger} reads linger back, and how long it waits between reads, in milliseconds. */
const LINGER_READS = 10
const LINGER_READ_MS = 200

/**
 * Ask for linger and read back whether it took.
 *
 * `loginctl enable-linger` returns before logind has written the marker it reads back, so a single read straight after
 * the request reports a refusal that did not happen. The read is repeated for a short while, and only then is the
 * answer taken as the machine's.
 * @param run - runs a command.
 * @param sleep - waits; a real timer by default.
 * @returns whether the account now lingers.
 */
async function enableLinger(run: typeof runCommand, sleep: (ms: number) => Promise<void> = ms => new Promise(resolve => setTimeout(resolve, ms))): Promise<boolean> {
  await run('loginctl', ['enable-linger', '--no-ask-password'])
  for (let read = 0; read < LINGER_READS; read++) {
    if (await lingerEnabled(run)) return true
    await sleep(LINGER_READ_MS)
  }
  return false
}

/**
 * Whether this account lingers, as `loginctl` reports it.
 *
 * The account is named: `loginctl show-user --value` with no user prints nothing and exits 0, which would read as a
 * refusal on every machine.
 * @param run - runs a command.
 * @param user - the account; this process's own by default.
 * @returns true when the account lingers.
 */
export async function lingerEnabled(run: typeof runCommand = runCommand, user: string = userInfo().username): Promise<boolean> {
  const answer = await run('loginctl', ['show-user', '--property=Linger', '--value', user])
  return answer.ok && answer.text.trim() === 'yes'
}

/**
 * Remove the unit and stop it.
 *
 * The unit is disabled and stopped before its file goes, so a removal leaves nothing that systemd would start again.
 * Linger is left as it is: another unit of the person's may rely on it, and turning it off would change a setting this
 * command did not set.
 * @param env - the environment, read for `XDG_CONFIG_HOME`.
 * @param run - runs a command; {@link runCommand} by default.
 * @returns what happened.
 */
export async function removeUnit(env: Readonly<Record<string, string | undefined>>, run: typeof runCommand = runCommand): Promise<UnitOutcome> {
  const path = await unitPath(env, run)
  if (!existsSync(path)) return { ok: true, detail: 'Delorun does not start at login: there is no unit to remove.' }
  await run('systemctl', ['--user', 'disable', '--now', `${AUTOSTART_UNIT}.service`])
  try {
    rmSync(path, { force: true })
  } catch (error) {
    return { ok: false, detail: `Delorun could not remove ${path}: ${error instanceof Error ? error.message : String(error)}` }
  }
  await run('systemctl', ['--user', 'daemon-reload'])
  return { ok: true, detail: 'Delorun no longer starts at login.' }
}

/**
 * Whether the unit is installed and enabled.
 * @param env - the environment, read for `XDG_CONFIG_HOME`.
 * @param run - runs a command; {@link runCommand} by default.
 * @returns true when the unit file exists and systemd reports it enabled.
 */
export async function autostartOn(env: Readonly<Record<string, string | undefined>>, run: typeof runCommand = runCommand): Promise<boolean> {
  if (!existsSync(await unitPath(env, run))) return false
  const answer = await run('systemctl', ['--user', 'is-enabled', `${AUTOSTART_UNIT}.service`])
  return answer.ok && answer.text.trim() === 'enabled'
}

/**
 * The launcher that installed this Delorun, as the unit runs it.
 *
 * The unit cannot run `delorun` from `PATH`: a user unit's `PATH` is not the person's shell's, and the launcher is
 * what anchors the release roots an update is verified against. The entry is the file this process loaded when it is
 * the launcher's own, and otherwise the `delorun` program on `PATH`.
 * @param env - the environment, read for `PATH`.
 * @param entry - the entry file this process loaded.
 * @returns the Node executable and entry file, or `undefined` when no launcher can be found.
 */
export function launcherCommand(env: Readonly<Record<string, string | undefined>>, entry: string): { readonly node: string, readonly entry: string } | undefined {
  // A launcher's entry is a file on disk that Node runs; a source checkout's is too, and both are started the same way.
  if (existsSync(entry)) return { node: process.execPath, entry }
  const path = env['PATH']
  if (path === undefined) return undefined
  for (const directory of path.split(':')) {
    if (directory === '') continue
    const candidate = join(directory, 'delorun')
    if (existsSync(candidate)) return { node: process.execPath, entry: candidate }
  }
  return undefined
}

/**
 * The unit file's text as it is on disk, for a report.
 * @param env - the environment, read for `XDG_CONFIG_HOME` when the manager names none.
 * @param run - runs a command; {@link runCommand} by default.
 * @returns the text, or `undefined` when there is no unit.
 */
export async function readUnit(env: Readonly<Record<string, string | undefined>>, run: typeof runCommand = runCommand): Promise<string | undefined> {
  const path = await unitPath(env, run)
  if (!existsSync(path)) return undefined
  try {
    return readFileSync(path, 'utf8')
  } catch (_unreadable) {
    // A unit that cannot be read is reported as absent; the caller's next write replaces it.
    return undefined
  }
}
