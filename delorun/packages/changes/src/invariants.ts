/**
 * The invariants Changes keeps for a profile:
 *
 * 1. the protection record is readable, or absent;
 * 2. no `link:` dependency other than the harness's own (into the runtime store `runtimes/`, or to the directory the
 *    running installation carries for the name) names anything other than its plugin's active directory, a missing
 *    folder or a file included, and the profile's `node_modules/<name>` for a plugin under Changes resolves to that
 *    active directory when it exists;
 * 3. each active directory holds what `active.json` records for it, or nothing when it records none, and outside a work
 *    session for the plugin under protection `on` that is the approved version, or, for `left-out` content, nothing or the
 *    content from before the plugin's change left out at start that stays out ([left out](./left-out.ts));
 * 4. every approved version's manifest and objects read back intact from the store.
 *
 * {@link checkLoadedContent} checks 1 to 3, what a profile loads: a start checks them after it prepared the profile and
 * the running Host before every recomposition, and each refuses to load when one does not hold ([enforce](./enforce.ts)).
 * {@link checkChangesInvariants} adds 4 for `delorun verify` and `delorun doctor`. A link to a missing folder breaks
 * invariant 2 as any other folder does, because whatever is created there before the Loader imports it would load.
 *
 * @module @delorun/changes/invariants
 */
import { realpath } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { EMPTY_CONTENT_VERSION, isHarnessLink, type EnforceRequest } from './enforce.ts'
import { isChangesError } from './errors.ts'
import { readLinks, type ProfileLink } from './link.ts'
import { activeDirectory } from './paths.ts'
import { leftOutContent, leftOutOf } from './left-out.ts'
import { approvedOf, readActiveRecord, readApproved, readChangeLog, readProtection, readWorkSession } from './records.ts'
import { holdsVersion, readObject, readVersion } from './store.ts'
import { ACTIVE_RECORD_SCHEMA, APPROVED_RECORD_SCHEMA, CHANGE_LOG_SCHEMA, type ActiveRecord, type ApprovedRecord, type ChangeLog } from './types.ts'

/** The profile whose invariants are checked, and the harness's own links ({@link EnforceRequest.harnessLink}). */
export interface InvariantRequest extends Pick<EnforceRequest, 'harnessLink'> {
  /** The Delorun home. */
  readonly home: string
  /** The profile's name. */
  readonly profile: string
  /** The profile's directory. */
  readonly profileDir: string
}

/**
 * Check every invariant of Changes for one profile. Nothing is written.
 * @param request - the home, the profile and its directory.
 * @returns one line per broken invariant, naming the record, plugin or directory; empty when every invariant holds.
 */
export async function checkChangesInvariants(request: InvariantRequest): Promise<readonly string[]> {
  const { broken, approved } = await checkLoaded(request)
  for (const [plugin, approval] of Object.entries(approved.plugins)) {
    await attempt(broken, `The approved version of ${plugin} does not read back intact`, async () => {
      const manifest = await readVersion(request.home, approval.version)
      for (const entry of manifest.entries) {
        if (entry.type === 'file') await readObject(request.home, entry.digest)
      }
    })
  }
  return broken
}

/**
 * Check the invariants of what the profile loads: the records are readable, every link names its plugin's active
 * directory, and every active directory holds what Changes keeps for it. Nothing is written.
 * @param request - the home, the profile, its directory and the harness's own links.
 * @returns one line per broken invariant; empty when every one holds.
 */
export async function checkLoadedContent(request: InvariantRequest): Promise<readonly string[]> {
  return (await checkLoaded(request)).broken
}

/**
 * {@link checkLoadedContent}, with the approved record it read.
 * @param request - the home, the profile, its directory and the harness's own links.
 * @returns the broken invariants and the approved record; an empty record when it cannot be read.
 */
