/**
 * The carry check an update runs before it changes anything: it compares the profile as the person left it with the
 * profile as the target release would leave it, and refuses when the target would drop a row, a local plugin or a
 * setting the person added, reorder or rewrite the bundle list they chose, or put back a plugin they ejected. A change
 * the update report names is a change the person can see and confirm; a change it does not name is never applied
 * silently. The check reads two values and writes nothing, so it runs before the snapshot and before the switch.
 *
 * @module @delo/profile-safety/carry
 */
import type { ReportItem, UpdateReport } from '@delo/contract-update-report'
import { ProfileSafetyError, type ProfileSafetyCode, type ProfileSafetyRemedy, type RefusedSubject } from './errors.ts'
import type { PersonConfiguration, PersonPlugin, PersonRow, ProfileInventory } from './inventory.ts'

/** What part of the person's profile a change is about. */
export type CarryKind = 'row' | 'configuration' | 'local-plugin' | 'bundle' | 'bundle-list'

/** What happens to it on the target. */
export type CarryEffect = 'removed' | 'changed' | 'kept'

/** One difference the target would make. */
export interface CarryChange {
  /** What part of the profile changed. */
  readonly kind: CarryKind
  /** The row id or plugin name, the row a setting belongs to, or the bundle's package name. */
  readonly subject: string
  /** What happens to it. */
  readonly effect: CarryEffect
  /** Whether an update-report item names it, which is what makes it a change the person can confirm. */
  readonly named: boolean
  /** What the change is, for the report item's detail and for the message. */
  readonly detail?: string
}

/** One reason the update cannot be carried, before anything changes. */
export interface CarryRefusal {
  /** The refusal's code. */
  readonly code: ProfileSafetyCode
  /** What would be lost, naming each subject; the person reads this instead of losing it. */
  readonly message: string
  /** The rows, settings, plugins or bundles it is about. */
  readonly subjects: readonly RefusedSubject[]
  /** What the person can do instead. */
  readonly remedies: readonly ProfileSafetyRemedy[]
}

/** The result of the carry check. */
export interface CarryPlan {
  /** Every difference the target would make, named or not. */
  readonly changes: readonly CarryChange[]
  /** Every reason the update cannot be carried; empty when it can. */
  readonly refusals: readonly CarryRefusal[]
  /** Whether the update can be carried: nothing the person added is lost or left unnamed. */
  readonly carried: boolean
}

/** What the check compares against besides the two inventories. */
export interface CarryOptions {
  /** The update report the person is shown; the items that name a change make it one they can confirm. */
  readonly report?: UpdateReport
}

/**
 * Compare the profile the person left with the profile the target would leave.
 * @param before - the inventory read from the profile before the update.
 * @param after - the inventory of the profile as the target would leave it.
 * @param options - the update report, when one was built.
 * @returns every difference and every refusal; nothing is written.
 */
export function planCarry(before: ProfileInventory, after: ProfileInventory, options: CarryOptions = {}): CarryPlan {
  const report = options.report?.items ?? []
  const changes: CarryChange[] = []
  const refusals: CarryRefusal[] = []

  refuseReinstatedEjections(before, after, refusals)
  compareRows(before.rows, after.rows, report, changes, refusals)
  compareConfigurations(before.configurations, after.configurations, report, changes, refusals)
  compareLocalPlugins(before.localPlugins, after.localPlugins, report, changes, refusals)
  compareBundles(before.bundles, after.bundles, report, changes, refusals)
  refuseAdditions(before, after, changes, refusals)

  return { changes, refusals, carried: refusals.length === 0 }
}

/**
 * Throw when the carry check refused the update.
 * @param plan - the plan {@link planCarry} returned.
 * @param profileDir - the profile the check read, for the failure's path.
 * @throws {ProfileSafetyError} with the first refusal's code, every refusal in its message, the union of its subjects
 *   and the remedies the person is offered; nothing has been written when it throws.
 */
export function assertCarriable(plan: CarryPlan, profileDir: string): void {
  const [first] = plan.refusals
  if (first === undefined) return
  throw new ProfileSafetyError(
    first.code,
    profileDir,
    plan.refusals.map(refusal => refusal.message).join(' '),
    [...new Set(plan.refusals.flatMap(refusal => refusal.remedies))],
    plan.refusals.flatMap(refusal => refusal.subjects),
  )
}

function refuseReinstatedEjections(before: ProfileInventory, after: ProfileInventory, refusals: CarryRefusal[]): void {
  const reinstated = before.ejected.filter(name =>
    after.bundles.includes(name) || after.localPlugins.some(plugin => plugin.name === name))
  if (reinstated.length === 0) return
  refusals.push({
    code: 'EJECTED_PLUGIN_REINSTATED',
    message: `${reinstated.join(', ')} ${reinstated.length === 1 ? 'was' : 'were'} ejected from this profile, and the update would put ${reinstated.length === 1 ? 'it' : 'them'} back.`,
    subjects: reinstated.map(name => ({ kind: 'bundle' as const, name })),
    remedies: ['skip-update', 'keep'],
  })
}

