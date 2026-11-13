/**
 * The report itself: one document per installation and target release, built after the target's files are downloaded,
 * verified and staged and before anything in the profile or the active runtime changes (contract C3, "When a report
 * is made"). It names every plugin, bundle and profile row the target would disable, remove or change, sorts the
 * items by kind and then subject, counts them, and shows both installations' versions and update states.
 *
 * Two things this module refuses, because C3 makes them the report's own guarantees: a target that failed its
 * signature, freshness or log check gets no report (R2), and nothing is counted as safe that rests on metadata Delo
 * could not read (R3), which the counts keep apart.
 *
 * @module @delo/update/report
 */
import { INSTALLATIONS, UPDATE_REPORT_SCHEMA, type Installation, type InstallationStatus, type ReportItem, type ReportVersions, type UpdateReport } from '@delo/contract-update-report'
import type { VersionAxis } from '@delo/contract-plugin-versions'
import { UpdateReportError } from './errors.ts'
import type { ReportInput, TargetFacts } from './facts.ts'
import { dataItems } from './data-formats.ts'
import { harnessItems } from './harness-items.ts'
import { bundleItems, pluginItems, rowItems } from './items.ts'
import type { AxisVersions } from './versions.ts'

/** The order C3's item table lists the kinds in, which the report sorts by first. */
const KIND_ORDER: Readonly<Record<ReportItem['kind'], number>> = { plugin: 0, bundle: 1, row: 2, data: 3, harness: 4 }

/** The three checks C3 requires to have passed before any report is shown. */
const RELEASE_CHECKS = ['signature', 'freshness', 'log'] as const

/**
 * The subject text an item is sorted by within its kind.
 * @param item - the item.
 * @returns the plugin name, the bundle package, the row's id or name, the data item's directories, or the harness file.
 */
function subjectText(item: ReportItem): string {
  switch (item.kind) {
    case 'plugin':
      return item.subject.name
    case 'bundle':
      return item.subject.package
    case 'row':
      return item.subject.id ?? item.subject.name
    case 'data':
      return item.subject.directories.join(',')
    case 'harness':
      return item.subject.file
  }
}

/**
 * Sort items as C3 orders them: by kind, then by subject, with the reason breaking a tie so the order is total.
 * @param items - the items.
 * @returns a new list in report order.
 */
export function sortItems(items: readonly ReportItem[]): readonly ReportItem[] {
  return [...items].sort((left, right) => {
    const kind = KIND_ORDER[left.kind] - KIND_ORDER[right.kind]
    if (kind !== 0) return kind
    const subject = subjectText(left).localeCompare(subjectText(right), 'en')
    return subject !== 0 ? subject : left.reason.localeCompare(right.reason, 'en')
  })
}

/**
 * The counts C3's `counts` field holds: the items per effect, and the unverified, `data` and `harness` items beside them.
 * @param items - every item.
 * @returns the counts.
 */
export function countItems(items: readonly ReportItem[]): UpdateReport['counts'] {
  return {
    disabled: items.filter(item => item.effect === 'disabled').length,
    removed: items.filter(item => item.effect === 'removed').length,
    changed: items.filter(item => item.effect === 'changed').length,
    unverified: items.filter(item => item.verification === 'unverified').length,
    data: items.filter(item => item.kind === 'data').length,
    harness: items.filter(item => item.kind === 'harness').length,
  }
}

/**
 * Both installations in display order, with an absent record shown as `unknown`, which C3 allows only for the other
 * installation's record and states for either: an absent or unreadable record shows that installation as `unknown`.
 * @param statuses - the records the caller read, each absent when it was not read.
 * @returns one status per installation, `cli-home` first.
 */
function installationStatuses(statuses: ReportInput['statuses']): readonly InstallationStatus[] {
  return INSTALLATIONS.map((id: Installation): InstallationStatus => statuses[id] ?? { id, state: 'unknown' })
}

/**
 * Refuse a target whose signature or freshness check did not pass, or whose release-log check failed. A log check that
 * did not complete (`unchecked`) gets a report, which states it, and `delorun update --yes` does not confirm it.
 * @param target - the staged target.
 * @throws {UpdateReportError} `REPORT_TARGET_UNVERIFIED` naming the checks that failed.
 */
function assertVerified(target: TargetFacts): void {
  const failed = RELEASE_CHECKS.filter(check => check === 'log' ? target.release.log === 'failed' : target.release[check] !== 'passed')
  if (failed.length > 0) throw new UpdateReportError('REPORT_TARGET_UNVERIFIED', `the target's ${failed.join(', ')} check did not pass; no report is made for it`)
}

/**
 * The running and target version of each axis, for the plugin checks.
 * @param from - the running release.
 * @param to - the target release.
 * @returns both axes' versions.
 */
function axisVersions(from: ReportVersions, to: ReportVersions): Readonly<Record<VersionAxis, AxisVersions>> {
  return { dsh: { from: from.dsh, to: to.dsh }, delo: { from: from.delo, to: to.delo } }
}

/**
 * The plugins a report disables, by package name, for a caller that reads a report it did not build.
 * @param report - the report.
 * @returns the disabled plugins' names, in report order.
 */
export function disabledPluginNames(report: UpdateReport): readonly string[] {
  return report.items.flatMap(item => item.kind === 'plugin' && item.effect === 'disabled' ? [item.subject.name] : [])
}

/**
 * Build the report for one installation and one target release.
 * @param input - the installation, the running and target releases, the profile, both status records, the data and
 *   harness facts, and the time.
 * @returns the report, with its items sorted and counted.
 * @throws {UpdateReportError} `REPORT_TARGET_UNVERIFIED` when the target did not pass every check.
 */
export function buildUpdateReport(input: ReportInput): UpdateReport {
  const { from, target, profile, generated } = input
  assertVerified(target)
  const plugins = pluginItems(profile.plugins, axisVersions(from, target.versions), profile.exemptions, target.revocations)
  const items = sortItems([
    ...plugins.items,
    ...bundleItems(profile.bundles, target.bundles),
    // The bundles' layers apply first, then the person's patch layers, as upstream composes them.
    ...rowItems([...target.bundles.layers, ...profile.layers], plugins.disabled),
    ...dataItems(input.data),
    ...harnessItems(input.harness),
  ])
  return {
    schema: UPDATE_REPORT_SCHEMA,
    installation: input.installation,
    from,
    to: target.versions,
    release: {
      manifest: target.release.manifest,
      signature: target.release.signature,
      freshness: target.release.freshness,
      log: target.release.log,
    },
    generated,
    installations: installationStatuses(input.statuses),
    items,
    notChecked: target.notChecked,
    counts: countItems(items),
  }
}
