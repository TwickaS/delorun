/**
 * The studio's Changes routes as the browser reads them: their paths, and the JSON fields each answers with
 * ([C21](../../../docs/contracts/c21-changes.md#routes-and-the-recovery-screen)). The Host's routes build these
 * fields and the Changes section reads them; this module imports nothing, so both halves share it.
 * @module @delorun/plugin-changes/wire
 */

/** The path prefix of every Changes route. */
export const CHANGES_ROUTE_PREFIX = '/delorun/changes'

/** What failed, the recent changes and the actions the screen offers. */
export const STATE_PATH = `${CHANGES_ROUTE_PREFIX}/state`

/**
 * One change by `?id=`, the open work session's folder by `?work=<plugin>`, or every change waiting for review in a
 * plugin's folder by `?pending`: the reads that read folders and store their content.
 */
export const SHOW_PATH = `${CHANGES_ROUTE_PREFIX}/show`

/** The workspaces a plugin may be created in, and whether this request is at the computer. */
export const WORKSPACES_PATH = `${CHANGES_ROUTE_PREFIX}/workspaces`

/** The setup routes, each a `POST` at the computer: write the profile's setup as a file, read a file and plan its import, apply a planned import. */
export const SETUP_PATHS = {
  export: `${CHANGES_ROUTE_PREFIX}/setup-export`,
  inspect: `${CHANGES_ROUTE_PREFIX}/setup-inspect`,
  apply: `${CHANGES_ROUTE_PREFIX}/setup-apply`,
} as const

/** Why a setup leaves something out, as a code the screen words. */
export type SetupLeftOutCode = 'computer' | 'form' | 'endpoint' | 'expression' | 'secret' | 'not-mapping' | 'not-package-name' | 'not-installed' | 'not-approved' | 'no-package-json' | 'links' | 'key-variable'

/** One thing a setup leaves out: a row id or plugin name, and why. */
export interface SetupLeftOutView {
  readonly subject: string
  readonly code: SetupLeftOutCode
}

/** What the profile has now for a plugin an import moves. */
export type SetupWasView =
  | { readonly kind: 'version', readonly version: string }
  | { readonly kind: 'not-installed' | 'registry', readonly spec: string }
  | { readonly kind: 'local' | 'local-unapproved' | 'local-other' }

/** A key to add after an import: the default model's provider, or a variable a provider reads. */
export type SetupKeyView =
  | { readonly kind: 'model', readonly provider: string, readonly model?: string }
  | { readonly kind: 'variable', readonly name: string }

/** What `setup-export` answers to `{ list: true }`: the plugins the profile could put in a file. */
export interface SetupPluginsView {
  readonly plugins: readonly { readonly name: string, readonly source: 'registry' | 'local' }[]
}

/** What `setup-export` answers: the signed file, as base64, and what went in and was left out. */
export interface SetupExportView {
  /** The archive's bytes, base64. */
  readonly file: string
  /** A name for the download. */
  readonly name: string
  /** The plugins in the file. */
  readonly plugins: number
  /** How many of them are carried with their files. */
  readonly local: number
  /** The settings entries in the file. */
  readonly settings: number
  /** What the file does not carry, as codes. */
  readonly leftOut: readonly SetupLeftOutView[]
  /** The fingerprint of the key that signed the file. */
  readonly signedBy: string
  /** The plugins of one's own that went in without their code, for the person to copy. */
  readonly withoutCode: readonly string[]
}

/** One plugin an import adds or moves. */
export interface SetupInstallView {
  readonly name: string
  readonly version?: string
  readonly kind: 'add' | 'replace'
  /** Where it comes from: the registry, or files made on another computer whose code waits for review. */
  readonly source: 'registry' | 'local'
  /** What the profile has now, when it replaces one. */
  readonly was?: SetupWasView
}

