/**
 * The records and values of Changes: what a person's harness runs is the signed release plus the changes they
 * approved at their computer. Every type here is a value read from or written to a file under the Delorun home or the
 * profile, so readers validate what they read ([records](./records.ts)).
 *
 * @module @delorun/changes/types
 */
import type { Branded } from '@deepseek-ai/dsh-brand'

/** The SHA-256 of one approved or computed plugin content version: of its canonical {@link VersionManifest} entries. */
export type ContentVersion = Branded<'ContentVersion'>

/** The SHA-256 of one file's bytes, as the store's object name. */
export type ObjectDigest = Branded<'ObjectDigest'>

/** The id of one change: `c` and ten lowercase hexadecimal digits, derived from the change's kind, subject and contents. */
export type ChangeId = Branded<'ChangeId'>

/** What a change changes. */
export type ChangeKind =
  /** A plugin linked from a folder whose folder differs from its approved content. */
  | 'plugin-edit'
  /** A plugin added to the profile. */
  | 'plugin-install'
  /** A plugin moved to another version. */
  | 'plugin-update'
  /** A plugin taken out of the profile. */
  | 'plugin-remove'
  /** One plugin turned off (the small safe mode). */
  | 'plugin-off'
  /** One plugin turned on again. */
  | 'plugin-on'
  /** A file of the harness itself differs from the signed release's. */
  | 'harness-edit'
  /** A setting that weakens a consent, a guard or the protection setting. */
  | 'guard-weakening'
  /**
   * An action of the agent's `plugin_manager` that ran with protection off and is neither an install nor a removal:
   * turning a bundle or plugin on or off, a setting, a version exemption, an undo or a restore.
   */
  | 'plugin-setting-change'

/** Every {@link ChangeKind}, in the order a list shows them. */
export const CHANGE_KINDS: readonly ChangeKind[] = ['plugin-edit', 'plugin-install', 'plugin-update', 'plugin-remove', 'plugin-off', 'plugin-on', 'harness-edit', 'guard-weakening', 'plugin-setting-change']

/**
 * The kinds `log.json` may hold: every kind but `plugin-setting-change`, which only the agent-action log
 * ({@link AgentLog}) holds, so an older release that reads `log.json` never meets it.
 */
export const LOG_CHANGE_KINDS: readonly ChangeKind[] = CHANGE_KINDS.filter(kind => kind !== 'plugin-setting-change')

/** Where a change stands. */
export type ChangeState =
  /** Not applied; what runs is unchanged by it. */
  | 'pending'
  /** Applied by the person; one profile history version holds it. */
  | 'applied'
  /** Declined by the person; its content never loads. */
  | 'discarded'
  /** Applied, then left out of a start that failed with it; the profile's files still hold it. */
  | 'left-out-at-start'
  /** Applied, then undone by a later history version. */
  | 'undone'

/** Every {@link ChangeState}. */
export const CHANGE_STATES: readonly ChangeState[] = ['pending', 'applied', 'discarded', 'left-out-at-start', 'undone']

/** A paired device, as a studio proof and the change log name it. */
export interface StudioDevice {
  /** The device's id. */
  readonly id: string
  /** The name the person gave it. */
  readonly label: string
}

/** Where a decision about a change was made. Only a person at their computer or on an unlocked paired device decides. */
export type DecidedFrom =
  /** A `delorun changes` command at a terminal. */
  | 'terminal'
  /** The studio on its loopback address with the studio's credential. */
  | 'studio'
  /** The first start after the upgrade that introduced Changes approved the linked plugins it found as they were. */
  | 'upgrade'
  /** A start that failed left the change out. */
  | 'start'
  /** An update the person confirmed carried an approved harness file to the runtime it installed. */
  | 'update'
  /**
   * Protection was off, so Delorun loaded the content without anyone reviewing it: a start loaded a plugin folder's content
   * or applied an edit of the harness's writable copy, or a running Host reloaded a plugin from its folder.
   */
  | 'unreviewed'

/** Every {@link DecidedFrom}. */
export const DECIDED_FROM: readonly DecidedFrom[] = ['terminal', 'studio', 'upgrade', 'start', 'update', 'unreviewed']

