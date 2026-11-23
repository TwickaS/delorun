/**
 * The trust bill: what this Delorun runs and how much of it was checked, as `delorun verify --json` prints it under `bill`
 * and the `delorun-trust` row serves it to the studio, and the four rows and the badge the studio derives from it. A bill
 * holds data only, no sentence: the studio words every state through its own dictionaries, and `delorun verify` prints
 * its own lines. A value the producer could not read is `null` or a `status: 'unknown'` section, never a default that
 * reads as checked.
 *
 * The rows never read as a plain pass while anything is failed, unchecked or unknown: {@link trustBadge} is `verified`
 * only when every row is. Each row also has a tone: red for a failed check, amber for a release whose state is unknown,
 * an unchecked or unknown release log, a plugin from npm, git or a tarball that changed after its install, and a
 * critical advisory; neutral for everything else that is not verified. The person's own changes are a neutral count,
 * never a warning.
 *
 * Browser-safe: the Host row, the CLI and the studio import it.
 *
 * @module @delorun/bundle-local/client/trust-bill
 */

/** The schema name and major version of a bill. Readers refuse any other value. */
export const TRUST_BILL_SCHEMA = 'delorun.trust-bill/1'

/** The route the studio reads the bill from; a device the home approved may read it. */
export const TRUST_BILL_PATH = '/api/delorunTrust.bill'

/** The route that runs the `verify` stage and answers the new bill; only the home's own computer reaches it. */
export const TRUST_CHECK_PATH = '/api/delorunTrust.check'

/** A check's outcome inside a bill, contract C15's results without `not-enforced`, which no bill check yields. */
export type TrustCheckResult = 'pass' | 'fail' | 'unknown'

/**
 * How the bill was produced. `start` is assembled from the launcher's start check and the stored release-log record
 * without hashing anything again; `verify` is a run of the `verify` stage, which hashes every runtime file and runs the
 * online release-log check.
 */
export type TrustBillStage = 'start' | 'verify'

/** What the launcher's start check did before this runtime started, as it handed it over. */
export interface TrustStartCheck {
  /** When it ran, RFC 3339 UTC. */
  readonly at: string
  /** Whether it hashed every runtime file; false when the identity record vouched for some. */
  readonly full: boolean
  /** How many files it hashed. */
  readonly hashed: number
  /** How many files the signed file list names. */
  readonly files: number
  /** `runtime` when the runtime checked its own files at start because its predecessor handed over no check; absent for the launcher's. */
  readonly checkedBy?: 'runtime'
}

/** The release that runs, its signature and its files. */
export interface TrustRelease {
  /** Delorun's version of the running release; `null` when it cannot be read. */
  readonly version: string | null
  /** The 40-hex commit the signed manifest names; `null` when no manifest verified. */
  readonly commit: string | null
  /** The SHA-256 of the stored manifest's bytes; `null` when no manifest verified. */
  readonly manifestSha256: string | null
  /** The SHA-256 of this platform's signed file list, as the manifest names it; `null` when no manifest verified. */
  readonly fileListSha256: string | null
  /** The trusted root the check anchored on; `null` when none read. */
  readonly root: {
    readonly version: number
    /** The root role's key ids. */
    readonly keyIds: readonly string[]
    /** `shipped` when the launcher's shipped roots lead to it; `stored` when only its own signatures were checked. */
    readonly anchored: 'shipped' | 'stored'
  } | null
  /** The launcher that started this runtime; both fields `null` when no launcher handed itself over. */
  readonly launcher: { readonly version: string | null, readonly path: string | null }
  /**
   * When every runtime file was last hashed, RFC 3339 UTC: this run's own time for a `verify` bill, otherwise the
   * identity record's, which any program running as the person can rewrite. `null` when neither is known.
   */
  readonly lastFullHashAt: string | null
  /** The launcher's start check; `null` when this runtime was not started by the launcher. */
  readonly startCheck: TrustStartCheck | null
  /** The signature check: the root's anchor and expiry, the manifest's signature and, in `verify`, the timestamp's freshness. */
  readonly signature: TrustCheckResult
  /** The runtime files against the signed file list. */
  readonly files: TrustCheckResult
  /** One line of what failed or could not run, as the producer wrote it; absent on a pass. */
  readonly detail?: string
}

