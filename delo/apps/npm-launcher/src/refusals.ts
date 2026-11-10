/**
 * What the launcher prints when it stops, and what it offers: `@delo/home`'s refusal format, the one `delorun`
 * shares, in contract C1's and C2's terms. Each refusal leads with what Delo did, then why, naming the code and the
 * release, host or file it concerns, then what the person can do; none of them claims a check passed. Every refusal
 * passes `@delo/logs`'s redactor before it is printed, and a failure the launcher did not catch prints the same way.
 *
 * @module @delo/npm-launcher/refusals
 */
import { describeFailure, homeLayoutDescriber, installLastResort, renderRefusal, type FatalProcess, type Refusal, type RefusalDescriber } from '@delo/home'
import { installDescriber } from '@delo/install'
import { Redactor } from '@delo/logs'
import { RELEASE_VERIFY_DESCRIBERS } from '@delo/release-verify/refusal'
import { runtimeStoreDescriber } from '@delo/runtime-store'

/** The launcher's exit codes. */
export const LAUNCHER_EXIT = {
  /** The runtime ran and ended with its own status. */
  ok: 0,
  /** Delo refused or failed, and nothing ran. */
  failed: 1,
  /** The command line is wrong. */
  usage: 2,
} as const

/** An exit code the launcher returns. */
export type LauncherExit = (typeof LAUNCHER_EXIT)[keyof typeof LAUNCHER_EXIT]

/** A refusal, as the launcher prints it. */
export interface LauncherRefusal {
  /** The text for standard error, every line ending with a newline. */
  readonly text: string
  /** The exit code. */
  readonly exit: LauncherExit
  /** What the person can do, in order; empty when the launcher offers nothing. */
  readonly remedies: readonly string[]
}

/** What naming a remedy needs. */
export interface RemedyContext {
  /** The resolved Delo home. */
  readonly home: string
  /** The CLI profile. */
  readonly profile: string
}

/** The describers of every typed error the launcher's packages raise on its path: the home's, the install's, the runtime store's and the release-log check's. */
export const LAUNCHER_DESCRIBERS: readonly RefusalDescriber[] = [homeLayoutDescriber, installDescriber, runtimeStoreDescriber, ...RELEASE_VERIFY_DESCRIBERS]

/** The launcher's redactor: `@delo/logs`'s listed secret forms, since the launcher registers no secret value. */
const REDACTOR = new Redactor()

/**
 * A refusal as the launcher prints it: `@delo/home`'s format through the launcher's redactor.
 * @param refusal - the refusal.
 * @returns the redacted text, every line ending with a newline.
 */
export function renderLauncherRefusal(refusal: Refusal): string {
  return renderRefusal(refusal, REDACTOR)
}

/**
 * The refusal for anything the launcher caught, which is what it prints before it stops.
 * @param error - the value thrown.
 * @param context - the home and profile a remedy's command names.
 * @returns the refusal, its text redacted; an unrecognised failure reads `Delo stopped: <message>` and offers no remedy.
 */
export function refusalFor(error: unknown, context: RemedyContext): LauncherRefusal {
  const refusal = describeFailure(error, LAUNCHER_DESCRIBERS, { profile: context.profile })
  return { text: renderLauncherRefusal(refusal), exit: LAUNCHER_EXIT.failed, remedies: refusal.remedies }
}

/** The last remedy of the launcher's fatal report: the launcher keeps no log. */
export const LAUNCHER_NO_LOG_POINTER = 'The launcher keeps no log, so this report is all it recorded; run the same command again, and report this if it repeats.'

/** What {@link installLauncherLastResort} reports through; the real process's by default. */
export interface LauncherFatalIo {
  /** The process whose events it reports. */
  readonly process: FatalProcess
  /** Writes to standard error. */
  readonly stderr: (text: string) => void
  /** Ends the process. */
  readonly exit: (code: number) => void
}

/**
 * Install `@delo/home`'s last-resort handler for the launcher's process, once, before its main module loads: a failure
 * the launcher did not catch prints as a redacted refusal with the launcher's describers and exits 1. The runtime the
 * launcher starts is a child process with a handler of its own.
 * @param io - the process, standard error and the exit.
 * @returns the uninstaller.
 * @throws {Error} when a handler is already installed on the process.
 */
export function installLauncherLastResort(io: LauncherFatalIo = {
  process,
  stderr: text => void process.stderr.write(text),
  exit: code => process.exit(code),
}): () => void {
  return installLastResort({ ...io, describers: LAUNCHER_DESCRIBERS, context: {}, redactor: REDACTOR, record: () => ({ pointer: LAUNCHER_NO_LOG_POINTER }) })
}
