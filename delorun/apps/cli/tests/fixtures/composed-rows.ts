/**
 * The rows a profile runner would mount for a start's options, composed statically from the same layers, so a spec
 * that replaces upstream's runner can hand the start a Host that mounted exactly what the composition promised: every
 * row active unless its composed `disabled` is `true`, with its composed config.
 */
import { composeEntries } from '@deepseek-ai/dsh-app-boot'
import type { RunProfileOptions } from '@deepseek-ai/dsh/profile-boot'
import { ROW_SERVICES, type ServiceProvider } from '../../src/compose.ts'
import type { BootedRow } from '../../src/delorun-bundles.ts'
import { isRecord, patchLayers } from '../../src/patch-layers.ts'

/**
 * Every row the options compose to, nested inserts and group members included.
 * @param home - the Delorun home.
 * @param options - the options the start passed upstream's runner.
 * @param overrides - rows that replace the composed row of the same id, or are added.
 * @returns the rows.
 */
export function composedBootRows(home: string, options: RunProfileOptions, overrides: readonly BootedRow[] = []): BootedRow[] {
  const layers = patchLayers(home, options.resolvedProfile!.profile, options.patchFiles)
  const rows = new Map<string, BootedRow>()
  const visit = (entries: readonly unknown[]): void => {
    for (const entry of entries.filter(isRecord)) {
      if (typeof entry.id === 'string' && typeof entry.name === 'string') {
        rows.set(entry.id, { id: entry.id, name: entry.name, disabled: entry.disabled === true, state: 'active', ...entry.config === undefined ? {} : { config: entry.config } })
      }
      if (Array.isArray(entry.config)) visit(entry.config)
    }
  }
  visit(composeEntries(layers.map(layer => layer.patches)))
  for (const row of overrides) rows.set(row.id, row)
  return [...rows.values()]
}

/**
 * The providers of a Host that mounted its rows as composed: each required row's services are provided by that row
 * while it is enabled, active and its switch is not off.
 * @param rows - the booted rows.
 * @returns the lookup a booted profile answers with.
 */
export function composedProviders(rows: () => readonly BootedRow[]): (name: string) => ServiceProvider | undefined {
  return (name) => {
    const owner = Object.entries(ROW_SERVICES).find(([, services]) => services.includes(name))?.[0]
    const row = owner === undefined ? undefined : rows().find(candidate => candidate.id === owner)
    if (owner === undefined || row === undefined || row.disabled || row.state !== 'active' || (isRecord(row.config) && row.config.enabled === false)) return undefined
    return { row: owner }
  }
}