/** What `setup-inspect` answers: who signed the file, and everything the import would change. */
export interface SetupInspectView {
  /** The token `setup-apply` takes; it applies once and expires. */
  readonly token: string
  readonly signer: { readonly state: 'verified' | 'unverified', readonly reason?: 'absent' | 'key-not-trusted', readonly fingerprint: string }
  readonly createdBy: string
  readonly exportedAt: string
  /** The sender's note. */
  readonly note?: string
  /** Whether the file includes settings besides the model; the Include settings switch is offered only then. */
  readonly includesSettings: boolean
  /** The parts of the setup this import replaces. */
  readonly replaces: readonly ('plugins-listed' | 'plugins-all' | 'model' | 'settings' | 'settings-off' | 'settings-none')[]
  /** Plugins the file names without their code. */
  readonly named: readonly string[]
  /** The profile the file was exported from. */
  readonly sourceProfile: string
  readonly install: readonly SetupInstallView[]
  readonly remove: readonly string[]
  readonly keep: readonly string[]
  readonly settingChanges: readonly { readonly kind: 'set' | 'changed' | 'default', readonly label: string }[]
  readonly endpoints: readonly { readonly field: string, readonly url: string }[]
  /** The endpoints other than a provider's default, which the person confirms separately before the import applies. */
  readonly endpointNotices: readonly { readonly provider: string, readonly host: string }[]
  readonly leftOut: readonly SetupLeftOutView[]
  readonly keys: readonly SetupKeyView[]
  readonly protection: 'on' | 'off'
  /** Whether the import changes anything. */
  readonly changes: boolean
}

/** What `setup-apply` answers. */
export interface SetupApplyView {
  /** The profile history version saved before the import, which restores the setup as it was. */
  readonly savedVersion: string
  readonly removed: readonly string[]
  readonly installed: readonly { readonly name: string, readonly reviewChange?: string }[]
  readonly settingsWritten: boolean
  readonly keys: readonly SetupKeyView[]
  readonly protection: 'on' | 'off'
}

/** The actions, each a `POST` whose body names the change or the plugin. */
export const ACTION_PATHS = {
  apply: `${CHANGES_ROUTE_PREFIX}/apply`,
  discard: `${CHANGES_ROUTE_PREFIX}/discard`,
  undo: `${CHANGES_ROUTE_PREFIX}/undo`,
  off: `${CHANGES_ROUTE_PREFIX}/off`,
  on: `${CHANGES_ROUTE_PREFIX}/on`,
  work: `${CHANGES_ROUTE_PREFIX}/work`,
  done: `${CHANGES_ROUTE_PREFIX}/done`,
  'safe-mode': `${CHANGES_ROUTE_PREFIX}/safe-mode`,
  'exit-safe-mode': `${CHANGES_ROUTE_PREFIX}/exit-safe-mode`,
  create: `${CHANGES_ROUTE_PREFIX}/create`,
  request: `${CHANGES_ROUTE_PREFIX}/request`,
  reveal: `${CHANGES_ROUTE_PREFIX}/reveal`,
} as const

/** One action route. */
export type ChangesAction = keyof typeof ACTION_PATHS

/** The refusal code of an action that is not at the computer. */
export const LOOPBACK_REQUIRED = 'LOOPBACK_REQUIRED'

/** The refusal code of a flagged change and of an agent's plugin request, until the person confirms it a second time. */
export const CONFIRM_RISK = 'CONFIRM_RISK'

/** The refusal code of `done` when the folder holds another version than the one the person was shown. */
export const CHANGED_SINCE_REVIEW = 'CHANGED_SINCE_REVIEW'

/**
 * The routes that decide a change to Delorun itself and make the person's copy of it, each a `POST`: `apply` takes
 * `{ id, to, confirmedRisk? }`, `undo` and `discard` take `{ id }`, `copy` takes `{}`.
 */
export const HARNESS_PATHS = {
  apply: `${CHANGES_ROUTE_PREFIX}/harness-apply`,
  undo: `${CHANGES_ROUTE_PREFIX}/harness-undo`,
  discard: `${CHANGES_ROUTE_PREFIX}/harness-discard`,
  copy: `${CHANGES_ROUTE_PREFIX}/harness-copy`,
} as const

/** One harness route. */
export type HarnessAction = keyof typeof HARNESS_PATHS

