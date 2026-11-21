/**
 * Types and fixed values of contract C3, the update report
 * (`delorun/docs/contracts/c03-update-report.md`). A report is built for one installation and
 * one verified target release before anything changes; the page states when it is made,
 * how an update applies, the health check and the rollback triggers.
 *
 * @module @delorun/contract-update-report
 */

import type { ReleaseChannel, SemanticVersion, Sha256Hex, UtcTimestamp } from '@delorun/contract-release-manifest'
import type { VersionAxis } from '@delorun/contract-plugin-versions'

/** The `schema` value of an update report. */
export const UPDATE_REPORT_SCHEMA = 'delorun.update-report/3'

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
  /** Delorun's version. */
  readonly delorun: SemanticVersion
  /** Upstream's version. */
  readonly dsh: SemanticVersion
  /** The channel. */
  readonly channel: ReleaseChannel
}

/** One installation's versions and update state, from its status record. */
export interface InstallationStatus {
  /** Which installation. */
  readonly id: Installation
  /** Its Delorun version, absent when `state` is `unknown`. */
  readonly delorun?: SemanticVersion
  /** Its DSH version, absent when `state` is `unknown`. */
  readonly dsh?: SemanticVersion
  /** Its update state. */
  readonly state: UpdateState
  /** The version it is updating to, during an update. */
  readonly target?: SemanticVersion
}

/** The result of the target release's signature or freshness check; a report is shown only when both are `passed`. */
export type ReleaseCheckResult = 'passed' | 'failed'

/**
 * The target release's release-log check state, as the install recorded it (contract C18): `passed` when the online
 * check verified it, `unchecked` when the bundle verified offline and the online check did not complete, `failed` for
 * a verifiable failure. A report is shown for `passed` and `unchecked`; `delorun update --yes` confirms only `passed`.
 */
export type LogCheckResult = 'passed' | 'unchecked' | 'failed'

/** What an item is about. */
export type ItemKind = 'plugin' | 'bundle' | 'row' | 'data' | 'harness'

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

/** The home directories whose chat data a `data` item is about. */
export type SessionDataDirectory = 'sessions' | 'storages'

/** The directories a session-data copy holds, in copy order. */
export const SESSION_DATA_DIRECTORIES: readonly SessionDataDirectory[] = ['sessions', 'storages']

/** A `data` subject: the chat data of the home, which both releases read. */
export interface DataSubject {
  /** The home directories the item is about: always {@link SESSION_DATA_DIRECTORIES}. */
  readonly directories: readonly SessionDataDirectory[]
}

/** A `harness` subject: one file of the harness whose approved content differs from the running release's signed file. */
export interface HarnessSubject {
  /** The file's path relative to the runtime's root, `/`-separated, under `app/`. */
  readonly file: string
}

/**
 * How the person's approved content of a harness file meets the target's file, for `harness` items. The first three
 * carry the change; the others are conflicts, where the target's file runs and the person's is kept beside it.
 *
 * - `release-unchanged`: the target's file equals the running release's, so the approved content carries as it is.
 * - `merged`: both releases' files differ and the person's edit applies to the target's file without overlapping it,
 *   so the target runs a file neither side had, which the person confirms (`harness-change-merged`).
 * - `in-release`: the target's file equals the approved content.
 * - `edits-overlap`: the person's edit does not apply to the target's file as it is.
 * - `binary`: both sides changed a file that is not UTF-8 text.
 * - `too-large`: both sides changed a file larger than the merge reads.
 * - `release-removed`: the target has no such file, and the person changed it.
 * - `release-changed-removed`: the person removed the file, and the target changed it.
 * - `both-added`: the running release has no such file, and the target adds one with other content than the person's.
 */
export type HarnessMerge =
  | 'release-unchanged'
  | 'merged'
  | 'in-release'
  | 'edits-overlap'
  | 'binary'
  | 'too-large'
  | 'release-removed'
  | 'release-changed-removed'
  | 'both-added'

/** What the target runs of a carried harness file: its bytes' SHA-256 and its execute bit. */
export interface HarnessResult {
  /** The SHA-256 of the file's bytes. */
  readonly sha256: Sha256Hex
  /** Whether the owner execute bit is set. */
  readonly executable: boolean
}

