/**
 * The workspaces service the main chat's account tools call: the Service
 * Definition of the `deloWorkspaces` capability seam. `@delo/plugin-workspaces`
 * provides it; until a provider is mounted the account tools are not
 * registered, and the rest of the main chat runs without them.
 *
 * The requests a tool builds from the model's arguments are validated here
 * ({@link CreateRequest}, {@link ImportRequest}); the provider validates its
 * own inputs again at its routes.
 *
 * @module @delo/plugin-workspaces/service
 */
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import { z } from 'zod'

/** A workspace's folder name: a letter or digit, then up to 99 letters, digits, `.`, `_` or `-`. */
export const folderName = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/)

/** The longest repository URL an import takes. */
export const MAX_URL_LENGTH = 2048

/** A repository to clone: an `https` URL without a user name or password. */
export const repositoryUrl = z.string().max(MAX_URL_LENGTH).refine((value) => {
  if (!URL.canParse(value)) return false
  const url = new URL(value)
  return url.protocol === 'https:' && url.hostname !== '' && url.username === '' && url.password === ''
}, 'an https URL without a user name or password')

/** A new, empty workspace folder and its title, the folder's name by default. */
export const CreateRequest = z.strictObject({ directory: folderName, title: z.string().min(1).max(200).optional() })

/** {@link CreateRequest}'s parsed value. */
export type CreateRequest = z.output<typeof CreateRequest>

/** A repository to clone into a new folder, named after the repository by default. */
export const ImportRequest = z.strictObject({ url: repositoryUrl, directory: folderName.optional() })

/** {@link ImportRequest}'s parsed value. */
export type ImportRequest = z.output<typeof ImportRequest>

/**
 * Why the workspaces service refused a request. `location` names a folder Delo never adds as a workspace: the filesystem
 * root, the home directory itself, or a folder that is, lies inside or contains the Delo home or the stock home.
 */
export type WorkspaceRefusalCode = 'invalid' | 'location' | 'not-found' | 'taken' | 'outside' | 'conflict' | 'too-large' | 'failed' | 'unavailable'

/** A refusal of the workspaces service, with an English message for the person. */
export class WorkspaceRefusedError extends Error {
  /** Why it refused. */
  readonly code: WorkspaceRefusalCode

  /**
   * @param code - why it refused.
   * @param reason - what happened, in words the main chat passes on.
   */
  constructor(code: WorkspaceRefusalCode, reason: string) {
    super(reason)
    this.code = code
    this.name = 'WorkspaceRefusedError'
  }
}

/** One import: running, finished, or failed with git's reason. */
export interface ImportRow {
  readonly id: string
  readonly directory: string
  readonly url: string
  readonly state: 'cloning' | 'done' | 'failed'
  /** Why it failed, in git's words or the provider's. */
  readonly reason: string | null
  /** git's latest progress line while the import runs, with the token removed; null once it ends. */
  readonly progress: string | null
}

/** One folder in the trash and the workspaces it held. */
export interface TrashEntry {
  readonly id: string
  readonly directory: string
  /** When the provider deletes it, in milliseconds since the epoch. */
  readonly deleteAt: number
  readonly workspaces: readonly { readonly title: string, readonly path: string }[]
}

/** The imports and the trash. */
export interface WorkspacesListing {
  /** The imports of the last day, newest first. */
  readonly imports: readonly ImportRow[]
  /** The trash, newest first. */
  readonly trash: readonly TrashEntry[]
}

/** A workspace's `AGENTS.md`: its text and revision, both null without a file. */
export interface InstructionsResponse {
  readonly path: string
  readonly text: string | null
  /** The SHA-256 of the file's bytes, hexadecimal. */
  readonly revision: string | null
  /** The longest file, in UTF-8 bytes, the provider writes. */
  readonly maxBytes: number
}

/** A write of a workspace's `AGENTS.md`: the new text, empty to remove the file, and the revision it replaces, null for none. */
export interface InstructionsRequest {
  readonly workspace: WorkspaceId
  readonly text: string
  readonly revision: string | null
}

/** The operations of Delo's workspaces service; each refuses with a {@link WorkspaceRefusedError}. */
export interface DeloWorkspaces {
  /**
   * List the imports and the trash.
   * @returns the listing.
   */
  list(): Promise<WorkspacesListing>
  /**
   * Create a workspace as a new, empty folder of the root.
   * @param request - the folder and the title.
   * @returns the new workspaces' ids.
   */
  create(request: CreateRequest): Promise<{ readonly workspaces: readonly WorkspaceId[] }>
  /**
   * Start cloning a repository into a new folder; {@link list} shows the import until it ends.
   * @param request - the repository's https URL and the folder.
   * @returns the import's id and its folder.
   */
  startImport(request: ImportRequest): Promise<{ readonly import: string, readonly directory: string }>
  /**
   * Read a workspace's `AGENTS.md`.
   * @param workspace - the workspace's id.
   * @returns the file's path, text and revision.
   */
  instructions(workspace: WorkspaceId): Promise<InstructionsResponse>
  /**
   * Write a workspace's `AGENTS.md`, or remove it with empty text, when its revision is still the one given.
   * @param request - the workspace, the text and the revision it replaces.
   */
  setInstructions(request: InstructionsRequest): Promise<void>
  /**
   * Move the folder that holds a workspace, with every workspace in it, to the trash.
   * @param request - the workspace.
   * @returns the trash entry.
   */
  trash(request: { readonly workspace: WorkspaceId }): Promise<TrashEntry>
  /**
   * Restore a trash entry's folder and its workspaces with their chats.
   * @param request - the trash entry's id.
   * @returns the restored workspaces' ids.
   */
  restore(request: { readonly trash: string }): Promise<{ readonly workspaces: readonly WorkspaceId[] }>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Delo's workspaces service; present while a provider is mounted. */
    deloWorkspaces: DeloWorkspaces
  }
}