/** The routes that turn protection on (a `POST` of `{}`) and off (a `POST` of `{ confirmed? }`). */
export const PROTECTION_PATHS = {
  on: `${CHANGES_ROUTE_PREFIX}/protection-on`,
  off: `${CHANGES_ROUTE_PREFIX}/protection-off`,
} as const

/** The route the person at the computer dismisses a notice with: a `POST` of `{ id }`. */
export const NOTICE_SEEN_PATH = `${CHANGES_ROUTE_PREFIX}/notice-seen`

/** The refusal code of a plugin's action route asked for a change to Delorun itself, which the harness routes decide. */
export const HARNESS_ROUTE = 'HARNESS_ROUTE'

/** The refusal code of a device's request whose unlock is missing or is only the approval grace. */
export const ELEVATION_REQUIRED = 'ELEVATION_REQUIRED'

/** The refusal code of turning protection off until the person confirms it a second time. */
export const CONFIRM_PROTECTION = 'CONFIRM_PROTECTION'

/** The refusal code of a harness route on a Host that does not run an installed release under `delorun start`. */
export const HARNESS_UNAVAILABLE = 'HARNESS_UNAVAILABLE'

/**
 * The routes that restart Delorun on the release it runs, so the changes to Delorun itself that wait for a restart
 * run, each a `POST`: `restart` takes `{ stopChats? }` and answers {@link RestartBegunView}; `cancel` takes `{}` and
 * ends a restart that still waits for running chats, answering {@link RestartCancelView}.
 */
export const RESTART_PATHS = {
  restart: `${CHANGES_ROUTE_PREFIX}/restart`,
  cancel: `${CHANGES_ROUTE_PREFIX}/restart-cancel`,
} as const

/** The refusal code of a restart while another runs. */
export const RESTART_IN_PROGRESS = 'RESTART_IN_PROGRESS'

/** The refusal code of a restart while an update or a rollback of Delorun runs. */
export const UPDATE_IN_PROGRESS = 'UPDATE_IN_PROGRESS'

/** The refusal code of a restart on a Host that no home process of an installed release runs. */
export const RESTART_UNAVAILABLE = 'RESTART_UNAVAILABLE'

/**
 * Whether Delorun needs a restart for changes to Delorun itself to run, and the restart under way or the last one's
 * failure. Absent when nothing waits for a restart and none ran since the last decision.
 */
export type RestartStateView =
  | {
    readonly kind: 'needed'
    /** How many files of decided changes run only after a restart. */
    readonly changes: number
    /** The chats a restart waits for now. */
    readonly runningChats: number
    /** Whether this Host can restart itself; false means the changes run at the next start. */
    readonly available: boolean
  }
  | {
    readonly kind: 'restarting'
    /** RFC 3339 UTC time it began. */
    readonly since: string
    /** `waiting`: this Host answers and refuses new turns; `starting`: no Host answers until the new one or this one runs. */
    readonly phase: 'waiting' | 'starting'
    readonly runningChats: number
  }
  | {
    readonly kind: 'failed'
    /** RFC 3339 UTC time it ended. */
    readonly at: string
    /** Why, in the person's words. */
    readonly failure: string
    /** `health`: the new start failed and this one kept running; `chats`: chats still ran when the wait ended; `host`: Delorun could not stop to restart. */
    readonly reason: 'health' | 'chats' | 'host'
    /** The change to Delorun itself it left out, when it left one out. */
    readonly leftOut?: { readonly id: string, readonly file: string }
  }

/** `restart`'s answer: the restart began and waits for these chats first. */
export interface RestartBegunView {
  readonly kind: 'restarting'
  readonly runningChats: number
}

/** `restart-cancel`'s answer: whether a restart was waiting for chats and ended. */
export interface RestartCancelView {
  readonly cancelled: boolean
}

/** Where a request came from. A device in its approval grace counts as locked for every Changes write. */
export type ActorView = 'computer' | 'device-unlocked' | 'device-grace' | 'device-locked'

/** The Phone powers level in force and whether the person chose it. */
export interface PhonePowersView {
  readonly level: 'careful' | 'full'
  /** False while the home has no recorded choice, and `level` is the one it applies. */
  readonly chosen: boolean
}

