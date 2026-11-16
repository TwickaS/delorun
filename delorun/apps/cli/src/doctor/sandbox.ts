/**
 * The `sandbox` line of `delorun doctor`, on Linux only: whether bubblewrap creates a sandbox here. Where it cannot,
 * upstream's provider falls back to Landlock, which cannot hide the sockets of the person's session, so while one of
 * C1's escape socket directories exists every confined command is refused. The check runs `bwrap --ro-bind / / true`,
 * bounded by a timeout, and reads `/proc/sys/kernel/apparmor_restrict_unprivileged_userns`, which Ubuntu from 23.10
 * sets to 1 to keep programs without an AppArmor profile that allows it from creating user namespaces.
 *
 * @module @delorun/cli/doctor/sandbox
 */
import { execFile } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { escapeDirectories } from '../sandbox-protection.ts'
import type { CheckResult } from './checks.ts'

/** What `bwrap --ro-bind / / true` found. */
export type BwrapProbe =
  /** No `bwrap` program is on the search path. */
  | { readonly kind: 'missing' }
  /** bwrap created the sandbox and ran `true` in it. */
  | { readonly kind: 'usable' }
  /** bwrap did not finish within the timeout, which says nothing about whether it can. */
  | { readonly kind: 'timed-out' }
  /** bwrap failed, with the first line it printed. */
  | { readonly kind: 'failed', readonly reason: string }

/** The longest the bwrap probe may run, in milliseconds; the same as the sandbox provider's default probe timeout. */
export const BWRAP_PROBE_TIMEOUT_MILLIS = 5000

/** The longest part of bwrap's own message the line quotes, in characters. */
const REASON_LENGTH = 200

/** The kernel setting of Ubuntu's AppArmor restriction on unprivileged user namespaces. */
export const APPARMOR_USERNS_RESTRICTION = '/proc/sys/kernel/apparmor_restrict_unprivileged_userns'

/**
 * Run `bwrap --ro-bind / / true` with no shell, bounded by a timeout.
 * @param path - the search path for `bwrap`, from the command's environment.
 * @param timeoutMillis - the longest the probe may run.
 * @returns what the probe found; the promise does not reject.
 */
export function runBwrapProbe(path: string | undefined, timeoutMillis = BWRAP_PROBE_TIMEOUT_MILLIS): Promise<BwrapProbe> {
  return new Promise((resolve) => {
    execFile('bwrap', ['--ro-bind', '/', '/', 'true'], { env: path === undefined ? {} : { PATH: path }, timeout: timeoutMillis }, (error, _stdout, stderr) => {
      if (error === null) {
        resolve({ kind: 'usable' })
        return
      }
      if (error.code === 'ENOENT') {
        resolve({ kind: 'missing' })
        return
      }
      if (error.killed) {
        resolve({ kind: 'timed-out' })
        return
      }
      const first = stderr.split('\n').map(line => line.trim()).find(line => line !== '') ?? `exit status ${String(error.code)}`
      resolve({ kind: 'failed', reason: first.replace(/\p{Cc}/gu, ' ').slice(0, REASON_LENGTH) })
    })
  })
}

/**
 * Whether Ubuntu's AppArmor restriction on unprivileged user namespaces is on.
 * @param read - reads the kernel setting; throws where it does not exist.
 * @returns true when the setting reads 1; false when it reads otherwise or does not exist.
 */
export function appArmorRestrictsUserNamespaces(read: () => string = () => readFileSync(APPARMOR_USERNS_RESTRICTION, 'utf8')): boolean {
  try {
    return read().trim() === '1'
  } catch (_absent) {
    // No such setting: the kernel has no AppArmor user-namespace restriction.
    return false
  }
}

/** What the sandbox line reports from. */
export interface SandboxFacts {
  /** The bwrap probe's result. */
  readonly probe: BwrapProbe
  /** Whether Ubuntu's AppArmor restriction on unprivileged user namespaces is on. */
  readonly appArmorRestricts: boolean
  /** The first of C1's escape socket directories that exists, or `undefined` when none does. */
  readonly escapeDirectory: string | undefined
}

/**
 * The first directory of a list that exists.
 * @param directories - the escape socket directories, in the start's order.
 * @returns the directory, or `undefined` when none exists.
 */
export function firstExisting(directories: readonly string[]): string | undefined {
  return directories.find(directory => existsSync(directory))
}

/**
 * Classify the sandbox. Without a working bwrap, every confined command is refused while an escape socket directory
 * exists, which fails the check; where none exists, commands run under Landlock, which cannot deny socket connects,
 * and the check warns.
 * @param facts - the probe, the AppArmor setting and the escape directory found.
 * @returns the check's result.
 */
export function checkSandbox(facts: SandboxFacts): CheckResult {
  const { probe, appArmorRestricts, escapeDirectory } = facts
  if (probe.kind === 'usable') {
    return { name: 'sandbox', status: 'pass', message: 'bubblewrap creates sandboxes, so sandboxed commands run with your session\'s sockets hidden.' }
  }
  const status = escapeDirectory === undefined ? 'warn' : 'fail'
  const effect = escapeDirectory === undefined
    ? 'sandboxed commands run under Landlock, which cannot keep them from connecting to sockets'
    : `every sandboxed command is refused while ${escapeDirectory} exists`
  switch (probe.kind) {
    case 'missing':
      return { name: 'sandbox', status, message: `bubblewrap (bwrap) is not installed, so ${effect}; install the bubblewrap package (on Debian or Ubuntu: sudo apt install bubblewrap), then restart Delorun.` }
    case 'timed-out':
      return { name: 'sandbox', status: 'warn', message: `bubblewrap did not finish within ${String(BWRAP_PROBE_TIMEOUT_MILLIS / 1000)} s; run delorun doctor again when the computer is less busy.` }
    case 'failed':
      return appArmorRestricts
        ? { name: 'sandbox', status, message: `bubblewrap cannot create a sandbox because AppArmor restricts user namespaces (kernel.apparmor_restrict_unprivileged_userns is 1), so ${effect}; allow bwrap with an AppArmor profile, as Troubleshooting describes, then restart Delorun.` }
        : { name: 'sandbox', status, message: `bubblewrap cannot create a sandbox (${probe.reason}), so ${effect}; run bwrap --ro-bind / / true to see why, then restart Delorun.` }
    default:
      return assertNever(probe)
  }
}

/**
 * The sandbox check on this computer: bwrap's probe, the AppArmor setting, and the first escape socket directory the
 * start would name that exists. `delorun doctor` and the end of `delorun setup` both run it.
 * @param path - the search path for `bwrap`, from the command's environment.
 * @returns the check's result.
 */
export async function checkSandboxHere(path: string | undefined): Promise<CheckResult> {
  return checkSandbox({
    probe: await runBwrapProbe(path),
    appArmorRestricts: appArmorRestrictsUserNamespaces(),
    escapeDirectory: firstExisting(escapeDirectories(process.getuid?.(), homedir())),
  })
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
