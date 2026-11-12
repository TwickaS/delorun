/**
 * The external-agent grants: one JSON file in the Delo home's protected state,
 * `secrets/delegation-consent/grants.json`, mode 0600 under the home's
 * `secrets/` directory, which the sandbox's confinement rules deny to confined
 * commands, so a confined command can neither read the grants nor add one.
 *
 * Each grant names one workspace, by the workspace key of
 * `@delo/plugin-permission-defaults`, and one subagent provider, and records
 * when the person allowed that provider to start there without asking. The file
 * is read again at every review, so a grant the CLI or another profile's studio
 * revoked stops counting at the next start. Every change reads, checks and
 * writes the file while holding its lock file, so no change overwrites another
 * it did not read. A file that exists but is not this version's format, a
 * symbolic link or a file laxer than 0600 is refused as a whole: no grant
 * counts and no change is written until the person repairs or removes it.
 *
 * Free of Cordis, so the format and its refusals are testable without a
 * mounted plugin.
 *
 * @module @delo/plugin-delegation-consent/store
 */
import { isAbsolute, join } from 'node:path'
import { DELO_HOME_ENTRIES } from '@delo/contract-home-layout'
import { readProtectedFile, writeProtectedFile } from '@delo/home'
import { withPermissionStoreLock } from '@delo/plugin-permission-defaults/store'

/** Format version of the grants file. */
export const GRANT_STORE_VERSION = 1 as const

/** One recorded grant: a provider may start in a workspace without asking. */
export interface ExternalAgentGrant {
  /** The workspace key (canonical absolute path). */
  readonly workspace: string
  /** The registered subagent provider name, such as `claude-code`. */
  readonly provider: string
  /** When the person allowed it, in milliseconds since the epoch. */
  readonly grantedAt: number
}

/** What reading the grants file found. */
export type GrantStoreRead =
  | { readonly kind: 'readable'; readonly grants: readonly ExternalAgentGrant[] }
  | { readonly kind: 'refused'; readonly problem: string }

/**
 * The grants file's path under the home's protected `secrets/` directory.
 * @param home - the resolved Delo home.
 * @returns the absolute path.
 */
export function grantStorePath(home: string): string {
  return join(home, DELO_HOME_ENTRIES.secrets, 'delegation-consent', 'grants.json')
}

/**
 * Parse the grants file's text, refusing anything that is not exactly this version's format.
 * @param text - the file's text.
 * @returns the grants.
 * @throws {Error} naming what is wrong.
 */
export function parseGrantStore(text: string): readonly ExternalAgentGrant[] {
  const parsed: unknown = JSON.parse(text)
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('the file is not a JSON object')
  const keys = Object.keys(parsed).sort().join(',')
  if (keys !== 'grants,v' || Reflect.get(parsed, 'v') !== GRANT_STORE_VERSION) throw new Error(`the file is not version ${GRANT_STORE_VERSION} of the grants format`)
  const grants: unknown = Reflect.get(parsed, 'grants')
  if (!Array.isArray(grants)) throw new Error('grants is not a list')
  return grants.map((grant: unknown) => {
    if (typeof grant !== 'object' || grant === null || Object.keys(grant).sort().join(',') !== 'grantedAt,provider,workspace') {
      throw new Error('a grant does not hold exactly a workspace, a provider and a time')
    }
    const workspace: unknown = Reflect.get(grant, 'workspace')
    const provider: unknown = Reflect.get(grant, 'provider')
    const grantedAt: unknown = Reflect.get(grant, 'grantedAt')
    if (typeof workspace !== 'string' || !isAbsolute(workspace) || typeof provider !== 'string' || provider === ''
      || typeof grantedAt !== 'number' || !Number.isSafeInteger(grantedAt) || grantedAt < 0) {
      throw new Error('a grant holds a workspace that is not absolute, an empty provider or an invalid time')
    }
    return { workspace, provider, grantedAt }
  })
}

/**
 * Read the grants file through contract C1's protected-file refusal rule.
 * @param path - the file's absolute path.
 * @returns the grants (none while no file exists), or `refused` with the problem.
 */
export async function readGrantStore(path: string): Promise<GrantStoreRead> {
  let bytes: Buffer
  try {
    bytes = await readProtectedFile(path)
  } catch (error) {
    if (error instanceof Error && Reflect.get(error, 'code') === 'ENOENT') return { kind: 'readable', grants: [] }
    return { kind: 'refused', problem: problemOf(error) }
  }
  try {
    return { kind: 'readable', grants: parseGrantStore(bytes.toString('utf8')) }
  } catch (error) {
    return { kind: 'refused', problem: problemOf(error) }
  }
}

/**
 * The words of a failed read or change of the grants file.
 * @param error - the failure.
 * @returns its message, or the value as text when it is not an Error.
 */
export function problemOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Whether the grants hold one for a provider in a workspace.
 * @param grants - the recorded grants.
 * @param workspace - the workspace key.
 * @param provider - the provider name.
 * @returns the grant, or undefined.
 */
export function grantOf(grants: readonly ExternalAgentGrant[], workspace: string, provider: string): ExternalAgentGrant | undefined {
  return grants.find(grant => grant.workspace === workspace && grant.provider === provider)
}

/**
 * Change the grants file under its lock: read it, refuse a refused file, apply the change and write the result.
 * @param path - the file's absolute path.
 * @param change - the grants to write, from the grants read.
 * @returns the grants written.
 * @throws {Error} naming the problem of a refused file, or the lock's holder when it is not free in time.
 */
export async function changeGrantStore(
  path: string,
  change: (grants: readonly ExternalAgentGrant[]) => readonly ExternalAgentGrant[],
): Promise<readonly ExternalAgentGrant[]> {
  return withPermissionStoreLock(path, async () => {
    const read = await readGrantStore(path)
    if (read.kind === 'refused') throw new Error(`the external-agent grants, ${path}, cannot be read (${read.problem})`)
    const next = change(read.grants)
    await writeProtectedFile(path, `${JSON.stringify({ v: GRANT_STORE_VERSION, grants: next }, null, 2)}\n`)
    return next
  })
}

/**
 * The grants with one provider allowed in one workspace; an existing grant keeps its time.
 * @param grants - the grants read.
 * @param workspace - the workspace key.
 * @param provider - the provider name.
 * @param now - the time a new grant records.
 * @returns the grants to write.
 */
export function withGrant(grants: readonly ExternalAgentGrant[], workspace: string, provider: string, now: number): readonly ExternalAgentGrant[] {
  return grantOf(grants, workspace, provider) === undefined ? [...grants, { workspace, provider, grantedAt: now }] : grants
}

/**
 * The grants without one provider's grant in one workspace.
 * @param grants - the grants read.
 * @param workspace - the workspace key.
 * @param provider - the provider name.
 * @returns the grants to write.
 */
export function withoutGrant(grants: readonly ExternalAgentGrant[], workspace: string, provider: string): readonly ExternalAgentGrant[] {
  return grants.filter(grant => grant.workspace !== workspace || grant.provider !== provider)
}