/** One control of the Changes section. */
export type ChangesControl =
  | 'harness-apply' | 'harness-undo' | 'harness-discard'
  | 'protection-off' | 'protection-on'
  | 'make-copy' | 'restart'
  | 'plugin-apply' | 'plugin-undo' | 'plugin-discard' | 'plugin-other'
  | 'notice-seen'
  | 'update-check' | 'update-begin' | 'update-cancel' | 'update-rollback' | 'update-dismiss' | 'stop'

/** Whether a request may use a control now, and if not, what it needs: the computer, or an unlock entered on the device. */
export type MayView =
  | { readonly ok: true }
  | { readonly ok: false, readonly needs: 'computer' | 'unlock' }

/** Who may use what, for the request that read `state`. */
export interface AccessView {
  readonly actor: ActorView
  readonly phonePowers: PhonePowersView
  readonly may: Readonly<Record<ChangesControl, MayView>>
}

/** What a change changes. */
export type ChangeKindView = 'plugin-edit' | 'plugin-install' | 'plugin-update' | 'plugin-remove' | 'plugin-off' | 'plugin-on' | 'harness-edit' | 'guard-weakening'

/** Where a change stands. */
export type ChangeStateView = 'pending' | 'applied' | 'discarded' | 'left-out-at-start' | 'undone'

/** Where the last decision about a change was made. */
export type DecidedFromView = 'terminal' | 'studio' | 'upgrade' | 'start' | 'update' | 'unreviewed'

/**
 * The protection setting: `on`, changes wait for the person's review; `off`, the default, changes load without review
 * and linked plugins reload live when their folder changes, each still logged as a change decided `unreviewed`.
 */
export type ProtectionView = 'on' | 'off'

/** What a risk finding says a change can do. */
export type RiskKindView = 'consent-guard-sandbox' | 'answers-approvals' | 'manages-plugins' | 'model-tool' | 'commands' | 'network' | 'home-read' | 'dependency-or-build' | 'not-shown'

/** A failure with when it happened: a start that left a change out, or a reload that went back. */
export interface FailureView {
  /** When, ISO 8601. */
  readonly at: string
  /** The error's message. */
  readonly failure: string
}

/** One logged change. */
export interface EntryView {
  readonly id: string
  readonly kind: ChangeKindView
  readonly state: ChangeStateView
  /** One line in the person's words. */
  readonly summary: string
  readonly plugin?: string
  /** The package spec an agent's plugin request names. */
  readonly spec?: string
  /** ISO 8601. */
  readonly createdAt: string
  /** ISO 8601. */
  readonly decidedAt?: string
  readonly decidedFrom?: DecidedFromView
  /** The name of the paired device whose studio made the decision; absent for a decision at the computer or a terminal. */
  readonly decidedOn?: string
  /** Why applying it failed to load. */
  readonly lastFailure?: FailureView
  /** What the start that left it out failed with. */
  readonly leftOut?: FailureView
  /** Whether `undo` takes it back. */
  readonly undoable: boolean
}

/** One decided change to a file of Delorun itself, as `state` lists it from the log the home keeps for every runtime. */
export interface HarnessEntryView {
  readonly id: string
  readonly state: Exclude<ChangeStateView, 'pending'>
  /** The file, relative to the runtime's directory. */
  readonly file: string
  /** The Delorun version whose file it changes. */
  readonly runtime: string
  /** One line in the person's words. */
  readonly summary: string
  /** ISO 8601. */
  readonly createdAt: string
  /** ISO 8601. */
  readonly decidedAt?: string
  /** What the start that left it out failed with. */
  readonly leftOut?: FailureView
  readonly decidedFrom?: DecidedFromView
  /** The name of the paired device whose studio made the decision; absent for a decision at the computer or a terminal. */
  readonly decidedOn?: string
  /** Whether `harness-undo` takes it back: an applied change, or one a failed start left out, of the running runtime. */
  readonly undoable: boolean
}

