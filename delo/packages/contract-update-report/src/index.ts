/**
 * Types and fixed values of contract C3, the update report
 * (`delo/docs/contracts/c03-update-report.md`). A report is built for one installation and
 * one verified target release before anything changes; the page states when it is made,
 * how an update applies, the health check and the rollback triggers.
 *
 * @module @delo/contract-update-report
 */

import type { ReleaseChannel, SemanticVersion, Sha256Hex, UtcTimestamp } from '@delo/contract-release-manifest'
import type { VersionAxis } from '@delo/contract-plugin-versions'

/** The `schema` value of an update report. */
export const UPDATE_REPORT_SCHEMA = 'delo.update-report/1'

/** The two installations that update independently: the CLI home and the desktop app with its Host. */
export type Installation = 'cli-home' | 'desktop-host'

/** Both installations in display order. */
export const INSTALLATIONS: readonly Installation[] = ['cli-home', 'desktop-host']

/** An installation's update state; `unknown` only for the other installation when its status record is absent or unreadable. */
export type UpdateState =
  | 'current'
  | 'available'
  | 'downloading'
  | 'verifying'
  | 'reporting'
  | 'awaiting-confirmation'
  | 'waiting-for-chats'
  | 'applying'
  | 'health-check'
  | 'rolling-back'
  | 'rolled-back'
  | 'failed'
  | 'unknown'

/** Upstream's `DesktopUpdateState.phase` values. */
export type DesktopUpdatePhase = 'idle' | 'checking' | 'available' | 'downloading' | 'verifying' | 'installing' | 'ready' | 'error'

/** How the desktop app reports each upstream phase as an {@link UpdateState}. */
export const DESKTOP_PHASE_STATES: Readonly<Record<DesktopUpdatePhase, UpdateState>> = {
  idle: 'current',
  checking: 'current',
  available: 'available',
  downloading: 'downloading',
  verifying: 'verifying',
  ready: 'awaiting-confirmation',
  installing: 'applying',
  error: 'failed',
}

/** A release's identity in a report. */
export interface ReportVersions {
  /** Delo's version. */
  readonly delo: SemanticVersion
  /** Upstream's version. */
  readonly dsh: SemanticVersion
  /** The channel. */
  readonly channel: ReleaseChannel
}

/** One installation's versions and update state, from its status record. */
export interface InstallationStatus {
  /** Which installation. */
  readonly id: Installation
  /** Its Delo version, absent when `state` is `unknown`. */
  readonly delo?: SemanticVersion
  /** Its DSH version, absent when `state` is `unknown`. */
  readonly dsh?: SemanticVersion
  /** Its update state. */
  readonly state: UpdateState
  /** The version it is updating to, during an update. */
  readonly target?: SemanticVersion
}

/** The result of one check on the target release; a report is shown only when all are `passed`. */
export type ReleaseCheckResult = 'passed' | 'failed'

/** What an item is about. */
export type ItemKind = 'plugin' | 'bundle' | 'row'

/** A plugin subject. */
export interface PluginSubject {
  /** The package name. */
  readonly name: string
  /** The installed version. */
  readonly version: SemanticVersion
}

/** A bundle subject. */
export interface BundleSubject {
  /** The bundle's package name in the profile's bundle list. */
  readonly package: string
}

/** A profile row subject. */
export interface RowSubject {
  /** The row's id, when it has one. */
  readonly id?: string
  /** The row's plugin name or resolved module URL. */
  readonly name: string
  /** The bundle, profile patch, home patch or overlay holding the row. */
  readonly layer: string
}

/** Every reason code of report format 1; the list is closed for that format. */
export type ReportReason =
  | 'dsh-requirement-unmet'
  | 'delo-requirement-unmet'
  | 'requirement-unreadable'
  | 'requirement-exempted'
  | 'exemption-not-carried'
  | 'requirement-undeclared'
  | 'plugin-revoked'
  | 'manifest-unreadable'
  | 'bundle-retired'
  | 'bundle-template-normalised'
  | 'bundle-skipped'
  | 'row-disabled'
  | 'row-include-blocked'

/** What happens to an item's subject on the target. */
export type ItemEffect = 'disabled' | 'removed' | 'changed' | 'kept'

/** `verified`: every stated fact was read from a source Delo checked. `unverified`: a fact was missing or unreadable; never counted as safe. */
export type ItemVerification = 'verified' | 'unverified'

/** A choice the report offers for an item. */
export type ItemAction = 'update-plugin' | 'keep-disabled' | 'allow-version' | 'skip-update'

