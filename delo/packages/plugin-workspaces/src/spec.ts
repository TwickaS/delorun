/**
 * The workspaces storage domain: the `imports` table, one row per repository import, and the `trash` table, one row per
 * trashed folder. Rows are validated when the domain opens, so a stored row that does not match these schemas fails the
 * open loudly instead of reaching the provider.
 * @module @delo/plugin-workspaces/spec
 */
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import { z } from 'zod'

/** One repository import as stored. git's progress lines stay in memory and are never stored. */
export const ImportRecord = z.object({
  /** The folder the clone writes into: a folder name under the root. */
  directory: z.string(),
  /** The clone URL, which carries no user name, password, query or fragment. */
  url: z.string(),
  state: z.enum(['cloning', 'done', 'failed']),
  /** Why the import failed, or null. */
  reason: z.string().nullable(),
  /** The workspace the import registered, once the import is done. */
  workspace: z.string().nullable(),
  /** When the import started, in milliseconds since the epoch. */
  startedAt: z.number().int().nonnegative(),
  /** When the import ended, in milliseconds since the epoch, or null while it runs. */
  endedAt: z.number().int().nonnegative().nullable(),
})

/** {@link ImportRecord}'s parsed value. */
export type ImportRecord = z.infer<typeof ImportRecord>

/** One trashed folder as stored. */
export const TrashRecord = z.object({
  /** The folder's name under the root, which a restore gives it back. */
  directory: z.string(),
  /** When the folder was trashed, in milliseconds since the epoch; the listing sorts by it. */
  trashedAt: z.number().int().nonnegative(),
  /** When the folder is deleted for good, in milliseconds since the epoch: the trash time plus the configured trash days. */
  deleteAt: z.number().int().nonnegative(),
  /** The workspaces the folder held, in the registry's order. */
  workspaces: z.array(z.object({
    title: z.string(),
    path: z.string(),
    /** The workspace's chats in its order, so a restore keeps the order. */
    sessions: z.array(z.string()),
    /** The chats the trash archived, which a restore unarchives. */
    archived: z.array(z.string()),
  })),
})

/** {@link TrashRecord}'s parsed value. */
export type TrashRecord = z.infer<typeof TrashRecord>

/**
 * The workspaces domain: the `imports` and `trash` tables, keyed by their ids. Version 1 is the first format.
 */
export const workspacesDomain = defineDomain({
  name: 'delo_workspaces',
  version: 1,
  tables: {
    imports: domainTable<string, ImportRecord>(ImportRecord),
    trash: domainTable<string, TrashRecord>(TrashRecord),
  },
})