/** The protection setting: whether a change loads only after the person reviewed it. */
export type ProtectionLevel =
  /**
   * A changed plugin loads its approved content until the person applies the change, a harness edit runs only once
   * applied, the agent's plugin installs and removals wait for the person, and the agent's first write to an approved
   * plugin's folder in a chat asks.
   */
  | 'on'
  /**
   * The default. Changes load without review and are still recorded: each start approves what a linked plugin's folder
   * holds and the edits in the harness's writable copy, a running Host reloads a linked plugin when its folder changes,
   * and the agent's plugin operations run as upstream runs them. Each is a logged change decided `unreviewed`, so it
   * is listed and undone like any other.
   */
  | 'off'

/** Every {@link ProtectionLevel}, strongest first. */
export const PROTECTION_LEVELS: readonly ProtectionLevel[] = ['on', 'off']

/** The level a home without a protection record has. */
export const DEFAULT_PROTECTION: ProtectionLevel = 'off'

/** One entry of a content version: a regular file or a symbolic link, by its path relative to the plugin folder. */
export type VersionEntry =
  | {
    readonly type: 'file'
    /** Relative path with `/` separators, no `.` or `..` segment. */
    readonly path: string
    /** The object holding the bytes. */
    readonly digest: ObjectDigest
    /** Size in bytes. */
    readonly size: number
    /** Whether the owner execute bit was set. */
    readonly executable: boolean
  }
  | {
    readonly type: 'link'
    /** Relative path with `/` separators. */
    readonly path: string
    /**
     * Inside the content: the target relative to the link's directory, as written or, for a second link to a directory
     * the version already includes, computed to that first path. Outside: the absolute real path.
     */
    readonly target: string
    /**
     * Whether the target is an installed package under some `node_modules` directory outside the plugin folder: what it
     * names is not part of the approved content. Other outside targets are included in the content instead of linked.
     */
    readonly outside: boolean
    /**
     * Present on an outside link to a package the running release carries: `target` is then its path below the active
     * runtime's `app/node_modules`, `/`-separated, and the link is written to that package in whichever release
     * `runtimes/current` names. An update or a rollback changes neither the version nor what was approved.
     */
    readonly runtime?: true
  }

/** The file under `store/versions/` that lists one content version. */
export interface VersionManifest {
  readonly schema: typeof VERSION_MANIFEST_SCHEMA
  /** The entries, sorted by path in code-unit order. */
  readonly entries: readonly VersionEntry[]
}

/** Schema tag of {@link VersionManifest}. */
export const VERSION_MANIFEST_SCHEMA = 'delorun.changes-version/1'

/** One plugin under Changes, as the profile records it. */
export interface ApprovedPlugin {
  /** The folder the person links the plugin from, absolute. */
  readonly source: string
  /** The content the profile loads outside a work session. */
  readonly version: ContentVersion
  /** When it was approved, ISO 8601. */
  readonly approvedAt: string
  /** Set when the first start after the upgrade approved it as it was. */
  readonly approvedAtUpgrade?: true
}

/**
 * The profile's record of approved plugins, kept in the profile's `package.json` under `delorun.changes` so every profile
 * history version holds it and upstream's undo and restore bring back the approved content with the rest.
 */
export interface ApprovedRecord {
  readonly schema: typeof APPROVED_RECORD_SCHEMA
  /** By package name. */
  readonly plugins: Readonly<Record<string, ApprovedPlugin>>
}

/** Schema tag of {@link ApprovedRecord}. */
export const APPROVED_RECORD_SCHEMA = 'delorun.changes-approved/1'

/** One file of the harness under Changes, as its runtime's {@link HarnessRecord} holds it. */
export interface ApprovedHarnessFile {
  /** The approved content: a content version whose one file entry is at the file's path, or the empty version when the approved change removes the file. */
  readonly version: ContentVersion
  /** The signed release's content of the file, as a content version with one file entry; absent when the signed file list has no such file. */
  readonly signed?: ContentVersion
  /** The change that approved {@link version}. */
  readonly change: ChangeId
  /** When it was approved, ISO 8601. */
  readonly approvedAt: string
}

/**
 * The file `changes/harness/<runtime>/approved.json`: the files of one installed runtime whose approved content differs
 * from the signed release's. A runtime without the file runs its signed files. One record per runtime version, so an
 * update writes the target's record and a rollback finds the previous runtime's record unchanged.
 */
