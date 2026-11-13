/**
 * The sentence each reason states, in the words C3's reason table gives it
 * (`delo/docs/contracts/c03-update-report.md#reasons`). The report is a document a person reads before confirming an
 * update, so the sentence is part of the report's contract and not a screen's copy: `delorun update` prints it as it
 * is, and the studio's update screens repeat the same words.
 *
 * The words reach a person, never a model: nothing here is a session event or a tool result.
 *
 * @module @delo/update/messages
 */
import type { PluginSubject, ReportItem, ReportVersions, RowSubject, UncheckedSource } from '@delo/contract-update-report'

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
function axisLabel(axis: 'dsh' | 'delo'): string {
  return axis === 'dsh' ? 'DSH' : 'Delorun'
}

/**
 * The version of one axis in one release.
 * @param versions - the release's versions.
 * @param axis - the axis to read.
 * @returns that axis's version.
 */
function axisVersion(versions: ReportVersions, axis: 'dsh' | 'delo'): string {
  return axis === 'dsh' ? versions.dsh : versions.delo
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
      return `${name} requires DSH ${detail.requirement ?? ''}; Delorun ${versions.to.delo} runs DSH ${versions.to.dsh}.`
    case 'delo-requirement-unmet':
      return `${name} requires Delorun ${detail.requirement ?? ''}; the update installs Delorun ${versions.to.delo}.`
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

/**
 * The sentence of a row item.
 * @param item - the item, whose subject is a row.
 * @returns the sentence.
 */
function rowSentence(item: ReportItem & { readonly kind: 'row' }): string {
  const subject = item.subject
  const plugin = item.detail.plugin?.name ?? ''
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
    ? `Delorun cannot tell whether Delorun ${versions.from.delo} reads the chat data Delorun ${versions.to.delo} writes.`
    : `Delorun ${versions.to.delo} keeps chat data in a format Delorun ${versions.from.delo} may not read.`
}

/**
 * The sentence a report shows beside a `data` item, in C3's words: what declining the copy costs.
 * @param versions - the running and target releases.
 * @returns the sentence.
 */
export function dataCopyNote(versions: MessageVersions): string {
  return `Without the copy, Delorun cannot go back to ${versions.from.delo} after ${versions.to.delo} first starts.`
}

/**
 * The sentence a report shows beside an unverified item, in C3's words: "Delo cannot predict this item".
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
      return rowSentence(item)
    case 'data':
      return dataMessage(item, versions)
  }
}
