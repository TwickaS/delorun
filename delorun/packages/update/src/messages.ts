/**
 * The sentence each reason states, in the words C3's reason table gives it
 * (`delorun/docs/contracts/c03-update-report.md#reasons`). The report is a document a person reads before confirming an
 * update, so the sentence is part of the report's contract and not a screen's copy: `delorun update` prints it as it
 * is, and the studio's update screens repeat the same words.
 *
 * The words reach a person, never a model: nothing here is a session event or a tool result.
 *
 * @module @delorun/update/messages
 */
import type { PluginSubject, ReportItem, ReportVersions, RowSettingsDetail, RowSubject, SettingChange, SettingValue, UncheckedSource } from '@delorun/contract-update-report'

/** The two releases one item is about. */
export interface MessageVersions {
  /** The release the installation runs. */
  readonly from: ReportVersions
  /** The release the update would install. */
  readonly to: ReportVersions
}

/**
 * The label each axis carries in a sentence.
 * @param axis - the axis.
 * @returns `DSH` or `Delorun`.
 */
function axisLabel(axis: 'dsh' | 'delorun'): string {
  return axis === 'dsh' ? 'DSH' : 'Delorun'
}

/**
 * The version of one axis in one release.
 * @param versions - the release's versions.
 * @param axis - the axis to read.
 * @returns that axis's version.
 */
function axisVersion(versions: ReportVersions, axis: 'dsh' | 'delorun'): string {
  return axis === 'dsh' ? versions.dsh : versions.delorun
}

/**
 * The sentence of a plugin item.
 * @param item - the item, whose subject is a plugin.
 * @param versions - the running and target releases.
 * @returns the sentence.
 */
function pluginMessage(item: ReportItem & { readonly kind: 'plugin' }, versions: MessageVersions): string {
  const { name } = item.subject as PluginSubject
  const { detail, reason } = item
  switch (reason) {
    case 'dsh-requirement-unmet':
      return `${name} requires DSH ${detail.requirement ?? ''}; Delorun ${versions.to.delorun} runs DSH ${versions.to.dsh}.`
    case 'delorun-requirement-unmet':
      return `${name} requires Delorun ${detail.requirement ?? ''}; the update installs Delorun ${versions.to.delorun}.`
    case 'requirement-unreadable':
      return `${name} declares engines.${detail.axis ?? ''} in a form Delorun cannot read.`
    case 'requirement-exempted': {
      const axis = detail.axis ?? 'dsh'
      return `${name} requires ${axisLabel(axis)} ${detail.requirement ?? ''}; your exemption for this exact version covers ${axisVersion(versions.to, axis)}.`
    }
    case 'exemption-not-carried': {
      const axis = detail.axis ?? 'dsh'
      return `${name} runs today under your exemption for ${axisVersion(versions.from, axis)}; the exemption does not cover ${axisVersion(versions.to, axis)}.`
    }
    case 'requirement-undeclared':
      return `${name} declares no DSH requirement, so its compatibility with DSH ${versions.to.dsh} is not stated.`
    case 'plugin-revoked':
      return `${name} is revoked: ${detail.revocation?.reason ?? ''}, ${detail.revocation?.message ?? ''}.`
    case 'manifest-unreadable':
      return `Delorun could not read ${name}'s package.json; it cannot predict what the update does to it.`
    default:
      // The other reasons are a bundle's or a row's; a plugin item never carries one.
      return name
  }
}

/**
 * The sentence of a bundle item.
 * @param item - the item, whose subject is a bundle.
 * @param versions - the running and target releases.
 * @returns the sentence.
 */
function bundleMessage(item: ReportItem & { readonly kind: 'bundle' }, versions: MessageVersions): string {
  const { package: bundle } = item.subject
  switch (item.reason) {
    case 'bundle-retired':
      return `${bundle} is retired in DSH ${versions.to.dsh} and leaves the bundle list.`
    case 'bundle-template-normalised':
      return `The bundle list matches an installation-owned list that DSH ${versions.to.dsh} replaces with its template.`
    case 'bundle-skipped':
      return `${bundle} cannot load on the target: ${item.detail.failure ?? ''}.`
    default:
      return bundle
  }
}

