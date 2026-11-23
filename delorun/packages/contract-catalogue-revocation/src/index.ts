/**
 * Types and fixed values of contract C13, the catalogue index and revocation list
 * (`delorun/docs/contracts/c13-catalogue-revocation.md`). Both files are
 * `SignedEnvelope`s of contract C2 signed by the catalogue role; the page states the
 * display rules for badges and listed findings, the stale state and disabling at load.
 *
 * @module @delorun/contract-catalogue-revocation
 */

import type { Branded } from '@deepseek-ai/dsh-brand'
import type { NpmIntegrity, ReleaseChannel, SemanticVersion, Sha256Hex, UtcTimestamp } from '@delorun/contract-release-manifest'

/** An npm package name. */
export type PackageName = Branded<'delorun.catalogue.PackageName'>

/** The `schema` values of the two catalogue files. */
export const CATALOGUE_SCHEMAS = {
  index: 'delorun.catalogue-index/1',
  revocations: 'delorun.catalogue-revocations/1',
} as const

/** Where the catalogue files are served; the host is not trusted. */
export const CATALOGUE_ORIGIN = 'https://catalogue.delorun.com'

/** The repository whose publish job signs the catalogue files. */
export const CATALOGUE_REPOSITORY = 'TwickaS/delorun-plugins'

/** A plugin author named in an index entry. */
export interface CatalogueAuthor {
  /** Display name. */
  readonly name: string
  /** GitHub login. */
  readonly github: string
}

/** The only badge kind, shown only as "Tested with Delorun <delorun>". */
export type BadgeKind = 'tested-with-delorun'

/** A corpus result for one plugin version on one Delorun release. Only the publish job, which runs no plugin code, writes it. */
export interface BadgeRecord {
  /** Always `tested-with-delorun`. */
  readonly kind: BadgeKind
  /** The Delorun release the corpus ran. */
  readonly delorun: SemanticVersion
  /** That release's upstream version. */
  readonly dsh: SemanticVersion
  /** That release's channel. */
  readonly channel: ReleaseChannel
  /** The corpus result; the studio shows only `passed`. */
  readonly result: 'passed' | 'failed'
  /** The corpus revision, a 40-hex commit. */
  readonly corpus: string
  /** URL of the CI run. */
  readonly run: string
  /** When the publish job recorded it. */
  readonly recorded: UtcTimestamp
}

/** Severity as a finding's author rates it. */
export type FindingSeverity = 'info' | 'low' | 'medium' | 'high' | 'critical'

/** Who listed a finding. */
export type FindingAuthorRole = 'plugin-author' | 'reviewer'

/**
 * A finding listed for a plugin version: a claim by its author that Delorun does not verify.
 * The studio renders it with "Claim by <name>, not verified by Delorun" and its detail as plain text.
 * Its digest for the acceptance ledger is the SHA-256 of its RFC 8785 canonical JSON.
 */
export interface ListedFinding {
  /** Unique within the entry; at most 64 characters of `[a-z0-9-]`. */
  readonly id: string
  /** The author's rating. */
  readonly severity: FindingSeverity
  /** At most 120 characters. */
  readonly title: string
  /** Plain text, at most 4,000 characters; never rendered as HTML or links. */
  readonly detail: string
  /** Who claims it. */
  readonly author: { readonly role: FindingAuthorRole, readonly name: string, readonly github: string }
  /** When it was listed, `YYYY-MM-DD`. */
  readonly reported: string
  /** A later version its author says fixes it. */
  readonly fixedIn?: SemanticVersion
}

/** One published plugin version in the index. */
export interface CatalogueVersion {
  /** Exact version. */
  readonly version: SemanticVersion
  /** The npm tarball's integrity; installs pin it and refuse a mismatch. */
  readonly integrity: NpmIntegrity
  /** The ranges the package declares (contract C17). */
  readonly engines: { readonly dsh?: string, readonly delorun?: string }
  /** Corpus results. */
  readonly badges: readonly BadgeRecord[]
  /** Listed findings, at most {@link MAX_FINDINGS_PER_VERSION}. */
  readonly findings: readonly ListedFinding[]
}

/** One plugin package in the index. */
export interface CatalogueEntry {
  /** The plugin's npm package; unique in the index. */
  readonly package: PackageName
  /** Sentence-case title, at most 80 characters. */
  readonly title: string
  /** At most 300 characters. */
  readonly description: string
  /** HTTPS URL of the source repository. */
  readonly repository: string
  /** SPDX license expression. */
  readonly license: string
  /** The plugin's author. */
  readonly author: CatalogueAuthor
  /** Number of the pull request that added the entry. */
  readonly addedBy: number
  /** Newest first; at least 1. */
  readonly versions: readonly CatalogueVersion[]
}