async function checkLoaded(request: InvariantRequest): Promise<{ readonly broken: string[], readonly approved: ApprovedRecord }> {
  const { home, profile, profileDir } = request
  const broken: string[] = []
  const protection = await attempt(broken, 'The protection setting cannot be read', () => readProtection(home))
  const links: readonly ProfileLink[] = await attempt(broken, 'The profile\'s links cannot be read', () => readLinks(profileDir)) ?? []
  const approved: ApprovedRecord = await attempt(broken, 'The approved plugins cannot be read', () => readApproved(profileDir)) ?? { schema: APPROVED_RECORD_SCHEMA, plugins: {} }
  const active: ActiveRecord = await attempt(broken, 'The record of active directories cannot be read', () => readActiveRecord(home, profile)) ?? { schema: ACTIVE_RECORD_SCHEMA, plugins: {} }
  const workSession = await attempt(broken, 'The work session cannot be read', () => readWorkSession(home, profile))
  const log: ChangeLog = await attempt(broken, 'The change log cannot be read', () => readChangeLog(home, profile)) ?? { schema: CHANGE_LOG_SCHEMA, entries: [] }
  for (const link of links) {
    const directory = activeDirectory(home, profile, link.name)
    if (resolve(link.target) !== resolve(directory)) {
      if (!isHarnessLink(request, link.name, link.target)) broken.push(`${link.name} is linked from ${link.target}, not from its active directory ${directory}.`)
      continue
    }
    const installed = await attempt(broken, `The installed link of ${link.name} cannot be read`, () => resolvedOrMissing(join(profileDir, 'node_modules', link.name)))
    const real = await attempt(broken, `The active directory of ${link.name} cannot be read`, () => resolvedOrMissing(directory))
    if (installed !== undefined && installed !== null && installed !== real) {
      broken.push(`The profile's node_modules/${link.name} resolves to ${installed}, not to its active directory ${directory}.`)
    }
    const content = Object.hasOwn(active.plugins, link.name) ? active.plugins[link.name] : undefined
    const expected = content?.version ?? EMPTY_CONTENT_VERSION
    if (await attempt(broken, `The active directory of ${link.name} cannot be read`, () => holdsVersion(directory, expected)) === false) {
      broken.push(content === undefined
        ? `The active directory of ${link.name} holds content, and active.json records none: ${directory}.`
        : `The active directory of ${link.name} does not hold version ${content.version}, which active.json records: ${directory}.`)
    }
    if (content === undefined || protection !== 'on' || workSession?.plugin === link.name) continue
    if (content.kind === 'left-out') {
      // Holding nothing loads nothing; held content must be what a change left out at start stays out to.
      const left = leftOutOf(log, approved, link.name)
      if (content.version !== undefined && (left === undefined || leftOutContent(left).version !== content.version)) {
        broken.push(`${link.name} holds version ${content.version} as left out of a failed start, and no change left out of it that stays out holds that version.`)
      }
    } else if (content.kind !== 'approved' || content.version !== approvedOf(approved, link.name)?.version) {
      broken.push(`${link.name} loads version ${content.version} with protection on outside a work session, which is not its approved version.`)
    }
  }
  return { broken, approved }
}

/**
 * @param path - a path.
 * @returns its real path, or null when nothing is there.
 * @throws the filesystem error other than a missing path.
 */
async function resolvedOrMissing(path: string): Promise<string | null> {
  try {
    return await realpath(path)
  } catch (error) {
    // A missing entry resolves to nothing, so nothing loads through it.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

/**
 * Run one read, recording its failure as a broken invariant.
 * @param broken - the broken invariants so far.
 * @param what - what a failure means, in the person's words.
 * @param read - the read.
 * @returns what the read returned, or undefined when it failed.
 */
async function attempt<T>(broken: string[], what: string, read: () => Promise<T>): Promise<T | undefined> {
  try {
    return await read()
  } catch (error) {
    broken.push(`${what}: ${isChangesError(error) ? error.detail : String(error)}`)
    return undefined
  }
}
