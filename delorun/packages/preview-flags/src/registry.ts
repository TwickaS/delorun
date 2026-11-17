/**
 * The Host's preview flags: the flags the running plugins declare, checked against the profile row's `flags` and the
 * bundles' static index. Creation fails on a configured flag no bundle lists; a declaration fails when the index does
 * not list it, read again for a bundle added since, or another plugin already declared it.
 * @module @delorun/preview-flags/registry
 */
import { knownList, type PreviewFlagDeclaration, type PreviewFlagId } from './flags.ts'
import type { FlagIndex } from './manifest.ts'
import type { PreviewFlagView } from './wire.ts'

/** The Host API of the preview flags. */
export interface PreviewFlags {
  /**
   * Declare a flag for as long as the plugin runs. Register it as an effect: `ctx.effect(() => ctx.previewFlags.declare(flag))`.
   * @param flag - the flag.
   * @returns the disposer that withdraws the declaration.
   * @throws {Error} when the profile's bundles do not list the id, or a running plugin already declared it.
   */
  declare(flag: PreviewFlagDeclaration): () => void
  /**
   * Whether a flag is on: the profile row sets it and its plugin runs.
   * @param id - the flag.
   * @returns true when on; false for a flag that is off or whose plugin is off.
   * @throws {Error} for an id that no running plugin declares and no bundle lists, naming the known flags.
   */
  isOn(id: PreviewFlagId): boolean
  /**
   * The flags the running plugins declare, sorted by id.
   * @returns each flag with its state.
   */
  list(): readonly PreviewFlagView[]
}

/** What the flags are created from. */
export interface PreviewFlagsSource {
  /** The profile row's `flags`. */
  readonly configured: Readonly<Record<string, boolean>>
  /** The bundles' index; undefined in a tree without a profile, where nothing is configured and declarations are not checked against it. */
  readonly index: FlagIndex | undefined
  /**
   * Read the index again, for a flag the index does not list: a bundle added while Delorun runs, such as a plugin
   * pack, lists its flags only after the row has loaded. Absent where the index cannot change.
   * @returns the index as the profile's bundles list it now.
   */
  readonly reindex?: () => FlagIndex
  /**
   * Whether a row is absent or disabled.
   * @param rowId - the row's id.
   * @returns true when no plugin of the row runs.
   */
  readonly rowOff: (rowId: string) => boolean
}

/** The flags and what their creation found that the person should read. */
export interface CreatedPreviewFlags {
  readonly flags: PreviewFlags
  /** One sentence per flag that is turned on while its declaring row is off. */
  readonly notices: readonly string[]
}

/** The row's name in messages. */
const ROW = 'delorun-preview-flags'

/**
 * Create the flags and check the configured ones.
 * @param source - the row's `flags`, the index and the rows' state.
 * @returns the flags and the notices.
 * @throws {Error} when flags are configured without an index to check them against, or a configured flag is in no bundle's list; the message names the flag and the known flags.
 */
export function createPreviewFlags(source: PreviewFlagsSource): CreatedPreviewFlags {
  const { configured, index, rowOff, reindex } = source
  const ids = Object.keys(configured)
  if (index === undefined && ids.length > 0) throw new Error(`${ROW}: flags are set (${knownList(ids)}), but there is no profile whose bundles could be read to check them against`)
  let listed: FlagIndex['owners'] = index?.owners ?? new Map()
  /** Whether the index lists a flag, reading it again once on a miss. */
  const isListed = (id: PreviewFlagId): boolean => {
    if (!listed.has(id) && reindex !== undefined) listed = reindex().owners
    return listed.has(id)
  }
  const unknown = ids.filter(id => !listed.has(id as PreviewFlagId))
  if (unknown.length > 0) {
    throw new Error(`${ROW}: ${unknown.map(id => `"${id}"`).join(', ')} ${unknown.length === 1 ? 'is' : 'are'} set, but no plugin of this profile declares ${unknown.length === 1 ? 'it' : 'them'}. `
      + `Known flags: ${knownList(listed.keys())}. Remove ${unknown.length === 1 ? 'it' : 'each'} with: delorun preview off <flag>`)
  }
  const notices = ids.filter(id => configured[id] === true).flatMap((id) => {
    const owner = index?.owners.get(id as PreviewFlagId)
    return owner !== undefined && rowOff(owner.rowId)
      ? [`${ROW}: "${id}" is on, but the row "${owner.rowId}" of ${owner.bundle}, whose plugin declares it, is off, so the flag changes nothing`]
      : []
  })
  const declared = new Map<PreviewFlagId, PreviewFlagDeclaration>()
  const flags: PreviewFlags = {
    declare(flag) {
      if (index !== undefined && !isListed(flag.id)) {
        throw new Error(`${ROW}: ${flag.owner} declares "${flag.id}", which no bundle of this profile lists under delorun.previewFlags in its package.json. Listed flags: ${knownList(listed.keys())}`)
      }
      const first = declared.get(flag.id)
      if (first !== undefined) throw new Error(`${ROW}: ${flag.owner} declares "${flag.id}", which ${first.owner} already declared`)
      declared.set(flag.id, flag)
      return () => { if (declared.get(flag.id) === flag) declared.delete(flag.id) }
    },
    isOn(id) {
      if (declared.has(id)) return configured[id] === true
      if (isListed(id)) return false
      throw new Error(`${ROW}: "${id}" is not a declared preview flag. Known flags: ${knownList(new Set([...declared.keys(), ...listed.keys()]))}`)
    },
    list: () => [...declared.values()].sort((a, b) => a.id.localeCompare(b.id)).map(flag => ({
      id: flag.id, kind: flag.kind, owner: flag.owner, title: flag.title, description: flag.description, on: configured[flag.id] === true,
    })),
  }
  return { flags, notices }
}
