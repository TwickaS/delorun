/**
 * The parity overlay held against the registry. Each overlay row names an
 * entry `id`, the module that entry mounts as `name`, and a `config` holding
 * only built switches of that module at their parity values. A built switch
 * the overlay does not set is listed in {@link DEFAULT_PARITY} with the reason
 * a row cannot set it; its Config default is its parity value, which
 * `registryErrors` checks.
 *
 * @module @delo/tools/parity/composition/overlay
 */
import yaml from 'js-yaml'
import type { BuiltParitySwitch, ParitySwitchEntry, ParitySwitchId } from '@delo/contract-parity-composition'

/**
 * The built switches the overlay leaves to their Config default, each with the reason. A Cordis patch row replaces
 * an entry's whole `config` and reaches only rows of the root tree.
 */
export const DEFAULT_PARITY: Readonly<Partial<Record<ParitySwitchId, string>>> = {
  preset_inspect: 'its row sits in each Web preset\'s plugin list, which a patch reaches only by replacing the whole preset row',
  container_denial_marker: 'the bundles and the root configurations set sandbox-policy\'s mode and workspace root, which a row would erase',
  doctor: 'only the doctor profile mounts the app, and the replay starts no doctor process',
  studio_additions: 'no shipped profile or bundle mounts the main chat, whose row the studio bundle adds with the switch on',
}

/** One overlay row, as parsed. */
export interface OverlayRow {
  readonly id: string
  readonly name: string
  readonly config: Readonly<Record<string, unknown>>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Parse the overlay.
 * @param text - the overlay's YAML.
 * @returns its rows.
 * @throws Error when it is not a list of rows with a string `id`, a string `name`, an object `config` and no other key.
 */
export function parseOverlay(text: string): OverlayRow[] {
  const parsed: unknown = yaml.load(text)
  if (!Array.isArray(parsed)) throw new Error('the parity overlay is a list of patch rows')
  return parsed.map((row: unknown, index) => {
    if (!isRecord(row)) throw new Error(`parity overlay row ${String(index)} is not a mapping`)
    const extra = Object.keys(row).filter(key => !['id', 'name', 'config'].includes(key))
    if (extra.length > 0) throw new Error(`parity overlay row ${String(index)} sets ${extra.join(', ')}; a row sets only switch values in config`)
    const { id, name, config } = row
    if (typeof id !== 'string' || typeof name !== 'string' || !isRecord(config)) {
      throw new Error(`parity overlay row ${String(index)} needs a string id, a string name and a config mapping`)
    }
    return { id, name, config }
  })
}

/**
 * Every disagreement between the overlay and the registry.
 * @param rows - the overlay's rows.
 * @param registry - the switch registry.
 * @returns one message per disagreement; empty when the overlay sets each switch it can and only those.
 */
export function overlayErrors(rows: readonly OverlayRow[], registry: readonly ParitySwitchEntry[]): string[] {
  const built = registry.filter((entry): entry is BuiltParitySwitch => entry.state === 'built')
  const errors: string[] = []
  const set = new Set<string>()
  for (const row of rows) {
    const switches = built.filter(entry => entry.field.module === row.name)
    if (switches.length === 0) errors.push(`parity overlay row ${row.id}: ${row.name} holds no built C16 switch`)
    for (const [key, value] of Object.entries(row.config)) {
      const entry = switches.find(candidate => candidate.field.key === key)
      if (entry === undefined) {
        errors.push(`parity overlay row ${row.id}: ${key} is not a C16 switch of ${row.name}`)
        continue
      }
      if (value !== entry.parityValue) errors.push(`parity overlay row ${row.id}: ${key} is ${JSON.stringify(value)}, not the parity value of ${entry.id} (${String(entry.parityValue)})`)
      set.add(entry.id)
    }
  }
  for (const entry of built) {
    const reason = Object.entries(DEFAULT_PARITY).find(([id]) => id === entry.id)?.[1]
    if (set.has(entry.id) && reason !== undefined) errors.push(`${entry.id}: the overlay sets it, so it leaves DEFAULT_PARITY`)
    if (!set.has(entry.id) && reason === undefined) errors.push(`${entry.id}: the overlay does not set it; add a row, or list it in DEFAULT_PARITY with the reason a row cannot`)
  }
  for (const id of Object.keys(DEFAULT_PARITY)) {
    if (!built.some(entry => entry.id === id)) errors.push(`DEFAULT_PARITY names ${id}, which is no built C16 switch`)
  }
  return errors
}
