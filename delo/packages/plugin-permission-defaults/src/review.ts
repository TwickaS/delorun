/**
 * What a surface shows before the person turns a workspace's full access on or off, and the review id that ties the
 * person's answer to what was shown. The studio's Permissions section and `delorun workspace full-access` both
 * read a workspace's {@link WorkspaceAccess}, show it, and send the change with its {@link fullAccessReviewId}; the
 * service refuses a change whose review id no longer matches the workspace's state, so an answer given to a screen
 * that another surface changed meanwhile records nothing.
 *
 * Free of Cordis, so the CLI computes the same ids from the store it reads.
 *
 * @module @delo/plugin-permission-defaults/review
 */
import { createHash } from 'node:crypto'
import { defaultPresetOf, serializePermissionStore, type WorkspacePermission } from './store.ts'
import type { PermissionRefusalCode, WorkspaceAccess } from './wire.ts'

/** The version of what a review shows, part of every review id: a change to the consent's words raises it. */
export const FULL_ACCESS_REVIEW_VERSION = 1 as const

/** The length of a review id: hexadecimal digits of a SHA-256. */
export const REVIEW_ID_LENGTH = 32

/** A review id's form: {@link REVIEW_ID_LENGTH} lowercase hexadecimal digits. */
export const REVIEW_ID_PATTERN = /^[0-9a-f]{32}$/

/**
 * What the person is told before full access is granted for a workspace: the folder it covers, what commands under
 * it can then reach — as contract C1's full-access statement names it — and that the answer covers this folder only.
 * The CLI asks with these words, and the chat's approval prompt carries them; the studio's consent shows the same facts
 * in the person's language.
 * @param workspace - the workspace directory the consent would cover.
 * @returns the ask's text.
 */
export function fullAccessNote(workspace: string): string {
  return `Turn on full access for the workspace ${JSON.stringify(workspace)}? Chats in this workspace could then run commands outside the sandbox and write anywhere on this computer, without asking again. Those commands can read everything your user can, including Delo's home with its keys and tokens, and reach the Docker supervisor and Delo's update channel. The answer covers this workspace only, and you can turn full access off again at any time.`
}

/**
 * The review id of one workspace's state: a digest of the review version, the workspace key and whether it holds a
 * grant now. It is no secret and authorizes nothing; a change that carries another id was answered to a screen that no
 * longer shows the workspace's state.
 * @param workspace - the workspace key.
 * @param granted - whether the workspace holds a full-access grant now.
 * @returns {@link REVIEW_ID_LENGTH} hexadecimal digits.
 */
export function fullAccessReviewId(workspace: string, granted: boolean): string {
  return createHash('sha256')
    .update(JSON.stringify([FULL_ACCESS_REVIEW_VERSION, workspace, granted]))
    .digest('hex')
    .slice(0, REVIEW_ID_LENGTH)
}

/**
 * One workspace's {@link WorkspaceAccess} from the store's entries.
 * @param entries - the store's entries.
 * @param workspace - the workspace key.
 * @param title - the registered workspace's title, when one is registered.
 * @returns what a surface shows.
 */
export function workspaceAccessOf(entries: ReadonlyMap<string, WorkspacePermission>, workspace: string, title?: string): WorkspaceAccess {
  const grantedAt = entries.get(workspace)?.fullAccessGrantedAt ?? null
  return {
    workspace,
    ...title === undefined ? {} : { title },
    preset: defaultPresetOf(entries, workspace),
    grantedAt,
    reviewId: fullAccessReviewId(workspace, grantedAt !== null),
  }
}

/**
 * A digest of the store's entries as this version writes them, so a writer that asks another process to read the store
 * again can check that the other process now holds what was written.
 * @param entries - the store's entries.
 * @returns `sha256:` and the hexadecimal digest of the store's text.
 */
export function permissionEntriesDigest(entries: ReadonlyMap<string, WorkspacePermission>): string {
  return `sha256:${createHash('sha256').update(serializePermissionStore(entries)).digest('hex')}`
}

/**
 * A change of a workspace's full access that a surface asked for and the service refused, recording nothing. The code
 * says why, and the routes answer it as the refusal's `error` ({@link PermissionRefusalCode}).
 */
export class FullAccessChangeError extends Error {
  /** Why the change was refused. */
  readonly code: PermissionRefusalCode

  /**
   * @param code - why the change was refused.
   * @param message - the sentence a surface shows.
   * @param options - the cause, when another failure stands behind the refusal.
   */
  constructor(code: PermissionRefusalCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'FullAccessChangeError'
    this.code = code
  }
}
