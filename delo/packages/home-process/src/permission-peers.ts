/**
 * Asking the running profiles of a home to read the per-workspace permission store again (`permission.reload`,
 * contract C19), after a process at the home's own computer changed it: `delorun workspace full-access`, and a Host
 * whose studio or chat withdrew a workspace's full access. Each profile's answer is classified on its own, so a
 * profile whose home process is gone, or answers late, never stops the others from being asked.
 *
 * @module @delo/home-process/permission-peers
 */
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { DELO_HOME_ENTRIES } from '@delo/contract-home-layout'
import { processExists, readHomeLock, runDirectory } from '@delo/home'
import type { ExchangeOptions, ResponseLine, UnsignedRequest } from './client.ts'

/**
 * How long one profile's answer to `permission.reload` is waited for, in milliseconds: the store's lock wait of
 * 10 seconds, which the profile's reread may queue behind, and a margin for the answer.
 */
export const PERMISSION_RELOAD_TIMEOUT_MS = 15_000

/**
 * Send one request over a profile's update channel; {@link sendHomeRequest} in a running Delo, a fake in specs.
 * @param home - the Delo home.
 * @param profile - the CLI profile.
 * @param request - the request.
 * @param options - the deadline.
 * @returns the response lines.
 */
export type PermissionPeerSend = (home: string, profile: string, request: UnsignedRequest, options: ExchangeOptions) => Promise<ResponseLine[]>

/**
 * What one profile did with `permission.reload`:
 *
 * - `read`: its Host holds the entries that were written;
 * - `other-grants`: its Host read the store and holds other entries, because another change landed at the same moment;
 * - `unavailable`: its profile does not ask for full access per workspace (`CONSENT_UNAVAILABLE`);
 * - `unread`: it did not read the change, with `reason` naming the refusal or the failure to reach it.
 */
export type PermissionReloadOutcome =
  | { readonly profile: string, readonly kind: 'read' | 'other-grants' | 'unavailable' }
  | { readonly profile: string, readonly kind: 'unread', readonly reason: string }

/**
 * Whether a profile's home process runs: a live process holds its home lock.
 * @param home - the Delo home.
 * @param profile - the CLI profile.
 * @returns true when the lock's holder is alive.
 */
export function profileRuns(home: string, profile: string): boolean {
  const record = readHomeLock(runDirectory(home, profile))
  return record !== undefined && processExists(record.pid)
}

/**
 * The profiles whose home process runs: each directory under the home's `run/` whose home lock a live process holds.
 * @param home - the Delo home.
 * @returns the profiles, sorted; none while `run/` cannot be listed.
 */
export function runningProfiles(home: string): readonly string[] {
  let names: string[]
  try {
    names = readdirSync(join(home, DELO_HOME_ENTRIES.run), { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name)
  } catch (_missing) {
    // A home whose run directory is missing or unreadable has no home process to ask.
    return []
  }
  return names.filter(profile => profileRuns(home, profile)).sort()
}

/**
 * Ask each profile's home process, one after another, to read the permission store again, and classify each answer.
 * @param request - the home, the profiles to ask, the digest of the entries written
 *   (`permissionEntriesDigest` of `@delo/plugin-permission-defaults`), and the send function.
 * @returns one outcome per profile, in the order given.
 */
export async function reloadPermissionsIn(request: {
  readonly home: string
  readonly profiles: readonly string[]
  readonly written: string
  readonly send: PermissionPeerSend
}): Promise<readonly PermissionReloadOutcome[]> {
  const outcomes: PermissionReloadOutcome[] = []
  for (const profile of request.profiles) outcomes.push(await reloadOne(request, profile))
  return outcomes
}

/**
 * Ask one profile.
 * @param request - the home, the digest written and the send function.
 * @param request.home - the Delo home.
 * @param request.written - the digest of the entries written.
 * @param request.send - the send function.
 * @param profile - the profile.
 * @returns its outcome.
 */
async function reloadOne(request: { readonly home: string, readonly written: string, readonly send: PermissionPeerSend }, profile: string): Promise<PermissionReloadOutcome> {
  let lines: ResponseLine[]
  try {
    lines = await request.send(request.home, profile, { op: 'permission.reload' }, { timeoutMs: PERMISSION_RELOAD_TIMEOUT_MS })
  } catch (error) {
    // A stale home lock whose pid was reused, a removed socket or a late answer: this profile did not read the change.
    return { profile, kind: 'unread', reason: error instanceof Error ? error.message : 'its home process could not be reached' }
  }
  const answer = lines.at(-1)
  if (answer === undefined) return { profile, kind: 'unread', reason: 'NO_ANSWER' }
  if (answer.ok) return { profile, kind: answer['digest'] === request.written ? 'read' : 'other-grants' }
  if (answer['error'] === 'CONSENT_UNAVAILABLE') return { profile, kind: 'unavailable' }
  return { profile, kind: 'unread', reason: String(answer['error']) }
}