export interface HarnessRecord {
  readonly schema: typeof HARNESS_RECORD_SCHEMA
  /** The runtime version, as contract C1's store names its directory under `runtimes/`. */
  readonly runtime: string
  /** By path relative to the runtime's root, `/`-separated, under `app/`. */
  readonly files: Readonly<Record<string, ApprovedHarnessFile>>
}

/** Schema tag of {@link HarnessRecord}. */
export const HARNESS_RECORD_SCHEMA = 'delorun.changes-harness/1'

/** What a change is about. */
export interface ChangeSubject {
  /** The plugin's package name, for a plugin kind. */
  readonly plugin?: string
  /** The plugin's folder, for a plugin linked from one. */
  readonly source?: string
  /** The harness file's path relative to the runtime, for `harness-edit`. */
  readonly file?: string
  /** The runtime version whose file it is, for `harness-edit`. */
  readonly runtime?: string
  /** The setting's name, for `guard-weakening`. */
  readonly setting?: string
  /** The install spec, for `plugin-install` and `plugin-update` of a plugin not linked from a folder. */
  readonly spec?: string
}

/** The failure a start reported when it left a change out, or a reload reported when applying failed to load. */
export interface LeftOut {
  /** When, ISO 8601. */
  readonly at: string
  /** What failed: the error's message, without a stack, at most `FAILURE_LIMIT_BYTES` of UTF-8 for a start. */
  readonly failure: string
}

/** One change the log records: every decided change, and the pending changes that are not computed from a folder. */
export interface ChangeEntry {
  readonly id: ChangeId
  readonly kind: ChangeKind
  readonly state: ChangeState
  readonly subject: ChangeSubject
  /** The content before the change, when it had one. */
  readonly from?: ContentVersion
  /** The content after the change, when it has one. */
  readonly to?: ContentVersion
  /** One line in the person's words. */
  readonly summary: string
  /** When the change was first recorded, ISO 8601. */
  readonly createdAt: string
  /** When it was applied, discarded, left out or undone, ISO 8601. */
  readonly decidedAt?: string
  /** Where the last decision was made. */
  readonly decidedFrom?: DecidedFrom
  /** The paired device whose studio made the last decision; absent for a decision at the computer, at a terminal or by Delorun. */
  readonly decidedOn?: StudioDevice
  /** The profile history version that applied it. */
  readonly historyVersion?: string
  /**
   * For an agent's `plugin_manager` action that ran with protection off ([agent actions](./agent-actions.ts)), held in
   * {@link AgentLog} only: the profile history version that holds the profile as it was just before the action, which
   * undoing the action brings back.
   */
  readonly historyBefore?: string
  /** Set when a start left the change out. */
  readonly leftOut?: LeftOut
  /** When a change approved at upgrade was first shown to the person, ISO 8601. */
  readonly shownAt?: string
  /** Set when applying the change failed to load and Delorun went back to the content that ran before. */
  readonly lastFailure?: LeftOut
}

/** The file `changes/<profile>/log.json`. */
export interface ChangeLog {
  readonly schema: typeof CHANGE_LOG_SCHEMA
  /** When the first start under Changes brought the profile's linked plugins under it, ISO 8601. */
  readonly migratedAt?: string
  /** Oldest first. */
  readonly entries: readonly ChangeEntry[]
}

/** Schema tag of {@link ChangeLog}. */
export const CHANGE_LOG_SCHEMA = 'delorun.changes-log/1'

/**
 * The file `changes/profiles/<profile>/agent-log.json`: the entries of the agent's `plugin_manager` actions that ran with
 * protection off ([agent actions](./agent-actions.ts)). It is a file of its own, never part of {@link ChangeLog}, because a
 * release that predates it refuses a `log.json` with an entry kind or field it does not know and cannot start the
 * profile; such a release never reads this file. Starting a profile reads `log.json` only; Changes' own list and undo
 * read both.
 */
export interface AgentLog {
  readonly schema: typeof AGENT_LOG_SCHEMA
  /** Oldest first. */
  readonly entries: readonly ChangeEntry[]
}