/**
 * The row's id or name, as a sentence names it.
 * @param subject - the row's subject.
 * @returns the id when the row has one, otherwise its name or module URL.
 */
function rowName(subject: RowSubject): string {
  return subject.id ?? subject.name
}

/** How a sentence names a protected row and its switch, for the rows whose own words the report knows. */
const ROW_WORDS: Readonly<Record<string, { readonly title: string, readonly switch: string }>> = {
  'delorun-agent-seats': { title: 'External agents', switch: 'live agents' },
}

/**
 * How a sentence names a protected row.
 * @param id - the row's id.
 * @returns `the <title> row (<id>)` for a row with known words, otherwise `row <id>`.
 */
function protectedRowName(id: string): string {
  const words = ROW_WORDS[id]
  return words === undefined ? `row ${id}` : `the ${words.title} row (${id})`
}

/**
 * Whether a setting value may be named in a sentence: a number or a boolean. A string, a list or a mapping is described
 * in words and never quoted, because a setting can hold a path, a name or a secret.
 * @param value - the value.
 * @returns true for a number or a boolean.
 */
function isPlainValue(value: SettingValue | undefined): value is number | boolean {
  return typeof value === 'number' || typeof value === 'boolean'
}

/**
 * The words for one changed setting, without its JSON.
 * @param id - the row's id.
 * @param change - the setting.
 * @returns a clause such as `turns on live agents`.
 */
function settingClause(id: string, change: SettingChange): string {
  if (change.after === undefined) return `removes the ${change.key} setting`
  if (change.key === 'enabled' && typeof change.after === 'boolean') return `turns ${change.after ? 'on' : 'off'} ${ROW_WORDS[id]?.switch ?? 'the row'}`
  return isPlainValue(change.after) ? `sets ${change.key} to ${String(change.after)}` : `changes the ${change.key} setting`
}

/**
 * The sentence of a protected row whose settings the target release's bundle changes, adds or drops.
 * @param id - the row's id.
 * @param settings - how the settings differ.
 * @param versions - the running and target releases.
 * @returns the sentence.
 */
function settingsSentence(id: string, settings: RowSettingsDetail, versions: { readonly to: { readonly delorun: string } }): string {
  const name = protectedRowName(id)
  const release = `Delorun ${versions.to.delorun}`
  if (settings.change === 'added') return `${release} adds ${name}, which Delorun protects.`
  if (settings.change === 'removed') return `${release} removes ${name}, which Delorun protects.`
  return `${release} changes the settings of ${name}: ${settings.keys.map(key => settingClause(id, key)).join('; ')}.`
}

/**
 * The sentence for a protected row whose settings a release's bundles changed, for a health check that found the change
 * itself.
 * @param change - the row's change between the two releases' bundles.
 * @param delorun - the release the bundles belong to.
 * @returns the sentence.
 */
export function settingsNote(change: RowSettingsDetail & { readonly id: string }, delorun: string): string {
  return settingsSentence(change.id, change, { to: { delorun } })
}

/**
 * The sentence of a row item.
 * @param item - the item, whose subject is a row.
 * @param versions - the running and target releases.
 * @returns the sentence.
 */
function rowSentence(item: ReportItem & { readonly kind: 'row' }, versions: MessageVersions): string {
  const subject = item.subject
  const plugin = item.detail.plugin?.name ?? ''
  if (item.detail.settings !== undefined) return settingsSentence(rowName(subject), item.detail.settings, versions)
  if (item.detail.bundlePatch) return `Delorun ${versions.to.delorun} switches off row ${rowName(subject)} through its bundle ${subject.layer}; the row stays in your profile but does not run.`
  if (item.reason === 'row-include-blocked') return `Include ${subject.name} reaches ${plugin}, which the update disables, so the whole Include is disabled.`
  return `Row ${rowName(subject)} in ${subject.layer} loads ${plugin}, which the update disables.`
}