/** Contract C18's states of the running release, or `unknown` when no record reads. */
export type TrustReleaseLogState = 'verified' | 'unchecked' | 'failed' | 'unknown'

/** The release-log check of the running release, as the home recorded it. */
export interface TrustReleaseLog {
  readonly state: TrustReleaseLogState
  /** When the check last ran, RFC 3339 UTC; `null` when unknown. */
  readonly lastAttempt: string | null
  /** Since when the release has stayed `unchecked`, RFC 3339 UTC; `null` unless the state is `unchecked`. */
  readonly uncheckedSince: string | null
  /** What the check saw or why it did not complete; absent when it verified. */
  readonly detail?: string
}

/** Where a plugin's code came from, as the profile's `package.json` declares it. */
export type TrustPluginSource = 'registry' | 'git' | 'link' | 'file' | 'tarball' | 'unknown'

/**
 * A plugin against its install record: `match` when the installed files are the ones the install recorded,
 * `mismatch` when they changed after the install, `unrecorded` when no install record names it, `unknown` when no
 * install check ran.
 */
export type TrustPluginMatch = 'match' | 'mismatch' | 'unrecorded' | 'unknown'

/** One plugin the profile installs. */
export interface TrustPlugin {
  /** The package name. */
  readonly name: string
  readonly source: TrustPluginSource
  /** The installed version; `null` when its `package.json` does not read. */
  readonly version: string | null
  /** The integrity the install recorded, such as `sha512-…`; `null` when none is known. */
  readonly integrity: string | null
  /** The commit a git source resolved to; `null` for another source or when unknown. */
  readonly commit: string | null
  readonly match: TrustPluginMatch
  /** What the install check warned about, as it wrote it. */
  readonly warnings: readonly string[]
  /** The ids of critical advisories that affect the installed version; empty when none is known. */
  readonly criticalAdvisories: readonly string[]
}

/** The profile's plugins; `status: 'unknown'` when the install check is not available or failed. */
export interface TrustPlugins {
  readonly status: 'known' | 'unknown'
  /** Why the plugins are unknown; absent when known. */
  readonly reason?: string
  /** Every plugin the profile installs, even when the install check is unknown. */
  readonly entries: readonly TrustPlugin[]
}

/** The person's changes, as Changes keeps them; `status: 'unknown'` when Changes cannot be read here. */
export interface TrustChanges {
  readonly status: 'known' | 'unknown'
  /** Why the changes are unknown; absent when known. */
  readonly reason?: string
  /** Files of the harness itself the person approved. */
  readonly harnessEdits: readonly { readonly file: string }[]
  /** Plugin versions the person approved. */
  readonly approvedPlugins: readonly { readonly plugin: string, readonly version: string | null, readonly source: string }[]
  /** Changes present that the person has not approved; 0 when unknown. */
  readonly notReviewed: number
}

/** Rows the person's own patch layers add, and the `!!js` values among all their values. */
export interface TrustPatches {
  /** `known` when every patch layer read. */
  readonly status: 'known' | 'unknown'
  /** Why a layer did not read; absent when known. */
  readonly reason?: string
  /** Each inserted row: the layer file it comes from, its id and plugin name when it has them. */
  readonly rows: readonly { readonly layer: string, readonly id: string | null, readonly name: string | null }[]
  /** How many `!!js` values the layers hold, inserted rows and changed rows alike. */
  readonly jsValues: number
}

/** Where skills load from. */
export interface TrustSkills {
  /** Each configured root, with the provider's source name such as `user-agents`. */
  readonly roots: readonly { readonly path: string, readonly source: string }[]
}