/** A change waiting for review in the person's copy of Delorun, as `show?pending` lists it. */
export interface HarnessPendingView {
  readonly id: string
  /** The file, relative to the runtime's directory, under `app/`. */
  readonly file: string
  /** The Delorun version whose file it changes. */
  readonly runtime: string
  readonly status: 'added' | 'modified' | 'removed'
  /** The full content version the copy holds for the file; `harness-apply` sends it back. */
  readonly to: string
}

/** Whether this Host can change Delorun's own files: only an installed release that `delorun start` runs can. */
export type HarnessAvailableView =
  | { readonly kind: 'available', readonly runtime: string, readonly copy: boolean }
  | { readonly kind: 'unavailable' }

/** A change of the protection setting made from a paired device, shown at the computer until the person dismisses it. */
export interface ProtectionNoticeView {
  readonly id: string
  readonly level: ProtectionView
  /** ISO 8601. */
  readonly at: string
  /** The name the person gave the device. */
  readonly device: string
}

/** A change computed from a folder that waits for review, as `show?pending` lists it. */
export interface PendingView {
  readonly id: string
  readonly kind: 'plugin-edit' | 'plugin-install'
  readonly plugin: string
  /** The plugin's folder. */
  readonly source: string
  /** How many files differ. */
  readonly files: number
  readonly riskKinds: readonly RiskKindView[]
  readonly lastFailure?: FailureView
}

/**
 * A plugin under Changes, as `state` names it from the records without reading its folder: whether an approved
 * plugin's folder holds edits is known once `show?pending` read it.
 */
export interface FolderView {
  readonly plugin: string
  /** The plugin's folder. */
  readonly source: string
  /** `plugin-install` while nothing of it is approved, so its folder waits for review; `plugin-edit` once approved. */
  readonly kind: 'plugin-edit' | 'plugin-install'
}

/** `GET show?pending`. */
export interface PendingListView {
  readonly kind: 'pending-list'
  readonly pending: readonly PendingView[]
  /** The changes waiting in the person's copy of Delorun; empty without a copy or on a Host that cannot read it. */
  readonly harness: readonly HarnessPendingView[]
  /** Why the copy could not be read, when it could not; `harness` is then empty. */
  readonly harnessProblem?: string
}

/** The open work session. */
export interface WorkSessionView {
  readonly plugin: string
  /** The folder whose edits load live. */
  readonly source: string
  /** ISO 8601. */
  readonly startedAt: string
  /** When it ends without the person, ISO 8601. */
  readonly endsAt: string
  /** The last reload that failed, while the content that last loaded runs instead. */
  readonly lastError?: { readonly at: string, readonly error: string }
}

/** One plugin under Changes at the last start. */
export interface StartPluginView {
  readonly plugin: string
  readonly loaded: boolean
  readonly error?: string
}

/** `GET state`. */
export interface ChangesStateView {
  /** Whether this request is the person at their computer. */
  readonly atComputer: boolean
  /** What this request may use, and what each other control needs. */
  readonly access: AccessView
  readonly profile: string
  readonly protection?: ProtectionView
  readonly safeMode?: { readonly since: string, readonly reason: string, readonly skipped: readonly string[] }
  readonly lastStart?: { readonly at: string, readonly failure?: string, readonly plugins: readonly StartPluginView[] }
  /** Changes a failed start left out. */
  readonly leftOut: readonly EntryView[]
  /** Every plugin under Changes; its folder's changes waiting for review are read by `show?pending`. */
  readonly folders: readonly FolderView[]
  /** The agent's plugin requests that wait for review. */
  readonly requests: readonly EntryView[]
  /** The newest decided changes, newest first. */
  readonly recent: readonly EntryView[]
  /** The newest decided changes to Delorun itself, newest first. */
  readonly harness: readonly HarnessEntryView[]
  readonly harnessAvailable: HarnessAvailableView
  /** How many changes loaded without review since protection was last turned off. */
  readonly unreviewedSinceOff: number
  /** Protection changes a paired device made, oldest first; only the computer's request carries them. */
  readonly notices: readonly ProtectionNoticeView[]
  readonly workSession?: WorkSessionView
  /** Whether a restart is needed, under way, or failed; absent otherwise and on a Host that cannot change Delorun's own files. */
  readonly restart?: RestartStateView
  /** One sentence per record that cannot be read. */
  readonly problems: readonly string[]
}