/**
 * Why a merged harness file's diff does not show its lines: `binary` when a side is not UTF-8 text or holds a NUL byte,
 * `too-large` when a side is larger than 1 MiB, `cut-short` when the report's diffs passed 256 KiB before it.
 */
export type HarnessDiffNotShown = 'binary' | 'too-large' | 'cut-short'

/** A merged harness file's unified diff from the target's signed file to what the target runs. */
export interface HarnessDiff {
  /** The diff text, with `old mode` and `new mode` lines when the execute bit differs; empty when `notShown` is set. */
  readonly text: string
  /** Why the diff does not show the lines, when it does not. */
  readonly notShown?: HarnessDiffNotShown
}

/** The `schema` value of a release's `data-formats.json`. */
export const DATA_FORMATS_SCHEMA = 'delorun.data-formats/1'

/** The file a runtime closure carries at its root, listed in the signed file list. */
export const DATA_FORMATS_FILE = 'data-formats.json'

/** A release's `data-formats.json`: what its persisted data looks like, as digests and record versions. */
export interface DataFormats {
  /** Always {@link DATA_FORMATS_SCHEMA}. */
  readonly schema: typeof DATA_FORMATS_SCHEMA
  /** SHA-256 of upstream's `docs/persistence-schema.json` at the built commit. */
  readonly persistence: Sha256Hex
  /** The versioned records Delorun's own packages keep under the home, by record name. */
  readonly delorunRecords: Readonly<Record<string, number>>
}

/** The `schema` value of the home's data-format record. */
export const HOME_DATA_FORMAT_SCHEMA = 'delorun.home-data-format/1'

/** The home-root file that records which release's data formats last started over this home (contract C1). */
export const HOME_DATA_FORMAT_FILE = 'data-format.json'

/** The home's data-format record: the release that last started over the home and that release's data facts. */
export interface HomeDataFormat {
  /** Always {@link HOME_DATA_FORMAT_SCHEMA}. */
  readonly schema: typeof HOME_DATA_FORMAT_SCHEMA
  /** The Delorun release that wrote the record. */
  readonly delorun: string
  /** That release's DSH version. */
  readonly dsh: string
  /** That release's `data-formats.json`. */
  readonly formats: DataFormats
}

/** Which part of the two releases' data facts differs. */
export type DataFormatDifference = 'dsh' | 'persistence' | 'delorun-records'

/** The size of a session-data copy and the room for it. */
export interface DataCopySize {
  /** Regular files the copy would hold. */
  readonly files: number
  /** Bytes the copy would hold. */
  readonly bytes: number
  /** Bytes free on the home's filesystem. */
  readonly free: number
}

/** Every reason code of report format 3; the list is closed for that format. */
export type ReportReason =
  | 'dsh-requirement-unmet'
  | 'delorun-requirement-unmet'
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
  | 'row-settings-changed'
  | 'data-format-changed'
  | 'data-format-unknown'
  | 'harness-change-carried'
  | 'harness-change-merged'
  | 'harness-change-conflicts'

/** What happens to an item's subject on the target. */
export type ItemEffect = 'disabled' | 'removed' | 'changed' | 'kept'

/** `verified`: every stated fact was read from a source Delorun checked. `unverified`: a fact was missing or unreadable; never counted as safe. */
export type ItemVerification = 'verified' | 'unverified'

/** A choice the report offers for an item. */
export type ItemAction = 'update-plugin' | 'keep-disabled' | 'allow-version' | 'skip-update' | 'copy-session-data' | 'continue-without-copy'

/** A setting's value as a release's bundle patch writes it: a JSON value. */
export type SettingValue = string | number | boolean | null | readonly SettingValue[] | { readonly [key: string]: SettingValue }

/** One setting of a protected row that the target release's bundle sets differently from the running release's. */
export interface SettingChange {
  /** The setting's key in the row's `config`. */
  readonly key: string
  /** The running release's value; absent when its bundle does not set the key. */
  readonly before?: SettingValue
  /** The target release's value; absent when its bundle does not set the key. */
  readonly after?: SettingValue
}