/** The MCP servers the profile configures. */
export interface TrustMcp {
  readonly status: 'known' | 'unknown'
  /** Why the servers are unknown; absent when known. */
  readonly reason?: string
  /** Each server's name and transport, such as `stdio` or `http`. */
  readonly servers: readonly { readonly name: string, readonly transport: string | null }[]
}

/**
 * Why Check now ran the `verify` stage inside the Host instead of through the launcher: `no-launcher` when no launcher
 * started this runtime, `launcher-unresolvable` when the launcher it names cannot be run from here, as in a source
 * launch.
 */
export type TrustHostCheckReason = 'no-launcher' | 'launcher-unresolvable'

/**
 * How Check now produced a bill: `launcher` ran `delorun verify` through the launcher, which hashes every runtime file
 * before the command runs; `host` ran it inside the Host, where a changed runtime file that a rewritten identity record
 * vouches for could run unhashed.
 */
export type TrustCheckedBy =
  | { readonly via: 'launcher', readonly seconds: number }
  | { readonly via: 'host', readonly reason: TrustHostCheckReason, readonly seconds: number }

/**
 * How the Host's next Check now will run: through the launcher, or inside the Host and why. The Host works it out when
 * it produces a bill, so the studio's progress names the path the check takes.
 */
export type TrustCheckRoute =
  | { readonly via: 'launcher' }
  | { readonly via: 'host', readonly reason: TrustHostCheckReason }

/** The bill of materials of one Delorun, with what was checked. */
export interface TrustBill {
  readonly schema: typeof TRUST_BILL_SCHEMA
  readonly stage: TrustBillStage
  /** When the bill was produced, RFC 3339 UTC. */
  readonly generatedAt: string
  readonly release: TrustRelease
  readonly releaseLog: TrustReleaseLog
  readonly plugins: TrustPlugins
  readonly changes: TrustChanges
  readonly patches: TrustPatches
  readonly skills: TrustSkills
  readonly mcp: TrustMcp
  /** How Check now produced this bill, and how long it took in seconds; absent on a start bill and in `delorun verify`. */
  readonly checkedBy?: TrustCheckedBy
  /** How the Host's next Check now will run; absent outside a Host. */
  readonly checkNow?: TrustCheckRoute
}

/**
 * Why the background full check cannot make the release Verified: the Host would have to run it itself, because no
 * launcher started this runtime (`no-launcher`) or the one that did cannot be run from here (`launcher-unresolvable`);
 * the last run stopped or failed before it produced a bill (`failed`); or the row's configuration switches the
 * background check off (`off`).
 */
export type TrustFullCheckReason = TrustHostCheckReason | 'failed' | 'off'

/**
 * The background full check, which the Host runs through the launcher, at low priority, once the studio has started
 * and no turn has run for a while: `waiting` until then; `running` while it hashes; `done` once a full check produced
 * the current bill or the start check already hashed every file; `unavailable` with the reason when it cannot run.
 */
export type TrustFullCheck =
  | { readonly state: 'waiting' }
  | { readonly state: 'running' }
  | { readonly state: 'done' }
  | { readonly state: 'unavailable', readonly reason: TrustFullCheckReason }

/** How fresh one row is: when its check last finished and whether one runs now. */
export interface TrustRowFreshness {
  /** When the row's check last finished, RFC 3339 UTC; `null` when it never ran. */
  readonly at: string | null
  /** Whether a check of this row runs now. */
  readonly running: boolean
}

/**
 * How fresh each row is, beside the bill, and the background full check. The Host keeps it; a bill alone, as
 * `delorun verify` prints it, has none.
 */
export interface TrustChecks {
  readonly release: TrustRowFreshness & { readonly full: TrustFullCheck }
  readonly releaseLog: TrustRowFreshness
  readonly plugins: TrustRowFreshness
  readonly changes: TrustRowFreshness
}

