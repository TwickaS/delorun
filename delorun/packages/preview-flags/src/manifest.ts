/**
 * The static index of preview flags: which row of which bundle declares which flag id. A bundle lists them in its
 * `package.json`, keyed by the row id its patch declares, as it lists a row's needs under `delorun.requires`:
 *
 * ```json
 * "delorun": { "previewFlags": { "delorun-onboarding": ["onboarding.previewSteps"] } }
 * ```
 *
 * The index names ids only. The plugin's own declaration (`ctx.previewFlags.declare`) carries the title, the
 * description and the kind; the Host refuses a declaration the index does not list, and {@link assertFlagsIndexed}
 * lets a plugin's spec hold the two equal. The index exists because two readers cannot run plugins: `delorun preview`,
 * which also runs while Delorun is stopped, and the Host for a row that is off.
 * @module @delorun/preview-flags/manifest
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { PREVIEW_FLAG_ID, type PreviewFlagId } from './flags.ts'

/** The most flags one row lists. */
const MAX_FLAGS_PER_ROW = 32

const Declared = z.object({
  delorun: z.object({
    previewFlags: z.record(z.string().min(1), z.array(z.string().regex(PREVIEW_FLAG_ID, 'a preview flag id is dot-separated camel-case words, such as onboarding.previewSteps')).max(MAX_FLAGS_PER_ROW)).optional(),
  }).optional(),
})

/** Where a flag is declared. */
export interface FlagOwner {
  /** The bundle whose manifest lists the flag. */
  readonly bundle: string
  /** The row of that bundle whose plugin declares it. */
  readonly rowId: string
}

/** A bundle whose list could not be read, or lists a flag another row already lists. */
export interface FlagIndexProblem {
  readonly bundle: string
  readonly message: string
}

/** Every flag the profile's bundles list. */
export interface FlagIndex {
  /** Each listed flag's owner. */
  readonly owners: ReadonlyMap<PreviewFlagId, FlagOwner>
  /** The bundles whose lists are broken; their flags are absent from {@link owners}. */
  readonly problems: readonly FlagIndexProblem[]
}

/** A bundle to read: its package name and directory. */
export interface FlagBundle {
  readonly name: string
  readonly dir: string
}

/**
 * The flags a bundle's manifest lists, by row id.
 * @param manifest - a parsed `package.json`.
 * @returns each row's flag ids; empty for a manifest that lists none.
 * @throws {z.ZodError} when `delorun.previewFlags` is not a record of row id to flag ids.
 */
export function listedFlags(manifest: unknown): Readonly<Record<string, readonly PreviewFlagId[]>> {
  // The schema's pattern is where a manifest's string becomes a flag id.
  return (Declared.parse(manifest).delorun?.previewFlags ?? {}) as Record<string, PreviewFlagId[]>
}

/**
 * Read the index from the profile's bundles. One bundle's problem never hides another bundle's flags.
 * @param bundles - the bundles, in the profile's order.
 * @returns the owners and the problems.
 */
export function readFlagIndex(bundles: readonly FlagBundle[]): FlagIndex {
  const owners = new Map<PreviewFlagId, FlagOwner>()
  const problems: FlagIndexProblem[] = []
  for (const bundle of bundles) {
    try {
      const rows = listedFlags(JSON.parse(readFileSync(join(bundle.dir, 'package.json'), 'utf8')))
      for (const [rowId, ids] of Object.entries(rows)) {
        for (const id of ids) {
          const first = owners.get(id)
          if (first !== undefined) throw new Error(`"previewFlags" lists ${id} for the row "${rowId}", which the row "${first.rowId}" of ${first.bundle} already lists`)
          owners.set(id, { bundle: bundle.name, rowId })
        }
      }
    } catch (error) {
      for (const [id, owner] of owners) if (owner.bundle === bundle.name) owners.delete(id)
      problems.push({ bundle: bundle.name, message: error instanceof z.ZodError ? z.prettifyError(error) : (error as Error).message })
    }
  }
  return { owners, problems }
}

/**
 * Hold a plugin's declarations equal to its bundle's list, for the plugin's spec.
 * @param manifest - the bundle's parsed `package.json`.
 * @param rowId - the plugin's row in that bundle.
 * @param declared - the ids the plugin declares.
 * @throws {Error} naming the ids only one side has.
 */
export function assertFlagsIndexed(manifest: unknown, rowId: string, declared: readonly PreviewFlagId[]): void {
  const listed = listedFlags(manifest)[rowId] ?? []
  const unlisted = declared.filter(id => !listed.includes(id))
  const undeclared = listed.filter(id => !declared.includes(id))
  if (unlisted.length === 0 && undeclared.length === 0) return
  throw new Error(`the row "${rowId}" and its bundle's delorun.previewFlags differ: `
    + [...unlisted.map(id => `${id} is declared and not listed`), ...undeclared.map(id => `${id} is listed and not declared`)].join('; '))
}
