/**
 * The invariants Changes keeps for a booted profile, checked after the start ([enforce](./enforce.ts)) has run:
 *
 * 1. the protection record is readable, or absent;
 * 2. no `link:` dependency other than the harness's own (into the runtime store `runtimes/`, or to the directory the
 *    running installation carries for the name) names a folder other than its plugin's active directory;
 * 3. each active directory holds what `active.json` records for it, or nothing when it records none, and outside a work
 *    session for the plugin under `block` that is the approved version;
 * 4. every approved version's manifest and objects read back intact from the store.
 *
 * A link to anything but a directory names nothing to load and breaks no invariant.
 *
 * @module @delo/changes/invariants
 */
import { resolve } from 'node:path'
import { EMPTY_CONTENT_VERSION, isHarnessLink, namesDirectory, type EnforceRequest } from './enforce.ts'
import { isChangesError } from './errors.ts'
import { readLinks, type ProfileLink } from './link.ts'
import { activeDirectory } from './paths.ts'
import { approvedOf, readActiveRecord, readApproved, readProtection, readWorkSession } from './records.ts'
import { holdsVersion, readObject, readVersion } from './store.ts'
import { ACTIVE_RECORD_SCHEMA, APPROVED_RECORD_SCHEMA, type ActiveRecord, type ApprovedRecord } from './types.ts'

/** The profile whose invariants are checked, and the harness's own links ({@link EnforceRequest.harnessLink}). */
export interface InvariantRequest extends Pick<EnforceRequest, 'harnessLink'> {
  /** The Delo home. */
  readonly home: string
  /** The profile's name. */
  readonly profile: string
  /** The profile's directory. */
  readonly profileDir: string
}

/**
 * Check the invariants of Changes for one profile. Nothing is written.
 * @param request - the home, the profile and its directory.
 * @returns one line per broken invariant, naming the record, plugin or directory; empty when every invariant holds.
 */
export async function checkChangesInvariants(request: InvariantRequest): Promise<readonly string[]> {
  const { home, profile, profileDir } = request
  const broken: string[] = []
  const protection = await attempt(broken, 'The protection setting cannot be read', () => readProtection(home))
  const links: readonly ProfileLink[] = await attempt(broken, 'The profile\'s links cannot be read', () => readLinks(profileDir)) ?? []
  const approved: ApprovedRecord = await attempt(broken, 'The approved plugins cannot be read', () => readApproved(profileDir)) ?? { schema: APPROVED_RECORD_SCHEMA, plugins: {} }
  const active: ActiveRecord = await attempt(broken, 'The record of active directories cannot be read', () => readActiveRecord(home, profile)) ?? { schema: ACTIVE_RECORD_SCHEMA, plugins: {} }
  const workSession = await attempt(broken, 'The work session cannot be read', () => readWorkSession(home, profile))
  for (const link of links) {
    const directory = activeDirectory(home, profile, link.name)
    if (resolve(link.target) !== resolve(directory)) {
      if (!isHarnessLink(request, link.name, link.target) && await attempt(broken, `The folder of ${link.name} cannot be read`, () => namesDirectory(link.target)) === true) {
        broken.push(`${link.name} is linked from ${link.target}, not from its active directory ${directory}.`)
      }
      continue
    }
    const content = Object.hasOwn(active.plugins, link.name) ? active.plugins[link.name] : undefined
    const expected = content?.version ?? EMPTY_CONTENT_VERSION
    if (await attempt(broken, `The active directory of ${link.name} cannot be read`, () => holdsVersion(directory, expected)) === false) {
      broken.push(content === undefined
        ? `The active directory of ${link.name} holds content, and active.json records none: ${directory}.`
        : `The active directory of ${link.name} does not hold version ${content.version}, which active.json records: ${directory}.`)
    }
    const approvedVersion = approvedOf(approved, link.name)?.version
    if (content !== undefined && protection === 'block' && workSession?.plugin !== link.name && (content.kind !== 'approved' || content.version !== approvedVersion)) {
      broken.push(`${link.name} loads version ${content.version} under block outside a work session, which is not its approved version.`)
    }
  }
  for (const [plugin, approval] of Object.entries(approved.plugins)) {
    await attempt(broken, `The approved version of ${plugin} does not read back intact`, async () => {
      const manifest = await readVersion(home, approval.version)
      for (const entry of manifest.entries) {
        if (entry.type === 'file') await readObject(home, entry.digest)
      }
    })
  }
  return broken
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