/**
 * A row's or the badge's state: `unknown` and `unchecked` are states of their own, never a pass. `attention` is a
 * plugin with a critical advisory. `checking` is a release whose signature and start check passed while the background
 * full check is waiting or running; `checked-at-start` is a release the launcher's start check passed while hashing only
 * the files its unauthenticated identity record could not vouch for, when no full check can run or none is known;
 * `checked-in-studio` is a release Check now checked inside the Host because no launcher could run it; none of the three
 * is `verified`, which needs every runtime file hashed through the launcher. `waiting` is the person's own changes with
 * some waiting for their review.
 */
export type TrustState = 'verified' | 'checking' | 'checked-at-start' | 'checked-in-studio' | 'waiting' | 'attention' | 'failed' | 'unchecked' | 'unknown'

/**
 * How loudly a state shows: `red` for a failed check; `amber` for an unknown release state, an unchecked check, a
 * plugin changed after its install or a critical advisory; `neutral` for anything else not verified, the person's own
 * changes included; `ok` for verified.
 */
export type TrustTone = 'ok' | 'neutral' | 'amber' | 'red'

/** The four rows the studio's panel shows, in order. */
export const TRUST_ROW_IDS = ['release', 'releaseLog', 'plugins', 'changes'] as const

/** One row of {@link TRUST_ROW_IDS}. */
export type TrustRowId = (typeof TRUST_ROW_IDS)[number]

/** One row's state and tone, and how many of the person's own changes it counts. */
export interface TrustRow {
  readonly id: TrustRowId
  readonly state: TrustState
  readonly tone: TrustTone
  /** The person's own changes this row counts, shown as a neutral number; 0 for every row but `changes`. */
  readonly ownChanges: number
}

/**
 * A row.
 * @param id - the row.
 * @param state - its state.
 * @param tone - its tone.
 * @param ownChanges - the person's own changes it counts.
 * @returns the row.
 */
function row(id: TrustRowId, state: TrustState, tone: TrustTone, ownChanges = 0): TrustRow {
  return { id, state, tone, ownChanges }
}

/**
 * The `release` row: failed and red when the signature or the files failed; unknown and amber when either was not
 * checked, because an unverified release is never neutral; and when both passed, verified only when every runtime file
 * was hashed: for a start bill whose start check hashed fewer, `checking` while the background full check waits or runs
 * and `checked-at-start` otherwise, and `checked-in-studio` for a Check now that ran inside the Host, each neutral.
 * @param bill - the bill.
 * @param full - the background full check, when the Host reports one.
 * @returns the row.
 */
function releaseRow(bill: TrustBill, full: TrustFullCheck | undefined): TrustRow {
  const results = [bill.release.signature, bill.release.files]
  if (results.includes('fail')) return row('release', 'failed', 'red')
  if (!results.every(result => result === 'pass')) return row('release', 'unknown', 'amber')
  if (bill.checkedBy?.via === 'host') return row('release', 'checked-in-studio', 'neutral')
  if (bill.stage === 'start' && bill.release.startCheck?.full !== true) {
    return row('release', full?.state === 'waiting' || full?.state === 'running' ? 'checking' : 'checked-at-start', 'neutral')
  }
  return row('release', 'verified', 'ok')
}

/**
 * The `releaseLog` row, which keeps contract C18's state: failed is red, unchecked and unknown are amber.
 * @param log - the bill's release-log section.
 * @returns the row.
 */
function releaseLogRow(log: TrustReleaseLog): TrustRow {
  switch (log.state) {
    case 'verified': return row('releaseLog', 'verified', 'ok')
    case 'failed': return row('releaseLog', 'failed', 'red')
    case 'unchecked': return row('releaseLog', 'unchecked', 'amber')
    case 'unknown': return row('releaseLog', 'unknown', 'amber')
  }
}

