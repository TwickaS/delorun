/**
 * The new-workspace flow's row configuration: where it makes new folders and searches, the bounds of a folder search,
 * the folders it suggests, and how long a clone may run.
 * @module @delorun/plugin-new-workspace/config
 */
import z from '@deepseek-ai/schemastery'

/** The Loader row id. */
export const NEW_WORKSPACE_ROW_ID = 'delorun-new-workspace'

/** A folder spelled from the home directory (`~` or `~/…`) or absolute. */
const PLACE = /^(?:~(?:\/[^\0]*)?|\/[^\0]*|[A-Za-z]:[\\/][^\0]*)$/u

/** The harness half's configuration. */
export interface Config {
  roots: string[]
  suggested: string[]
  firstParent: string
  searchDepth: number
  searchFolders: number
  searchTimeMs: number
  cloneTimeoutMs: number
}

/** The configuration schema: each field validated and defaulted. */
export const Config = z.object({
  roots: z.array(z.string().pattern(PLACE)).min(1).max(16)
    .description('The folders a new folder or a clone may be made in, and the folders a search walks, spelled from the home directory (`~/…`) or absolute. A path whose real location (symbolic links resolved) leaves every root is refused.')
    .default(['~']),
  suggested: z.array(z.string().pattern(PLACE)).max(8)
    .description('Folders the flow suggests as places to look, in order; only those that exist inside a root are shown.')
    .default(['~/Projects', '~/src', '~/code', '~/Documents', '~/Desktop']),
  firstParent: z.string().pattern(PLACE)
    .description('Where a new folder or a clone goes before the person has made one; it is created at the first use when missing.')
    .default('~/Projects'),
  searchDepth: z.natural().min(1).max(8).description('How many folders deep below each root a search looks.').default(4),
  searchFolders: z.natural().min(100).max(200_000).description('The most folders one search reads.').default(20_000),
  searchTimeMs: z.natural().min(100).max(10_000).description('The most time one folder search, or reading one folder for its preview, may take, in milliseconds.').default(2_000),
  cloneTimeoutMs: z.natural().min(10_000).max(3_600_000).description('The most time a clone from Git may take, in milliseconds.').default(600_000),
})
