/**
 * The studio's Changes routes as the browser reads them: their paths, and the JSON fields each answers with
 * ([C21](../../../docs/contracts/c21-changes.md#routes-and-the-recovery-screen)). The Host's routes build these
 * fields and the Changes section reads them; this module imports nothing, so both halves share it.
 * @module @delo/plugin-changes/wire
 */

/** The path prefix of every Changes route. */
export const CHANGES_ROUTE_PREFIX = '/delo/changes'

/** What failed, the recent changes and the actions the screen offers. */
export const STATE_PATH = `${CHANGES_ROUTE_PREFIX}/state`

/**
 * One change by `?id=`, the open work session's folder by `?work=<plugin>`, or every change waiting for review in a
 * plugin's folder by `?pending`: the reads that read folders and store their content.
 */
export const SHOW_PATH = `${CHANGES_ROUTE_PREFIX}/show`

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
} as const

/** One action route. */
export type ChangesAction = keyof typeof ACTION_PATHS

/** The refusal code of an action that is not at the computer. */
export const LOOPBACK_REQUIRED = 'LOOPBACK_REQUIRED'

/** The refusal code of a flagged change and of an agent's plugin request, until the person confirms it a second time. */
export const CONFIRM_RISK = 'CONFIRM_RISK'

/** The refusal code of `done` when the folder holds another version than the one the person was shown. */
export const CHANGED_SINCE_REVIEW = 'CHANGED_SINCE_REVIEW'

/** The refusal code of `apply`, `discard` and `undo` for a change to Delo itself, which only a terminal decides. */
export const DECIDE_AT_TERMINAL = 'DECIDE_AT_TERMINAL'

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
export type RiskKindView = 'consent-guard-sandbox' | 'model-tool' | 'commands' | 'network' | 'home-read' | 'dependency-or-build' | 'not-shown'

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
  /** Why applying it failed to load. */
  readonly lastFailure?: FailureView
  /** What the start that left it out failed with. */
  readonly leftOut?: FailureView
  /** Whether `undo` takes it back. */
  readonly undoable: boolean
}

/**
 * One decided change to a file of Delo itself, as `state` lists it from the log the home keeps for every runtime. A
 * terminal decides it: no route applies, discards or undoes it.
 */
export interface HarnessEntryView {
  readonly id: string
  readonly state: Exclude<ChangeStateView, 'pending'>
  /** The file, relative to the runtime's directory. */
  readonly file: string
  /** The Delo version whose file it changes. */
  readonly runtime: string
  /** One line in the person's words. */
  readonly summary: string
  /** ISO 8601. */
  readonly createdAt: string
  /** ISO 8601. */
  readonly decidedAt?: string
  /** What the start that left it out failed with. */
  readonly leftOut?: FailureView
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
  /** Whether this request could act: the person at their computer. */
  readonly atComputer: boolean
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
  /** The newest decided changes to Delo itself, newest first. */
  readonly harness: readonly HarnessEntryView[]
  readonly workSession?: WorkSessionView
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

/** A logged change to a file of Delo itself, read from the content versions the home keeps. */
export interface HarnessReviewView extends ReviewView {
  readonly kind: 'harness-edit'
}

/**
 * `GET show?id=`: a plugin's change waiting for review, a plugin's logged change, or a logged change to Delo itself,
 * whose `review` is absent when the home no longer keeps its content.
 */
export type ShownView =
  | { readonly kind: 'pending', readonly change: ChangeView }
  | { readonly kind: 'logged', readonly entry: EntryView }
  | { readonly kind: 'harness', readonly entry: HarnessEntryView, readonly review?: HarnessReviewView }

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