/** `index.json`. */
export interface CatalogueIndex {
  /** Always {@link CATALOGUE_SCHEMAS}.index. */
  readonly schema: typeof CATALOGUE_SCHEMAS.index
  /** Adds 1 at every signing; a lower value than the stored one is refused. */
  readonly sequence: number
  /** When it was signed. */
  readonly issued: UtcTimestamp
  /** Exactly {@link INDEX_LIFETIME_SECONDS} after `issued`. */
  readonly expires: UtcTimestamp
  /** Sorted by `package`. */
  readonly entries: readonly CatalogueEntry[]
}

/** Why a plugin version is revoked. */
export type RevocationReason = 'malicious' | 'vulnerable' | 'broken' | 'author-request'

/** One revocation; it applies to the package however it was installed. */
export interface Revocation {
  /** The plugin package. */
  readonly package: PackageName
  /** The revoked exact versions, at least 1. */
  readonly versions: readonly SemanticVersion[]
  /** The reason code. */
  readonly reason: RevocationReason
  /** English text shown with the reason, at most 500 characters. */
  readonly message: string
  /** HTTPS URL of a public advisory. */
  readonly advisory?: string
  /** When it was added. */
  readonly revoked: UtcTimestamp
}

/** `revocations.json`. A malformed revocation refuses the whole list. */
export interface RevocationList {
  /** Always {@link CATALOGUE_SCHEMAS}.revocations. */
  readonly schema: typeof CATALOGUE_SCHEMAS.revocations
  /** Adds 1 at every signing; a lower value than the stored one is refused, an equal one must have identical bytes. */
  readonly sequence: number
  /** When it was signed. */
  readonly issued: UtcTimestamp
  /** Exactly {@link REVOCATION_LIST_LIFETIME_SECONDS} after `issued`. */
  readonly expires: UtcTimestamp
  /** Sorted by `package`, then `revoked`. */
  readonly revocations: readonly Revocation[]
}

/**
 * The revocation list's state on a client. `fresh`: a verified list within its expiry and the
 * maximum cache age. `stale`: past the maximum cache age or its expiry, or no list verified yet;
 * new catalogue installs are refused, installed plugins keep loading with already revoked
 * versions disabled, and the Host retries. `off`: the person turned catalogue fetching off.
 */
export type RevocationListState = 'fresh' | 'stale' | 'off'

/** One acceptance-ledger record of a listed finding the person accepted. */
export interface FindingAcceptance {
  /** The plugin package. */
  readonly package: PackageName
  /** The exact version. */
  readonly version: SemanticVersion
  /** The accepted finding's digest; a changed finding asks again. */
  readonly finding: Sha256Hex
}

/** Maximum cache age of the revocation list: 24 hours. */
export const REVOCATION_LIST_MAX_CACHE_AGE_SECONDS = 86_400

/** Revocation list lifetime: 48 hours after `issued`. */
export const REVOCATION_LIST_LIFETIME_SECONDS = 172_800

/** Interval at which the publish job re-signs both files: 24 hours. */
export const CATALOGUE_RESIGN_INTERVAL_SECONDS = 86_400

/** Revocation list refresh interval while the Host runs: 6 hours. */
export const REVOCATION_LIST_REFRESH_SECONDS = 21_600

/** Retry interval while the revocation list is stale: 15 minutes. */
export const STALE_RETRY_INTERVAL_SECONDS = 900

/** Index lifetime: 7 days after `issued`. */
export const INDEX_LIFETIME_SECONDS = 604_800

/** Size limits in bytes, applied before parsing. */
export const CATALOGUE_FILE_SIZE_LIMITS = {
  index: 16 * 1024 * 1024,
  revocations: 1024 * 1024,
} as const

/** Maximum listed findings per plugin version. */
export const MAX_FINDINGS_PER_VERSION = 50

/** Text limits in characters. */
export const CATALOGUE_TEXT_LIMITS = {
  title: 80,
  description: 300,
  findingId: 64,
  findingTitle: 120,
  findingDetail: 4_000,
  revocationMessage: 500,
} as const

/** Request timeout for both files. */
export const CATALOGUE_REQUEST_TIMEOUT_SECONDS = 30

/** Wording no screen uses about a plugin, compared case-insensitively. */
export const FORBIDDEN_PLUGIN_WORDING: readonly string[] = ['audited', 'safe', 'no findings']