/** How a protected row's settings differ between the two releases' bundles, for `row-settings-changed`. */
export interface RowSettingsDetail {
  /** `changed`: both releases' bundles have the row; `added`: only the target's does; `removed`: only the running release's does. */
  readonly change: 'changed' | 'added' | 'removed'
  /** The settings that differ, in key order; for an added or removed row, every setting the bundle gives it. */
  readonly keys: readonly SettingChange[]
}

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
  /** For `row-disabled`: the row is switched off by a patch of the target release's bundle, not by a plugin the update disables. Readers that do not know the field show the plugin sentence. */
  readonly bundlePatch?: true
  /** For `row-settings-changed`: how the row's settings differ. */
  readonly settings?: RowSettingsDetail
  /** What differs between the two releases' data facts, for `data-format-changed`. */
  readonly differs?: readonly DataFormatDifference[]
  /** Which release's `data-formats.json` is missing or unreadable, for `data-format-unknown`. */
  readonly unreadable?: readonly ('from' | 'to')[]
  /** The size of the session-data copy and the free space, for `data` reasons. */
  readonly copy?: DataCopySize
  /** How the approved content meets the target's file, for `harness` reasons. */
  readonly merge?: HarnessMerge
  /**
   * What the target runs, for `harness-change-carried` and `harness-change-merged` when the target runs a file; an
   * update applies only while its merge still gives this result.
   */
  readonly result?: HarnessResult
  /** The diff from the target's file to what runs, for `harness-change-merged`. */
  readonly diff?: HarnessDiff
}