/**
 * The `plugins` row: failed and red when an npm, git or tarball plugin changed after its install; attention and
 * amber for a critical advisory; unknown and neutral while the install check is unknown or a plugin has no install
 * record, such as one the person links from a folder; verified otherwise.
 * @param plugins - the bill's plugins section.
 * @returns the row.
 */
function pluginsRow(plugins: TrustPlugins): TrustRow {
  if (plugins.entries.some(entry => entry.match === 'mismatch')) return row('plugins', 'failed', 'red')
  if (plugins.entries.some(entry => entry.criticalAdvisories.length > 0)) return row('plugins', 'attention', 'amber')
  if (plugins.status === 'unknown' || plugins.entries.some(entry => entry.match !== 'match')) return row('plugins', 'unknown', 'neutral')
  return row('plugins', 'verified', 'ok')
}

/**
 * The `changes` row: the person's own changes, a neutral count of the harness files and plugin versions they
 * approved, the changes waiting for their review and the rows their patch layers add. It is unknown and neutral while
 * Changes or a patch layer cannot be read, `waiting` and neutral while any change waits for their review, and verified
 * otherwise, whatever the count.
 * @param changes - the bill's changes section.
 * @param patches - the bill's patches section.
 * @returns the row.
 */
function changesRow(changes: TrustChanges, patches: TrustPatches): TrustRow {
  const own = changes.harnessEdits.length + changes.approvedPlugins.length + changes.notReviewed + patches.rows.length
  if (changes.status === 'unknown' || patches.status === 'unknown') return row('changes', 'unknown', 'neutral', own)
  if (changes.notReviewed > 0) return row('changes', 'waiting', 'neutral', own)
  return row('changes', 'verified', 'ok', own)
}

/**
 * The panel's four rows.
 * @param bill - the bill.
 * @param checks - how fresh each row is, when the Host reports it; its background full check decides between
 *   `checking` and `checked-at-start`.
 * @returns the rows in {@link TRUST_ROW_IDS} order.
 */
export function trustRows(bill: TrustBill, checks?: TrustChecks | null): readonly TrustRow[] {
  return [releaseRow(bill, checks?.release.full), releaseLogRow(bill.releaseLog), pluginsRow(bill.plugins), changesRow(bill.changes, bill.patches)]
}

/** The order in which a row's state decides the badge: the first state any row has is the badge's. */
const STATE_PRECEDENCE: readonly TrustState[] = ['failed', 'attention', 'unchecked', 'unknown', 'checked-in-studio', 'checked-at-start', 'checking', 'waiting', 'verified']

/** The order in which a row's tone decides the badge's colour. */
const TONE_PRECEDENCE: readonly TrustTone[] = ['red', 'amber', 'neutral', 'ok']

/** The badge: its state, its tone and the neutral count of the person's own changes. */
export interface TrustBadge {
  readonly state: TrustState
  readonly tone: TrustTone
  /** The person's own changes, shown beside the state as a neutral count such as "12 of your changes". */
  readonly ownChanges: number
}

/**
 * The badge over the rows: the state is `failed` when any row failed, then `attention`, `unchecked`, `unknown`,
 * `checked-in-studio`, `checked-at-start`, `checking` and `waiting` in that order, and `verified` only when every row is; the tone
 * is the loudest row's. The count of the person's own changes never changes the state or the tone.
 * @param rows - the rows, or `null` when no bill could be read, which is `unknown` and amber.
 * @returns the badge.
 */
export function trustBadge(rows: readonly TrustRow[] | null): TrustBadge {
  if (rows === null || rows.length === 0) return { state: 'unknown', tone: 'amber', ownChanges: 0 }
  const state = STATE_PRECEDENCE.find(candidate => rows.some(entry => entry.state === candidate)) ?? 'unknown'
  const tone = TONE_PRECEDENCE.find(candidate => rows.some(entry => entry.tone === candidate)) ?? 'amber'
  return { state, tone, ownChanges: rows.reduce((sum, entry) => sum + entry.ownChanges, 0) }
}