/** One place in a change that a check matched. */
export interface FindingView {
  readonly kind: RiskKindView
  readonly file: string
  readonly line?: number
  readonly excerpt: string
}

/** What a change could do, as a help to the reader. */
export interface RiskView {
  readonly kinds: readonly RiskKindView[]
  /** Each kind in English, as the terminal prints it. */
  readonly phrases: readonly string[]
  readonly needsSecondConfirmation: boolean
  readonly findings: readonly FindingView[]
}

/** One file of a change. */
export interface FileView {
  readonly path: string
  readonly status: 'added' | 'modified' | 'removed'
  /** Either side is not text, so the diff names it without its lines. */
  readonly binary: boolean
  /** Below a `node_modules` directory. */
  readonly dependency: boolean
}

/** What a review shows of a change: its files, the risk summary and the bounded diff. */
export interface ReviewView {
  readonly files: readonly FileView[]
  readonly risk: RiskView
  /** The bounded unified diff, and the text files whose hunks the bound left out. */
  readonly diff: { readonly text: string, readonly truncated: boolean, readonly omitted: readonly string[] }
}

/** A change computed from a folder, in full. */
export interface ChangeView extends ReviewView {
  readonly id: string
  readonly kind: 'plugin-edit' | 'plugin-install'
  readonly plugin: string
  readonly source: string
  /** Paths the scan could not include. */
  readonly skipped: readonly string[]
  readonly lastFailure?: FailureView
}

/** A logged change to a file of Delorun itself, read from the content versions the home keeps. */
export interface HarnessReviewView extends ReviewView {
  readonly kind: 'harness-edit'
}

/**
 * `GET show?id=`: a plugin's change waiting for review, a plugin's logged change, or a logged change to Delorun itself,
 * whose `review` is absent when the home no longer keeps its content.
 */
export type ShownView =
  | { readonly kind: 'pending', readonly change: ChangeView }
  | { readonly kind: 'logged', readonly entry: EntryView }
  | { readonly kind: 'harness', readonly entry: HarnessEntryView, readonly review?: HarnessReviewView }
  | { readonly kind: 'harness-pending', readonly change: HarnessPendingView, readonly review: HarnessReviewView }

/** `GET show?work=`: the open session's folder against the content it started from. */
export interface WorkReviewView {
  readonly kind: 'work'
  readonly plugin: string
  readonly source: string
  readonly startedAt: string
  readonly endsAt: string
  /** The folder's version, which `done` approves; absent when the folder is gone. */
  readonly version?: string
  /** Whether that version is the one whose reload failed in the session. */
  readonly failedToLoad: boolean
  /** The difference from the content the session started from; absent when they are the same. */
  readonly change?: ChangeView
}

/** How the running Host took an action. */
export type ReloadView =
  | { readonly kind: 'not-running' }
  | { readonly kind: 'reloaded' }
  | { readonly kind: 'went-back', readonly failure: string, readonly historyVersion?: string, readonly again?: { readonly ok: true } | { readonly ok: false, readonly error: string } }

/** `apply` of a change that is no agent's plugin request, `undo`, `off` and `on`. */
export interface ActionView {
  readonly entry: EntryView
  readonly reload: ReloadView
}

/** How the running Host took an applied agent's plugin request. */
export type InstallReloadView =
  | { readonly kind: 'not-running' }
  | { readonly kind: 'reloaded' }
  /** The running Host failed to load it; the profile keeps the change, which the next start loads. */
  | { readonly kind: 'failed', readonly failure: string }

/** `apply` of an agent's plugin request. */
export interface InstallView {
  readonly entry: EntryView
  readonly reload: InstallReloadView
  /** For a spec that names a folder: the change that holds the folder's content. */
  readonly folderChange?: string
}

/** `discard`. */
export interface DiscardView {
  readonly entry: EntryView
}