function compareRows(
  before: readonly PersonRow[], after: readonly PersonRow[], report: readonly ReportItem[],
  changes: CarryChange[], refusals: CarryRefusal[],
): void {
  const remaining = new Map(after.map(row => [rowKey(row), row]))
  for (const row of before) {
    const subject = rowName(row)
    const next = remaining.get(rowKey(row))
    const named = reportNamesRow(report, row)
    if (next === undefined) {
      changes.push({ kind: 'row', subject, effect: 'removed', named })
      if (!named) {
        refusals.push({
          code: 'ROW_NOT_CARRIED',
          message: `The row ${subject} in ${row.layer} would leave the profile, and the update report does not name it.`,
          subjects: [{ kind: 'row', name: subject, layer: row.layer }],
          remedies: ['skip-update', 'keep'],
        })
      }
      continue
    }
    if (row.disabled && !next.disabled) {
      changes.push({ kind: 'row', subject, effect: 'changed', named, detail: 'the row the person disabled would load again' })
      if (!named) {
        refusals.push({
          code: 'ROW_NOT_CARRIED',
          message: `The row ${subject} in ${row.layer} is disabled in the person's patch, and the update would enable it without naming the change.`,
          subjects: [{ kind: 'row', name: subject, layer: row.layer }],
          remedies: ['skip-update', 'keep'],
        })
      }
    }
  }
}

function compareConfigurations(
  before: readonly PersonConfiguration[], after: readonly PersonConfiguration[], report: readonly ReportItem[],
  changes: CarryChange[], refusals: CarryRefusal[],
): void {
  const remaining = new Map(after.map(configuration => [`${configuration.layer}\u0000${configuration.rowId}`, configuration]))
  for (const configuration of before) {
    const subject = configuration.rowId
    const next = remaining.get(`${configuration.layer}\u0000${configuration.rowId}`)
    const named = reportNamesRowId(report, configuration.rowId)
    if (next === undefined) {
      changes.push({ kind: 'configuration', subject, effect: 'removed', named })
      if (!named) {
        refusals.push({
          code: 'CONFIGURATION_NOT_CARRIED',
          message: `The settings the person wrote for row ${subject} in ${configuration.layer} would leave the profile, and the update report does not name that row.`,
          subjects: [{ kind: 'configuration', name: subject, layer: configuration.layer }],
          remedies: ['skip-update', 'keep'],
        })
      }
      continue
    }
    if (next.value !== configuration.value || next.keys.join(',') !== configuration.keys.join(',')) {
      changes.push({ kind: 'configuration', subject, effect: 'changed', named, detail: 'the settings the person wrote would change' })
      if (!named) {
        refusals.push({
          code: 'CONFIGURATION_NOT_CARRIED',
          message: `The settings the person wrote for row ${subject} in ${configuration.layer} would change, and the update report does not name that row.`,
          subjects: [{ kind: 'configuration', name: subject, layer: configuration.layer }],
          remedies: ['skip-update', 'keep'],
        })
      }
    }
  }
}

function compareLocalPlugins(
  before: readonly PersonPlugin[], after: readonly PersonPlugin[], report: readonly ReportItem[],
  changes: CarryChange[], refusals: CarryRefusal[],
): void {
  const remaining = new Map(after.map(plugin => [plugin.name, plugin]))
  for (const plugin of before) {
    const next = remaining.get(plugin.name)
    const named = reportNamesPlugin(report, plugin.name) || reportNamesBundle(report, plugin.name)
    if (next === undefined) {
      changes.push({ kind: 'local-plugin', subject: plugin.name, effect: 'removed', named })
      if (!named) {
        refusals.push({
          code: 'LOCAL_PLUGIN_NOT_CARRIED',
          message: `The plugin ${plugin.name} (${plugin.spec}) was installed from this machine, and the update would drop it from the profile without naming it.`,
          subjects: [{ kind: 'local-plugin', name: plugin.name }],
          remedies: ['skip-update', 'keep', 'eject'],
        })
      }
      continue
    }
    if (next.spec !== plugin.spec) {
      changes.push({ kind: 'local-plugin', subject: plugin.name, effect: 'changed', named, detail: `its spec would change from ${plugin.spec} to ${next.spec}` })
      if (!named) {
        refusals.push({
          code: 'LOCAL_PLUGIN_NOT_CARRIED',
          message: `The plugin ${plugin.name} would move from ${plugin.spec} to ${next.spec} in the profile, and the update report does not name it.`,
          subjects: [{ kind: 'local-plugin', name: plugin.name }],
          remedies: ['skip-update', 'keep'],
        })
      }
    }
  }
}