/** The facts behind an item's reason. */
export interface ItemDetail {
  /** The version axis, for requirement reasons. */
  readonly axis?: VersionAxis
  /** The declared range, for requirement reasons. */
  readonly requirement?: string
  /** The revocation's reason code and message, for `plugin-revoked`. */
  readonly revocation?: { readonly reason: string, readonly message: string }
  /** The failure text upstream reported, for `bundle-skipped`. */
  readonly failure?: string
  /** The plugin a row or Include reaches, for row reasons. */
  readonly plugin?: PluginSubject
}

/** Fields every item has. */
interface ItemFields<K extends ItemKind, S> {
  /** What the item is about. */
  readonly kind: K
  /** The plugin, bundle or row. */
  readonly subject: S
  /** Why it changes. */
  readonly reason: ReportReason
  /** What happens to it. */
  readonly effect: ItemEffect
  /** Whether the prediction rests on metadata Delo read. */
  readonly verification: ItemVerification
  /** The reason's facts. */
  readonly detail: ItemDetail
  /** Offered choices. */
  readonly actions: readonly ItemAction[]
}

/** One change the report names, discriminated by `kind`. */
export type ReportItem =
  | ItemFields<'plugin', PluginSubject>
  | ItemFields<'bundle', BundleSubject>
  | ItemFields<'row', RowSubject>

/** An update report, stored in the snapshot's history version. */
export interface UpdateReport {
  /** Always {@link UPDATE_REPORT_SCHEMA}. */
  readonly schema: typeof UPDATE_REPORT_SCHEMA
  /** The installation being updated. */
  readonly installation: Installation
  /** The running release. */
  readonly from: ReportVersions
  /** The target release. */
  readonly to: ReportVersions
  /** The target's manifest digest and check results. */
  readonly release: {
    readonly manifest: Sha256Hex
    readonly signature: ReleaseCheckResult
    readonly freshness: ReleaseCheckResult
    readonly log: ReleaseCheckResult
  }
  /** When it was built. */
  readonly generated: UtcTimestamp
  /** Both installations' versions and states. */
  readonly installations: readonly InstallationStatus[]
  /** Every change, sorted by kind, then subject. */
  readonly items: readonly ReportItem[]
  /** Items per effect, and unverified items. */
  readonly counts: {
    readonly disabled: number
    readonly removed: number
    readonly changed: number
    readonly unverified: number
  }
}

/** Health-check criteria, each of which must hold within {@link HEALTH_CHECK_LIMIT_SECONDS}. */
export type HealthCriterion =
  /** Runtime files verify against the target manifest and the release-log state is not `failed`. */
  | 'H1-release-verified'
  /** The Host reaches ready and the studio loads. */
  | 'H2-host-ready'
  /** Every disabled, skipped or removed subject is one the report named. */
  | 'H3-only-named-disabled'
  /** Every row the report did not name loads without a new load error. */
  | 'H4-unnamed-rows-load'
  /** The bundle list equals the report's prediction. */
  | 'H5-bundle-list-predicted'

/** Every health criterion in order. */
export const HEALTH_CRITERIA: readonly HealthCriterion[] = [
  'H1-release-verified',
  'H2-host-ready',
  'H3-only-named-disabled',
  'H4-unnamed-rows-load',
  'H5-bundle-list-predicted',
]

/** Why a rollback runs. T1 to T3 are automatic; `requested` is the person's choice at any later time. */
export type RollbackTrigger =
  /** A health criterion failed. */
  | 'T1-health-criterion-failed'
  /** The health check did not finish within the limit. */
  | 'T2-health-check-timeout'
  /** The target's Host process exited during the health check. */
  | 'T3-host-exited'
  /** The person asked. */
  | 'requested'

/** Time the health check may take after the target starts: 120 seconds. */
export const HEALTH_CHECK_LIMIT_SECONDS = 120

/** HTTP status the CLI home's studio index answers with on its loopback listener for H2. */
export const HEALTH_CHECK_STUDIO_STATUS = 200

/** What an undo or restore approval prompt lists before anything is written. */
export interface RestoreChanges {
  /** Plugins added, removed or moved to another version. */
  readonly plugins: readonly { readonly name: string, readonly from?: SemanticVersion, readonly to?: SemanticVersion }[]
  /** pnpm `allowBuilds` entries the restored version allows, denies or leaves pending. */
  readonly builds: readonly { readonly key: string, readonly from?: boolean | 'pending', readonly to?: boolean | 'pending' }[]
  /** Exemption grants added or removed, per axis file. */
  readonly exemptions: readonly { readonly axis: VersionAxis, readonly key: string, readonly version: SemanticVersion, readonly change: 'added' | 'removed' }[]
}