/**
 * The sentence of a data item.
 * @param item - the item, whose subject is the home's chat data.
 * @param versions - the running and target releases.
 * @returns the sentence.
 */
function dataMessage(item: ReportItem & { readonly kind: 'data' }, versions: MessageVersions): string {
  return item.reason === 'data-format-unknown'
    ? `Delorun cannot tell whether Delorun ${versions.from.delorun} reads the chat data Delorun ${versions.to.delorun} writes.`
    : `Delorun ${versions.to.delorun} keeps chat data in a format Delorun ${versions.from.delorun} may not read.`
}

/**
 * The sentence of a harness item.
 * @param item - the item, whose subject is a harness file.
 * @param versions - the running and target releases.
 * @returns the sentence.
 */
function harnessMessage(item: ReportItem & { readonly kind: 'harness' }, versions: MessageVersions): string {
  const { file } = item.subject
  if (item.reason === 'harness-change-merged') return `Your change to ${file} and Delorun ${versions.to.delorun}'s change to it merge into a file neither has; read the merge before you confirm.`
  if (item.reason !== 'harness-change-conflicts') return `Your change to ${file} carries over to Delorun ${versions.to.delorun}.`
  // A file the person removed has no content to keep beside the release's.
  if (item.detail.merge === 'release-changed-removed') return `You removed ${file}, and Delorun ${versions.to.delorun} changed it; the new release's file runs.`
  return `Your change to ${file} conflicts with Delorun ${versions.to.delorun}'s file; the new release's file runs, and yours is kept beside it as ${file}.mine.`
}

/**
 * The line a report shows under a plugin that the update disables because its `engines.dsh` range (or a DSH peer)
 * excludes the target: how to try the plugin anyway, and what stops a failed try. The Delorun axis has no exemption
 * (C17), so no other reason has one.
 * @param item - the item.
 * @param versions - the running and target releases.
 * @returns the line, or `undefined` for every item that is not a `dsh-requirement-unmet` plugin.
 */
export function exemptionNote(item: ReportItem, versions: MessageVersions): string | undefined {
  if (item.kind !== 'plugin' || item.reason !== 'dsh-requirement-unmet') return undefined
  const { name, version } = item.subject
  return `To try it anyway before you update, run: delorun plugin allow-version ${name}@${version} --dsh-version ${versions.to.dsh} --accept-risk. If the plugin then fails to load, the health check after the switch rolls the update back.`
}

/**
 * The sentence a report shows beside a `data` item, in C3's words: what declining the copy costs.
 * @param versions - the running and target releases.
 * @returns the sentence.
 */
export function dataCopyNote(versions: MessageVersions): string {
  return `Without the copy, Delorun cannot go back to ${versions.from.delorun} after ${versions.to.delorun} first starts.`
}

/**
 * The sentence a report shows beside an unverified item, in C3's words: "Delorun cannot predict this item".
 */
export const UNVERIFIED_NOTE = 'Delorun cannot predict this item.'

/** The sentence each source in a report's `notChecked` states, in C3's words. */
const UNCHECKED_NOTES: Readonly<Record<UncheckedSource, string>> = {
  revocations: 'revocations. This release publishes no revocation list; the health check after the switch holds what one would show.',
}

/**
 * The sentence a report shows for one source it did not read, after `Not checked: `.
 * @param source - the source, from the report's `notChecked`.
 * @returns the sentence C3 gives it.
 */
export function uncheckedMessage(source: UncheckedSource): string {
  return UNCHECKED_NOTES[source]
}

/**
 * The sentence one item states.
 * @param item - the item.
 * @param versions - the running and target releases.
 * @returns the sentence C3's reason table gives the item's reason.
 */
export function reasonMessage(item: ReportItem, versions: MessageVersions): string {
  switch (item.kind) {
    case 'plugin':
      return pluginMessage(item, versions)
    case 'bundle':
      return bundleMessage(item, versions)
    case 'row':
      return rowSentence(item, versions)
    case 'data':
      return dataMessage(item, versions)
    case 'harness':
      return harnessMessage(item, versions)
  }
}
