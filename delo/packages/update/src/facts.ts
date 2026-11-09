/**
 * What the report is built from: the profile as it is installed, the target release as it is staged, and both
 * installations' status records. C3 says the report "reads the profile and the staged target, and imports no plugin
 * code", so every fact here is read from a file — a manifest, the profile's bundle list, a patch layer, the target's
 * own bundle tables — and none of it is a plugin module. Reading those files is a caller's work
 * ({@link ReportSources} in `./service.ts`); deciding what they mean is this package's.
 *
 * @module @delo/update/facts
 */
import type { ExemptionRecord, VersionAxis } from '@delo/contract-plugin-versions'
import type { SemanticVersion, Sha256Hex, UtcTimestamp } from '@delo/contract-release-manifest'
import type { Installation, InstallationStatus, ReleaseCheckResult, ReportVersions } from '@delo/contract-update-report'
import type { InstalledPluginFact } from './manifest.ts'

/** The target release's manifest digest and the result of each check C2 and C18 give it. */
export interface ReleaseChecks {
  /** The verified manifest's SHA-256. */
  readonly manifest: Sha256Hex
  /** C2's signature check. */
  readonly signature: ReleaseCheckResult
  /** C2's freshness check: the signed timestamp is current and not replayed. */
  readonly freshness: ReleaseCheckResult
  /** C18's release-log check. */
  readonly log: ReleaseCheckResult
}

/** One revocation the target's catalogue list holds (C13), as the report reads it. */
export interface RevokedPluginVersion {
  /** The plugin package the revocation names. */
  readonly package: string
  /** The revoked exact versions. */
  readonly versions: readonly SemanticVersion[]
  /** The reason code, such as `malicious`. */
  readonly reason: string
  /** The English text shown with the reason. */
  readonly message: string
}

/** A bundle the target cannot load, with the failure upstream's profile load reported. */
export interface SkippedBundleFact {
  /** The bundle's package name from the profile's bundle list. */
  readonly package: string
  /** The failure text, which the item's detail carries and its sentence quotes. */
  readonly reason: string
}

/**
 * What the report predicts about the profile's bundle list on the target: upstream's `RETIRED_BUNDLES`, the template
 * DSH writes when the list is installation-owned, and the bundles the target skipped.
 */
export interface BundleFacts {
  /** Bundles retired in the target: they leave the bundle list. */
  readonly retired: readonly string[]
  /**
   * The target's template list, present when the profile's list matches an installation-owned list that DSH replaces
   * with its template. Its presence means the whole list is replaced, not that the bundles in it changed one by one.
   */
  readonly template?: readonly string[]
  /** Bundles the target could not load, in the profile's order. */
  readonly skipped: readonly SkippedBundleFact[]
}

/** The staged target release. */
export interface TargetFacts {
  /** The target's Delo, DSH and channel. */
  readonly versions: ReportVersions
  /** Its manifest digest and check results. A report is shown only when all three passed. */
  readonly release: ReleaseChecks
  /** What changes in the profile's bundle list on the target. */
  readonly bundles: BundleFacts
  /** The target's revocation list, as the fresh list Delo verified before the update. */
  readonly revocations: readonly RevokedPluginVersion[]
}

/** An Include a row pulls in, with the rows it brings. */
export interface IncludeFact {
  /** The file the Include names, as the person sees it in the patch. */
  readonly file: string
  /** The rows the included file brings, in order. */
  readonly rows: readonly RowFact[]
}

/** One row of one patch layer. */
export interface RowFact {
  /** The row's id, when the patch gives one. */
  readonly id?: string
  /** The plugin name or resolved module URL the row loads. */
  readonly name: string
  /** The plugin packages the row loads directly. */
  readonly plugins?: readonly string[]
  /** The Include this row is, when it is one; the rows it brings are in the file it names. */
  readonly include?: IncludeFact
}

/** One patch layer the profile composes, with its rows. */
export interface LayerFact {
  /** The layer's name: the bundle, the profile patch, the home patch or the overlay that holds the rows. */
  readonly layer: string
  /** The layer's rows, in application order. */
  readonly rows: readonly RowFact[]
}

/** The profile as the update would find it, before anything changes. */
export interface ProfileFacts {
  /** The installed plugins, from the profile's dependency listing and their own manifests. */
  readonly plugins: readonly InstalledPluginFact[]
  /** The profile's bundle list, in the order it is written. */
  readonly bundles: readonly string[]
  /** The layers the profile composes, each with its rows. */
  readonly layers: readonly LayerFact[]
  /** Both exemption files as the profile holds them now. */
  readonly exemptions: Readonly<Record<VersionAxis, ExemptionRecord>>
}

/** Both installations' status records, each absent when its record is absent or unreadable. */
export type InstallationStatusFacts = Readonly<Partial<Record<'cli-home' | 'desktop-host', InstallationStatus>>>

/** Everything one report is built from. */
export interface ReportInput {
  /** The installation being updated; the other one is shown beside it and never switches. */
  readonly installation: Installation
  /** The release this installation runs. */
  readonly from: ReportVersions
  /** The staged target release. */
  readonly target: TargetFacts
  /** The profile as it is installed. */
  readonly profile: ProfileFacts
  /** Both installations' status records, as each writes them. */
  readonly statuses: InstallationStatusFacts
  /** When the report was built. */
  readonly generated: UtcTimestamp
}