/** Fields every item has. */
interface ItemFields<K extends ItemKind, S> {
  /** What the item is about. */
  readonly kind: K
  /** The plugin, bundle, row, chat data or harness file. */
  readonly subject: S
  /** Why it changes. */
  readonly reason: ReportReason
  /** What happens to it. */
  readonly effect: ItemEffect
  /** Whether the prediction rests on metadata Delorun read. */
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
  | ItemFields<'data', DataSubject>
  | ItemFields<'harness', HarnessSubject>

/** A source the report did not read, so no item rests on it: `revocations`, the target's revocation list, when the target publishes none. */
export type UncheckedSource = 'revocations'

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
    readonly log: LogCheckResult
  }
  /** When it was built. */
  readonly generated: UtcTimestamp
  /** Both installations' versions and states. */
  readonly installations: readonly InstallationStatus[]
  /** Every change, sorted by kind, then subject. */
  readonly items: readonly ReportItem[]
  /** The sources the report did not read; the person is told, and the health check is what holds them. */
  readonly notChecked: readonly UncheckedSource[]
  /** Items per effect, unverified items, `data` items and `harness` items. */
  readonly counts: {
    readonly disabled: number
    readonly removed: number
    readonly changed: number
    readonly unverified: number
    readonly data: number
    readonly harness: number
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

/** The `schema` value of the update-check record, `run/<profile>/update-check.json` (contract C3, "Update check"). */
export const UPDATE_CHECK_SCHEMA = 'delorun.update-check/1'

/** The channel's newest release as the update check verified it: the facts its signed manifest states. */
export interface CheckedRelease {
  /** Delorun's version of the release. */
  readonly delorun: SemanticVersion
  /** Upstream's version the release is built on. */
  readonly dsh: SemanticVersion
  /** The channel the release is published on. */
  readonly channel: ReleaseChannel
  /** Whether the release is marked as a security fix; false for a manifest that carries no mark. */
  readonly security: boolean
  /** The release's one-line summary; absent for a manifest that carries none. */
  readonly summary?: string
  /**
   * The release notes the check downloaded and verified against the signed manifest, named by their digest; absent
   * when the manifest names none or the check could not verify them. The text is served only while the stored notes
   * file has this digest and length.
   */
  readonly notes?: { readonly sha256: Sha256Hex, readonly length: number }
}

/** Why the last update check failed, as a closed list: the record stores the code, never a message the check received. */
export type UpdateCheckFailure =
  /** The running release's stored, signed files did not read or verify, so the channel to ask is unknown. */
  | 'running-release-unreadable'
  /** The home stores no usable trusted root or timestamp, so nothing could be verified. */
  | 'trust-state-invalid'
  /** A request did not answer, failed or passed its size limit. */
  | 'unreachable'
  /** A request named a host or a redirect the download rule refuses. */
  | 'download-refused'
  /** The check's deadline passed. */
  | 'deadline'
  /** The timestamp, a root or the manifest did not verify. */
  | 'unverified'
  /** The release's log bundle did not verify. */
  | 'log-bundle-invalid'
  /** The verified timestamp is older than the one an earlier check verified, or names an older release. */
  | 'regressed'
  /** The record could not be written, or the check failed in a way this list does not name. */
  | 'internal'

/** Every {@link UpdateCheckFailure}, for readers that validate a record. */
export const UPDATE_CHECK_FAILURES: readonly UpdateCheckFailure[] = ['running-release-unreadable', 'trust-state-invalid', 'unreachable', 'download-refused', 'deadline', 'unverified', 'log-bundle-invalid', 'regressed', 'internal']

/** The update check's record of one CLI profile: when it last ran and what it last verified. */
export interface UpdateCheckRecord {
  /** Always {@link UPDATE_CHECK_SCHEMA}. */
  readonly schema: typeof UPDATE_CHECK_SCHEMA
  /** When the last check ran, whether it succeeded or not. */
  readonly checked: UtcTimestamp
  /** The newest release the last successful check verified; absent before any check succeeded. */
  readonly newest?: CheckedRelease
  /** When {@link UpdateCheckRecord.newest} was verified. */
  readonly verified?: UtcTimestamp
  /** The `version` of the timestamp that named {@link UpdateCheckRecord.newest}; a later check refuses an older one. */
  readonly timestamp?: number
  /** Why the last check failed; absent when it succeeded. */
  readonly failure?: UpdateCheckFailure
}

/** How far a newer release moves from the running one, by its semantic version. */
export type UpdateKind = 'patch' | 'minor' | 'major'

/** A newer release than the one that runs, as the terminal, `delorun doctor` and the studio show it. */
export interface UpdateNotice {
  /** The release that runs. */
  readonly running: { readonly delorun: SemanticVersion, readonly dsh: SemanticVersion }
  /** The newer release. */
  readonly release: CheckedRelease
  /** How far it moves. */
  readonly kind: UpdateKind
  /** How many installed plugins of the profile the release would disable on either version axis. */
  readonly disables: number
}

/** The harness's Connection Fetch route that answers `GET` with {@link UpdateNotesResponse}. */
export const UPDATE_NOTES_PATH = '/api/delorunUpdateCheck.notes'

/** The answer of {@link UPDATE_NOTES_PATH}: the plain-text notes and the release they belong to, or `null` for both when there are none to show. */
export interface UpdateNotesResponse {
  /** The release the notes belong to; a client shows the notes only for the notice of this release. */
  readonly version: SemanticVersion | null
  /** The verified notes, plain text, or `null`. */
  readonly notes: string | null
}

/** The command a notice names; the notice itself applies nothing. */
export const UPDATE_COMMAND = 'delorun update'

/** The harness's Connection Fetch route that answers `GET` with {@link UpdateNoticeResponse}. */
export const UPDATE_NOTICE_PATH = '/api/delorunUpdateCheck.notice'

/** The harness's Connection Fetch route that answers `GET` with {@link UpdateChannelResponse}; it is served whether or not the release check is on. */
export const UPDATE_CHANNEL_PATH = '/api/delorunUpdateCheck.channel'

/** The answer of {@link UPDATE_CHANNEL_PATH}: the host the release check contacts when this installation's launcher was built for another channel. */
export interface UpdateChannelResponse {
  /**
   * The host, with its port when it has one, of the channel origin recorded in the home's `trust/channel.json`; the
   * channel serves the timestamp, the root file, the manifest and the log record, so no other host is contacted.
   * `null` on the production channel, which contacts releases.delorun.com and GitHub.
   */
  readonly host: string | null
}

/** The answer of {@link UPDATE_NOTICE_PATH}: the notice, or `null` when no newer release is known. */
export interface UpdateNoticeResponse {
  /** The notice, or `null`. */
  readonly notice: UpdateNotice | null
}
