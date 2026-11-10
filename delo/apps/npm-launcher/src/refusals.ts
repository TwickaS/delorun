/**
 * What the launcher prints when it stops, and what it offers: `@delo/home`'s refusal format, the one `delorun`
 * shares, in contract C1's and C2's terms. Each refusal leads with what Delo did, then why, naming the code and the
 * release, host or file it concerns, then what the person can do; none of them claims a check passed.
 *
 * @module @delo/npm-launcher/refusals
 */
import { describeFailure, homeLayoutDescriber, renderRefusal, type RefusalDescriber } from '@delo/home'
import { installDescriber } from '@delo/install'
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

/**
 * The refusal for anything the launcher caught, which is what it prints before it stops.
 * @param error - the value thrown.
 * @param context - the home and profile a remedy's command names.
 * @returns the refusal; an unrecognised failure reads `Delo stopped: <message>` and offers no remedy.
 */
export function refusalFor(error: unknown, context: RemedyContext): LauncherRefusal {
  const refusal = describeFailure(error, LAUNCHER_DESCRIBERS, { profile: context.profile })
  return { text: renderRefusal(refusal), exit: LAUNCHER_EXIT.failed, remedies: refusal.remedies }
}