/** Schema tag of {@link AgentLog}. */
export const AGENT_LOG_SCHEMA = 'delorun.changes-agent-log/1'

/** The file `changes/protection.json`. A home without it is at {@link DEFAULT_PROTECTION}. */
export interface ProtectionRecord {
  readonly schema: typeof PROTECTION_RECORD_SCHEMA
  readonly level: ProtectionLevel
  /** When it was set, ISO 8601. */
  readonly setAt: string
}

/** Schema tag of {@link ProtectionRecord}. */
export const PROTECTION_RECORD_SCHEMA = 'delorun.changes-protection/1'

/**
 * The file `changes/migration.json`: the profiles the home held when a start first brought a profile under Changes.
 * Only these profiles approve their linked plugins as they are at their own first start under Changes; a profile
 * created after it is a new profile whose linked plugins wait for review.
 */
export interface MigrationRecord {
  readonly schema: typeof MIGRATION_RECORD_SCHEMA
  /** When it was written, ISO 8601. */
  readonly at: string
  /** The profile names, sorted. */
  readonly profiles: readonly string[]
}

/** Schema tag of {@link MigrationRecord}. */
export const MIGRATION_RECORD_SCHEMA = 'delorun.changes-migration/1'

/** The file `changes/<profile>/work-session.json`: one plugin loaded from its folder with live reload. */
export interface WorkSessionRecord {
  readonly schema: typeof WORK_SESSION_SCHEMA
  /** The plugin's package name. */
  readonly plugin: string
  /** Its folder, absolute. */
  readonly source: string
  /** The approved content when the session started. */
  readonly from: ContentVersion
  /** When it started, ISO 8601. */
  readonly startedAt: string
  /** Where it was started. */
  readonly startedFrom: 'terminal' | 'studio'
  /** When it ends without the person, ISO 8601: at most `WORK_SESSION_MAX_MINUTES` after {@link WorkSessionRecord.startedAt}. */
  readonly endsAt: string
  /** The last content that loaded, which a failed reload goes back to. */
  readonly lastLoaded?: ContentVersion
  /** The folder content whose reload failed after {@link WorkSessionRecord.lastLoaded}; ending the session never approves it. */
  readonly lastFailed?: ContentVersion
}

/** Schema tag of {@link WorkSessionRecord}. */
export const WORK_SESSION_SCHEMA = 'delorun.changes-work-session/1'

/**
 * What the profile's active directory for one plugin holds, in `changes/<profile>/active.json`: `approved` outside a
 * work session, in either protection setting; `work-session` during one; `left-out` while a change a failed start left
 * out stays out ([left out](./left-out.ts)), holding the content from before that change, or nothing when the change
 * installed the plugin or turned it on.
 */
export type ActiveContent =
  | { readonly version: ContentVersion, readonly kind: 'approved' | 'work-session' }
  | { readonly version?: ContentVersion, readonly kind: 'left-out' }

/** Every kind of {@link ActiveContent}. */
export const ACTIVE_KINDS: readonly ActiveContent['kind'][] = ['approved', 'work-session', 'left-out']

/** The file `changes/<profile>/active.json`, by package name. */
export interface ActiveRecord {
  readonly schema: typeof ACTIVE_RECORD_SCHEMA
  readonly plugins: Readonly<Record<string, ActiveContent>>
}

/** Schema tag of {@link ActiveRecord}. */
export const ACTIVE_RECORD_SCHEMA = 'delorun.changes-active/1'

/** How one file differs between two content versions. */
export interface FileChange {
  /** Relative path with `/` separators. */
  readonly path: string
  readonly status: 'added' | 'modified' | 'removed'
  /** Whether either side is not text, so the diff names it without its lines. */
  readonly binary: boolean
  /** Whether the path is below a `node_modules` directory: a dependency's file. */
  readonly dependency: boolean
  /** Size before, in bytes, when it existed. */
  readonly sizeBefore?: number
  /** Size after, in bytes, when it exists. */
  readonly sizeAfter?: number
}

/** A unified diff bounded in size. */
export interface BoundedDiff {
  /** The unified diff text of the text files, in path order, up to the bound. */
  readonly text: string
  /** Whether the bound cut the text short. */
  readonly truncated: boolean
  /** Text files whose hunks the bound left out. */
  readonly omitted: readonly string[]
}