function compareBundles(
  before: readonly string[], after: readonly string[], report: readonly ReportItem[],
  changes: CarryChange[], refusals: CarryRefusal[],
): void {
  for (const name of before.filter(bundle => !after.includes(bundle))) {
    const named = reportNamesBundle(report, name) || reportNamesPlugin(report, name)
    changes.push({ kind: 'bundle', subject: name, effect: 'removed', named })
    if (!named) {
      refusals.push({
        code: 'BUNDLE_LIST_NOT_CARRIED',
        message: `The bundle ${name} would leave the profile's bundle list, and the update report does not name it.`,
        subjects: [{ kind: 'bundle', name }],
        remedies: ['skip-update', 'keep'],
      })
    }
  }
  for (const name of after.filter(bundle => !before.includes(bundle))) {
    // A bundle the update adds is never the person's choice, and C3 has no reason code for an addition.
    changes.push({ kind: 'bundle', subject: name, effect: 'changed', named: false })
    refusals.push({
      code: 'BUNDLE_LIST_NOT_CARRIED',
      message: `The bundle ${name} would be added to the profile's bundle list, which the person did not ask for.`,
      subjects: [{ kind: 'bundle', name }],
      remedies: ['skip-update', 'keep'],
    })
  }
  const kept = before.filter(bundle => after.includes(bundle))
  const afterKept = after.filter(bundle => before.includes(bundle))
  if (kept.join('\u0000') !== afterKept.join('\u0000')) {
    changes.push({ kind: 'bundle-list', subject: 'dsh.profile.bundles', effect: 'changed', named: false, detail: 'the order would change' })
    refusals.push({
      code: 'BUNDLE_LIST_NOT_CARRIED',
      message: 'The profile\'s bundle list would be reordered, and the person chose that order because each bundle patches the ones before it.',
      subjects: [{ kind: 'bundle-list', name: 'dsh.profile.bundles' }],
      remedies: ['skip-update', 'keep'],
    })
  }
}

function refuseAdditions(before: ProfileInventory, after: ProfileInventory, changes: CarryChange[], refusals: CarryRefusal[]): void {
  const rows = new Set(before.rows.map(rowKey))
  for (const row of after.rows.filter(row => !rows.has(rowKey(row)))) {
    const subject = rowName(row)
    changes.push({ kind: 'row', subject, effect: 'changed', named: false })
    refusals.push({
      code: 'UNNAMED_CHANGE',
      message: `The update would add the row ${subject} to ${row.layer}, which the person did not ask for and no report item names.`,
      subjects: [{ kind: 'row', name: subject, layer: row.layer }],
      remedies: ['skip-update'],
    })
  }
  const configurations = new Set(before.configurations.map(configuration => `${configuration.layer}\u0000${configuration.rowId}`))
  for (const configuration of after.configurations.filter(configuration => !configurations.has(`${configuration.layer}\u0000${configuration.rowId}`))) {
    changes.push({ kind: 'configuration', subject: configuration.rowId, effect: 'changed', named: false })
    refusals.push({
      code: 'UNNAMED_CHANGE',
      message: `The update would write settings for row ${configuration.rowId} into ${configuration.layer}, which the person did not ask for and no report item names.`,
      subjects: [{ kind: 'configuration', name: configuration.rowId, layer: configuration.layer }],
      remedies: ['skip-update'],
    })
  }
  const plugins = new Set(before.localPlugins.map(plugin => plugin.name))
  for (const plugin of after.localPlugins.filter(plugin => !plugins.has(plugin.name))) {
    changes.push({ kind: 'local-plugin', subject: plugin.name, effect: 'changed', named: false })
    refusals.push({
      code: 'UNNAMED_CHANGE',
      message: `The update would add the local plugin ${plugin.name} (${plugin.spec}) to the profile, which the person did not ask for and no report item names.`,
      subjects: [{ kind: 'local-plugin', name: plugin.name }],
      remedies: ['skip-update'],
    })
  }
}

/** A row's identity across an update: its id when it declares one, else its plugin name and layer. */
function rowKey(row: PersonRow): string {
  return row.id === undefined ? `${row.layer}\u0000${row.name}` : `id\u0000${row.id}`
}

/** The name a person reads for a row: its id, else its plugin name. */
function rowName(row: PersonRow): string {
  return row.id ?? row.name
}

function reportNamesRow(report: readonly ReportItem[], row: PersonRow): boolean {
  return report.some((item) => {
    if (item.kind !== 'row') return false
    return row.id !== undefined ? item.subject.id === row.id : item.subject.name === row.name
  })
}

function reportNamesRowId(report: readonly ReportItem[], rowId: string): boolean {
  return report.some(item => item.kind === 'row' && item.subject.id === rowId)
}

function reportNamesPlugin(report: readonly ReportItem[], name: string): boolean {
  return report.some(item => item.kind === 'plugin' && item.subject.name === name)
}

function reportNamesBundle(report: readonly ReportItem[], name: string): boolean {
  return report.some(item => item.kind === 'bundle' && item.subject.package === name)
}