/**
 * When a decided change to Delorun itself takes effect: `live` at once (`page`: the studio's own files changed, so a
 * page reload shows them), `restart` after a restart or the next start, `not-running` at the next start because no
 * home process can restart this Host, or `left-out` when it could not take effect live and was left out, with why.
 */
export type HarnessEffectView =
  | { readonly kind: 'live', readonly page: boolean }
  | { readonly kind: 'restart' }
  | { readonly kind: 'not-running' }
  | { readonly kind: 'left-out', readonly failure: string }

/** `harness-apply` and `harness-undo`. */
export interface HarnessActionView {
  readonly kind: 'harness'
  readonly entry: HarnessEntryView
  readonly effect: HarnessEffectView
}

/** `harness-discard`. */
export interface HarnessDiscardView {
  readonly kind: 'harness'
  readonly entry: HarnessEntryView
}

/** `harness-copy`: the person's copy of Delorun, made or found. */
export interface HarnessCopyView {
  readonly kind: 'copy'
  /** Whether this request made it; false when it existed. */
  readonly created: boolean
  readonly runtime: string
  /** The copy's `app/` folder, with the Delorun home written as `<Delorun home>`. */
  readonly place: string
}

/** What turning protection off lets load without review: the second ask names it. */
export interface WillLoadView {
  /** The plugins whose folders hold changes waiting for review. */
  readonly plugins: readonly string[]
  /** How many files of the person's copy of Delorun wait for review. */
  readonly harnessFiles: number
}

/** `protection`. */
export interface ProtectionChangedView {
  readonly protection: ProtectionView
  /** How many changes loaded without review while protection was off; 0 after turning it off. */
  readonly unreviewedSinceOff: number
}

/** `safe-mode` and `exit-safe-mode`: what the record says now. */
export interface SafeModeView {
  /** The record's words for the person. */
  readonly lines: readonly string[]
  /** The bundles the next start leaves out; empty when safe mode ended. */
  readonly skipped: readonly string[]
}

/** `work`. */
export interface StartedView {
  readonly session: Omit<WorkSessionView, 'lastError'>
  readonly load: { readonly kind: 'loaded' } | { readonly kind: 'went-back', readonly failure: string }
}

/** `done`. */
export type DoneView =
  | { readonly kind: 'went-back', readonly plugin: string, readonly failure: string }
  | { readonly kind: 'ended', readonly plugin: string, readonly entry?: EntryView }

/**
 * A refusal: its code, its sentence, and for `CONFIRM_RISK` the kinds and each file the diff does not show, or the spec
 * of an agent's plugin request whose content is not shown.
 */
export interface RefusalView {
  readonly code: string
  readonly message: string
  readonly kinds?: readonly RiskKindView[]
  readonly notShown?: readonly string[]
}

/** The plugin kinds Create a plugin offers, which `@delorun/plugin-scaffold`'s `PLUGIN_KINDS` lists too; a spec holds the two equal. */
export const CREATE_KINDS = ['tool', 'preset', 'ui', 'bundle'] as const

/** `workspaces`: where Create a plugin may put a plugin, the default first. */
export interface WorkspacesView {
  /** Whether this request could create: the person at their computer. */
  readonly atComputer: boolean
  readonly workspaces: readonly { readonly id: string, readonly title: string, readonly path: string }[]
}

/** `create`: a plugin the studio's Create a plugin wrote into a workspace's `plugins` folder. */
export interface CreatedView {
  readonly kind: 'created'
  /** The package name. */
  readonly plugin: string
  /** The plugin kind. */
  readonly pluginKind: string
  /** The workspace's id. */
  readonly workspace: string
  /** The plugin's folder, an absolute path. */
  readonly folder: string
  /** The files written, relative to the folder. */
  readonly files: readonly string[]
}

/** `request`: the install from a created plugin's folder, recorded as a change that waits for the person's review. */
export interface RequestedView {
  readonly kind: 'requested'
  readonly entry: EntryView
}

/** `reveal`: the folder was shown in the computer's file manager. */
export interface RevealedView {
  readonly kind: 'revealed'
  readonly folder: string
}