/** What a risk finding says a change can do. */
export type RiskKind =
  /** Registers or replaces a consent, a guard or the sandbox policy. */
  | 'consent-guard-sandbox'
  /** Adds a listener that answers approval prompts, which can give grants the person keeps to the computer. */
  | 'answers-approvals'
  /** Installs, removes, toggles, updates or loads plugins itself, outside the install check. */
  | 'manages-plugins'
  /** Adds a tool the model can call. */
  | 'model-tool'
  /** Runs commands or child processes. */
  | 'commands'
  /** Opens network connections. */
  | 'network'
  /** Reads under the Delorun home. */
  | 'home-read'
  /** Adds or changes a dependency, or a build or install script. */
  | 'dependency-or-build'
  /**
   * Has new content the diff does not show: a binary file Node can load, a file too large for the diff or past where it
   * was cut short, or a dependency's file inside the folder.
   */
  | 'not-shown'

/** Every {@link RiskKind}, in the order the summary lists them. */
export const RISK_KINDS: readonly RiskKind[] = ['consent-guard-sandbox', 'answers-approvals', 'manages-plugins', 'model-tool', 'commands', 'network', 'home-read', 'dependency-or-build', 'not-shown']

/** One place in a change that a check matched. */
export interface RiskFinding {
  readonly kind: RiskKind
  /** The check that found it: a built-in check's id, or later a registered check's. */
  readonly check: string
  /** The file, relative to the plugin folder or the runtime. */
  readonly file: string
  /** The 1-based line in the new content, when the finding is on a line. */
  readonly line?: number
  /** The matched line, trimmed and bounded. */
  readonly excerpt: string
}

/**
 * What a change could do, as a help to the reader. It is computed by heuristics over the change's source and manifest
 * and is never a boundary: plugin code has the harness's full authority whatever the summary says.
 */
export interface RiskSummary {
  /** Every finding, by kind in {@link RISK_KINDS} order, then file and line. */
  readonly findings: readonly RiskFinding[]
  /** The kinds found, in {@link RISK_KINDS} order, each once. */
  readonly kinds: readonly RiskKind[]
  /** Whether applying asks a second confirmation: true when any kind was found. */
  readonly needsSecondConfirmation: boolean
}

/** One file of a change as a check reads it. */
export interface ReviewedFile {
  readonly path: string
  readonly status: FileChange['status']
  readonly dependency: boolean
  /** The new text, for an added or modified text file. */
  readonly after?: string
  /** The old text, for a modified or removed text file. */
  readonly before?: string
  /** Why the diff does not show the file's lines, when it does not. */
  readonly notShown?: NotShownReason
}

/**
 * Why a diff does not show a file's lines: `binary`, a file that is not text; `too-large`, a text file above the file
 * limit; `cut-short`, a text file past where the diff reached its size limit; `dependency`, a file below a
 * `node_modules` directory inside the folder.
 */
export type NotShownReason = 'binary' | 'too-large' | 'cut-short' | 'dependency'

/** What a check reads: the changed files, and the plugin's `package.json` on each side when it has one. */
export interface ReviewInput {
  readonly files: readonly ReviewedFile[]
  readonly manifestBefore?: unknown
  readonly manifestAfter?: unknown
}

/** One check of a change. Built-in checks are the nine of {@link RiskKind}; a later extension point can add more. */
export interface RiskCheck {
  /** A stable id, recorded on each finding. */
  readonly id: string
  /**
   * @param input - the change.
   * @returns what it found; empty when nothing.
   */
  readonly check: (input: ReviewInput) => readonly RiskFinding[]
}

/** A plugin's folder differing from its approved content, as `list` and `show` present it. */
export interface PluginChange {
  readonly id: ChangeId
  readonly kind: 'plugin-edit' | 'plugin-install'
  readonly plugin: string
  readonly source: string
  /** The approved content; undefined for a plugin with none yet. */
  readonly from?: ContentVersion
  /** The folder's content now. */
  readonly to: ContentVersion
  readonly files: readonly FileChange[]
  readonly diff: BoundedDiff
  readonly risk: RiskSummary
  /** Paths the scan could not include: sockets, devices and links that do not resolve. */
  readonly skipped: readonly string[]
}
