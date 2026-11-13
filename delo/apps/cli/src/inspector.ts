/**
 * `delorun start --inspect`: Node's inspector in the home process, for a plugin author's debugger. While it listens on
 * 127.0.0.1:9229, any process on this computer that reaches the port, the commands the agent runs inside the sandbox
 * included, can run code as Delo outside the sandbox, so C1's confinement guarantees do not hold
 * ([threat model](../../../docs/security/threat-model.md)).
 *
 * - The person confirms at a terminal, with a question that starts on no and states that exposure; without a terminal,
 *   `--inspect --yes` is the confirmation, and `--inspect` alone is refused.
 * - It is refused while the profile is in safe mode, which is for starting with as little running as possible.
 * - While it listens, the home process keeps `run/<profile>/inspector.json` (mode 0600) with its process id, the
 *   inspector's address and when it opened, and removes it when it exits; `delorun status` reads it and shows that the
 *   inspector is open.
 *
 * @module @delo/cli/inspector
 */
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { open as openNodeInspector, url as inspectorUrl } from 'node:inspector'
import { join } from 'node:path'
import { confirm, isCancel } from '@clack/prompts'
import { runDirectory } from '@delo/home'
import { readSafeMode } from '@delo/profile-safety'
import type { CommandOutput } from './command.ts'
import { CliError, EXIT } from './exit.ts'

/** The port `--inspect` opens Node's inspector on: Node's own default, which debuggers look for. */
export const INSPECTOR_PORT = 9229

/** The file under the profile's run directory that says the home process's inspector listens. */
export const INSPECTOR_FILENAME = 'inspector.json'

/** What the person is asked, and what `--yes` stands for. */
export const INSPECTOR_QUESTION = `Open the debugger on 127.0.0.1:${String(INSPECTOR_PORT)}? While it listens, any process on this computer, including commands the agent runs inside the sandbox, can run code as Delo outside the sandbox. Use it only while you debug.`

/** What the home process records while its inspector listens. */
export interface InspectorRecord {
  /** The home process's id. */
  readonly pid: number
  /** The inspector's WebSocket address. */
  readonly url: string
  /** When it opened, as an ISO 8601 time. */
  readonly openedAt: string
}

/**
 * Asks the person whether to open the inspector.
 * @param question - the question.
 * @returns true to open it.
 */
export type ConfirmInspector = (question: string) => Promise<boolean>

/**
 * The terminal's confirmation, which starts on no; without a terminal on both standard input and output, `undefined`.
 * @returns the confirmation, or `undefined` when no one can answer it.
 */
export function terminalInspectorConfirm(): ConfirmInspector | undefined {
  if (process.stdin.isTTY !== true || process.stdout.isTTY !== true) return undefined
  return async (question) => {
    const answer = await confirm({ message: question, initialValue: false })
    return !isCancel(answer) && answer
  }
}

/** What the decision to open the inspector reads. */
export interface InspectorConsentRequest {
  /** The Delo home. */
  readonly home: string
  /** The CLI profile. */
  readonly profile: string
  /** Whether `--yes` was given. */
  readonly yes: boolean
  /** The terminal's confirmation, or `undefined` without a terminal. */
  readonly confirm: ConfirmInspector | undefined
}

/**
 * Decide whether `--inspect` may open the inspector: never in safe mode, then with `--yes` or the person's answer.
 * @param request - the home, the profile, `--yes` and the confirmation.
 * @returns when the person confirmed.
 * @throws {CliError} with the failure code in safe mode, when the person declined, and without a terminal when `--yes`
 *   was not given; nothing has opened then.
 */
export async function inspectorConsent(request: InspectorConsentRequest): Promise<void> {
  if (readSafeMode(request.home, request.profile) !== undefined) {
    throw new CliError(EXIT.failed, `delorun start: the profile ${request.profile} is in safe mode, which does not open the debugger; leave safe mode with delorun recover exit-safe-mode, or start without --inspect`)
  }
  if (request.yes) return
  if (request.confirm === undefined) {
    throw new CliError(EXIT.failed, `delorun start: --inspect needs your confirmation. ${INSPECTOR_QUESTION.replace(/^Open the debugger[^?]*\? /, '')} Run it at a terminal to answer, or pass --inspect --yes to confirm`)
  }
  if (!await request.confirm(INSPECTOR_QUESTION)) throw new CliError(EXIT.failed, 'delorun start: the debugger was not opened, because you declined; Delo did not start')
}

/**
 * The record's path.
 * @param home - the Delo home.
 * @param profile - the CLI profile.
 * @returns `run/<profile>/inspector.json`.
 */
export function inspectorRecordPath(home: string, profile: string): string {
  return join(runDirectory(home, profile), INSPECTOR_FILENAME)
}

/**
 * Open Node's inspector on the loopback address, record it for `delorun status` until this process exits, and say what
 * that exposes.
 * @param home - the Delo home.
 * @param profile - the CLI profile.
 * @param output - where the warning goes.
 * @param onExit - registers the record's removal for this process's exit.
 * @param open - opens the inspector; Node's `inspector.open` by default.
 * @returns the inspector's WebSocket address.
 * @throws {CliError} when the inspector cannot open, such as when the port is taken.
 */
export function openDebugger(home: string, profile: string, output: CommandOutput, onExit: (listener: () => void) => void = (listener) => { process.once('exit', listener) }, open: (port: number, host: string) => void = (port, host) => { openNodeInspector(port, host) }): string {
  try {
    open(INSPECTOR_PORT, '127.0.0.1')
  } catch (error) {
    throw new CliError(EXIT.failed, `delorun start: the debugger could not listen on 127.0.0.1:${String(INSPECTOR_PORT)}: ${error instanceof Error ? error.message : String(error)}; stop the program using that port and try again`)
  }
  const address = inspectorUrl() ?? `ws://127.0.0.1:${String(INSPECTOR_PORT)}`
  const path = inspectorRecordPath(home, profile)
  const record: InspectorRecord = { pid: process.pid, url: address, openedAt: new Date().toISOString() }
  writeFileSync(path, `${JSON.stringify(record)}\n`, { mode: 0o600 })
  onExit(() => { rmSync(path, { force: true }) })
  output.stderr(`delorun start: a debugger can attach at ${address} (chrome://inspect, or your editor's Node debugger on port ${String(INSPECTOR_PORT)}). While it listens, any process on this computer, including commands the agent runs inside the sandbox, can run code as Delo outside the sandbox; start without --inspect when you are done.\n`)
  return address
}

/**
 * The inspector a home process records as open.
 * @param home - the Delo home.
 * @param profile - the CLI profile.
 * @param pid - the home process's id, from its lock.
 * @returns the record when that process wrote it; `undefined` when none exists, it cannot be read, or another process
 *   wrote it.
 */
export function readInspectorRecord(home: string, profile: string, pid: number): InspectorRecord | undefined {
  const path = inspectorRecordPath(home, profile)
  if (!existsSync(path)) return undefined
  let value: unknown
  try {
    value = JSON.parse(readFileSync(path, 'utf8'))
  } catch (_unreadable) {
    // A record that does not parse names no inspector; the home process rewrites it at its next start with --inspect.
    return undefined
  }
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as Partial<Record<keyof InspectorRecord, unknown>>
  if (record.pid !== pid || typeof record.url !== 'string' || typeof record.openedAt !== 'string') return undefined
  return { pid, url: record.url, openedAt: record.openedAt }
}
