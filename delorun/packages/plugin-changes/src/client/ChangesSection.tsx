/**
 * The Changes section in Settings: the notes on who may act and the protection notices, the work session, the changes a
 * start left out, the changes and the agent's requests waiting for review, the recent changes, the changes to Delorun
 * itself, and the protection switch; with protection off, a note says that changes load without review and linked
 * plugins reload live on save. The state, which the page reads every 15 seconds, names the plugins under Changes and
 * whether the person has a copy of Delorun; the section reads the plugins' folders and the copy for the changes waiting
 * for review when it opens, after each action and when the person asks. Review opens a change with its diff and risk
 * summary; Apply, Discard, Undo, Apply again, Start working and Done act through the harness's Changes routes, and a
 * change the checks flagged asks a second confirmation that names what they found. An agent's plugin request is applied
 * after a confirmation and the second confirmation the route asks for every request, which names its spec.
 *
 * Each control reads the state's `access`: one that stays at the computer is disabled with a hover
 * text; one that needs an unlock stays enabled, and the route's refusal opens the studio's unlock dialog.
 */
import { useEffect, useState } from 'react'
import { Button, CommandText, Modal, relativeTime, StateDot, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import type { HostObservable, InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ChangesControl, ChangesStateView, EntryView, FolderView, HarnessCopyView, HarnessEntryView, HarnessPendingView, PendingListView, PendingView, RiskKindView, ShownView, WillLoadView, WorkReviewView } from '../wire.ts'
import { AccessNote } from './AccessNote.tsx'
import type { ActionOutcome, ChangesLoad, CopyOutcome, HarnessEffects } from './controller.ts'
import { ChangeDetail } from './ChangeDetail.tsx'
import css from './ChangesSection.module.css'
import { controlUse, Group, LoadLine, pluralKey, SHORT_VERSION, useLoaded, WIDE_DIALOG, type Loaded, type T } from './parts.tsx'
import { ProtectionGroup, ProtectionNotices, ProtectionOffDialog, ProtectionOnDialog } from './ProtectionGroup.tsx'
import { RestartCard, RestartDialog } from './RestartCard.tsx'
import { SelfDialog, SelfGroup, SelfReviewDialog } from './SelfGroup.tsx'
import { timeOfDay } from './time.ts'

/** The controller's reads and calls the section uses. */
export interface ChangesSectionInjected {
  readonly hooks: { readonly changes: HostObservable<ChangesLoad>, readonly harnessEffects: HostObservable<HarnessEffects>, readonly restarting: HostObservable<boolean> }
  /**
   * Read the state again without showing the loading state.
   * @returns after the state is current.
   */
  readonly reload: () => Promise<void>
  /**
   * Show the loading state and read the state.
   * @returns after the state is current.
   */
  readonly retry: () => Promise<void>
  /**
   * Read one change.
   * @param id - the change.
   * @returns the change, or its log entry.
   */
  readonly show: (id: string) => Promise<ShownView>
  /**
   * Read the plugins' folders and the person's copy of Delorun for the changes waiting for review.
   * @returns the changes.
   */
  readonly listPending: () => Promise<PendingListView>
  /**
   * Read the open work session's folder.
   * @param plugin - the plugin.
   * @returns the version `done` approves, with its difference.
   */
  readonly reviewWork: (plugin: string) => Promise<WorkReviewView>
  /**
   * Apply a change, or apply a change left out at a start again.
   * @param id - the change.
   * @param confirmedRisk - whether the person confirmed a second time.
   * @returns the outcome.
   */
  readonly apply: (id: string, confirmedRisk: boolean) => Promise<ActionOutcome>
  /**
   * Apply an agent's plugin request.
   * @param id - the request.
   * @param confirmedRisk - whether the person confirmed a second time.
   * @returns the outcome.
   */
  readonly applyRequest: (id: string, confirmedRisk: boolean) => Promise<ActionOutcome>
  /**
   * Discard a change.
   * @param id - the change.
   * @returns the outcome.
   */
  readonly discard: (id: string) => Promise<ActionOutcome>
  /**
   * Undo a change.
   * @param id - the change.
   * @returns the outcome.
   */
  readonly undo: (id: string) => Promise<ActionOutcome>
  /**
   * Open a work session.
   * @param plugin - the plugin.
   * @returns the outcome.
   */
  readonly beginWork: (plugin: string) => Promise<ActionOutcome>
  /**
   * End the work session, approving the version shown.
   * @param plugin - the plugin.
   * @param version - the version shown.
   * @param confirmedRisk - whether the person confirmed a second time.
   * @returns the outcome.
   */
  readonly done: (plugin: string, version: string, confirmedRisk: boolean) => Promise<ActionOutcome>
  /**
   * Apply a change waiting in the person's copy of Delorun.
   * @param id - the change.
   * @param to - the content version the review showed.
   * @param confirmedRisk - whether the person confirmed a second time.
   * @returns the outcome.
   */
  readonly harnessApply: (id: string, to: string, confirmedRisk: boolean) => Promise<ActionOutcome>
  /**
   * Undo a change to Delorun itself.
   * @param id - the change.
   * @returns the outcome.
   */
  readonly harnessUndo: (id: string) => Promise<ActionOutcome>
  /**
   * Discard a change waiting in the person's copy of Delorun.
   * @param id - the change.
   * @returns the outcome.
   */
  readonly harnessDiscard: (id: string) => Promise<ActionOutcome>
  /**
   * Make the person's copy of Delorun, or find it.
   * @returns the copy, or `refused`.
   */
  readonly makeCopy: () => Promise<CopyOutcome>
  /**
   * Ask for safe mode at the next start.
   * @returns the outcome.
   */
  readonly startSafeMode: () => Promise<ActionOutcome>
  /**
   * End safe mode.
   * @returns the outcome.
   */
  readonly exitSafeMode: () => Promise<ActionOutcome>
  /**
   * Turn protection on.
   * @returns the outcome.
   */
  readonly protectionOn: () => Promise<ActionOutcome>
  /**
   * Turn protection off.
   * @param confirmed - whether the person confirmed what would load without review.
   * @returns the outcome; `confirm-protection` until confirmed.
   */
  readonly protectionOff: (confirmed: boolean) => Promise<ActionOutcome>
  /**
   * Dismiss a notice that a paired device changed the protection setting.
   * @param id - the notice.
   * @returns the outcome.
   */
  readonly noticeSeen: (id: string) => Promise<ActionOutcome>
  /**
   * Restart Delorun so the changes to Delorun itself that wait for a restart run.
   * @param stopChats - stop the running chats instead of waiting for them.
   * @returns the outcome.
   */
  readonly restart: (stopChats: boolean) => Promise<ActionOutcome>
  /**
   * End a restart that still waits for running chats.
   * @returns the outcome.
   */
  readonly cancelRestart: () => Promise<ActionOutcome>
  /** Load the page again, so a change to the studio's own files shows. */
  readonly reloadPage: () => void
}

/** Props the renderer binds for the section. */
export type ChangesSectionProps = PropsRuntime<'settings.section'> & PropsLocale<'delorunChanges'> & InjectFace<ChangesSectionInjected>

/** What a second confirmation would send once the person confirms. */
type Flagged =
  | { readonly kind: 'apply', readonly id: string }
  | { readonly kind: 'applyRequest', readonly id: string, readonly summary: string }
  | { readonly kind: 'done', readonly plugin: string, readonly version: string }
  | { readonly kind: 'harnessApply', readonly id: string, readonly to: string }

/** A smaller confirmation before an action that needs no review. */
type Ask =
  | { readonly kind: 'undo', readonly entry: EntryView }
  | { readonly kind: 'applyAgain', readonly entry: EntryView }
  | { readonly kind: 'discardRequest', readonly entry: EntryView }
  | { readonly kind: 'applyRequest', readonly entry: EntryView }
  | { readonly kind: 'work', readonly plugin: string }
  | { readonly kind: 'selfUndo', readonly entry: HarnessEntryView }
  | { readonly kind: 'selfDiscard', readonly change: HarnessPendingView }
  | { readonly kind: 'safeModeOn' }
  | { readonly kind: 'safeModeOff' }

/** The dialog on display. */
type Dialog =
  | { readonly kind: 'review', readonly change: PendingView }
  | { readonly kind: 'selfReview', readonly change: HarnessPendingView }
  | { readonly kind: 'self', readonly entry: HarnessEntryView }
  | { readonly kind: 'done', readonly plugin: string }
  | { readonly kind: 'second', readonly flagged: Flagged, readonly kinds: readonly RiskKindView[], readonly notShown: readonly string[] }
  | { readonly kind: 'ask', readonly ask: Ask }
  | { readonly kind: 'protectionOn' }
  | { readonly kind: 'protectionOff', readonly willLoad: WillLoadView }
  | { readonly kind: 'restart', readonly runningChats: number | undefined }

/** Skeleton rows the first load lays out. */
const SKELETON_ROWS = [0, 1, 2] as const

/** What `show?pending` answers when there is nothing to read: no plugin under Changes and no copy. */
const NOTHING_PENDING: PendingListView = { kind: 'pending-list', pending: [], harness: [] }

/**
 * Render the section.
 * @param props - the dictionary, the state and the controller's calls.
 * @returns the section.
 */
export function ChangesSection(props: ChangesSectionProps) {
  const { t, reload, retry } = props
  const load = props.useChanges(value => value)
  const effects = props.useHarnessEffects(value => value)
  const restarting = props.useRestarting(value => value)
  const [dialog, setDialog] = useState<Dialog | undefined>()
  const [busy, setBusy] = useState(false)
  const [copy, setCopy] = useState<HarnessCopyView | undefined>()
  // Each value is one read of the folders and the copy; an action and Read again move to the next.
  const [folderRead, setFolderRead] = useState(0)
  useEffect(() => { void reload() }, [reload])
  const state = load.status === 'ready' ? load.state : undefined
  const hasCopy = state?.harnessAvailable.kind === 'available' && state.harnessAvailable.copy
  const folders = state?.folders ?? []
  const readKey = `${String(folderRead)} ${String(hasCopy)} ${folders.map(folder => folder.plugin).join(' ')}`
  const pending = useLoaded(() => folders.length === 0 && !hasCopy ? Promise.resolve(NOTHING_PENDING) : props.listPending(), readKey)
  const run = (action: () => Promise<ActionOutcome>, flagged?: Flagged): void => {
    setBusy(true)
    void action().then((outcome) => {
      if (outcome.kind === 'confirm' && flagged !== undefined) setDialog({ kind: 'second', flagged, kinds: outcome.kinds, notShown: outcome.notShown })
      else if (outcome.kind === 'confirm-protection') setDialog({ kind: 'protectionOff', willLoad: outcome.willLoad })
      else setDialog(undefined)
    }).finally(() => {
      setBusy(false)
      setFolderRead(read => read + 1)
    })
  }
  const makeCopy = (): void => {
    setBusy(true)
    void props.makeCopy().then((outcome) => {
      if (outcome.kind === 'done') setCopy(outcome.copy)
    }).finally(() => {
      setBusy(false)
      setFolderRead(read => read + 1)
    })
  }
  const controlOf = (control: Parameters<typeof controlUse>[1]) => state === undefined ? { disabled: true, title: undefined } : controlUse(state, control, t)
  return <div className={css.section} aria-busy={load.status === 'loading'}>
    <div className={css.header}>
      <h2 className={css.heading}>{t('title')}</h2>
    </div>
    <p className={css.lead}>{t('intro')}</p>
    {state?.protection === 'off' ? <p className={css.lead} role="note" data-delorun-changes-live>{t('live')}</p> : null}
    {load.status === 'loading'
      ? <div className={css.rows} role="status">
        <span className={css.visuallyHidden}>{t('loading')}</span>
        {SKELETON_ROWS.map(slot => <div key={slot} className={css.skeletonRow} aria-hidden="true">
          <span className={css.skeletonBar} />
          <span className={css.skeletonBar} />
        </div>)}
      </div>
      : null}
    {load.status === 'error'
      ? <div className={css.failure}>
        <p className={css.failureText} role="alert"><StateDot state="error" />{t('load.failed')}</p>
        <Button variant="outline" size="sm" onClick={() => { void retry() }}>{t('load.retry')}</Button>
      </div>
      : null}
    {state === undefined ? null : <>
      <AccessNote access={state.access} t={t} />
      <RestartCard state={state} restarting={restarting} t={t} busy={busy}
        onRestart={(runningChats) => { setDialog({ kind: 'restart', runningChats }) }}
        onCancel={() => { run(() => props.cancelRestart()) }}
        onUndo={(entry) => { setDialog({ kind: 'ask', ask: { kind: 'selfUndo', entry } }) }} />
      <ProtectionNotices notices={state.notices} t={t} busy={busy} onDismiss={(id) => { run(() => props.noticeSeen(id)) }} />
      <Facts state={state} t={t} />
      <SafeModeCard state={state} t={t} busy={busy} controlOf={controlOf}
        onChange={(on) => { setDialog({ kind: 'ask', ask: { kind: on ? 'safeModeOn' : 'safeModeOff' } }) }} />
      <WorkCard state={state} t={t} busy={busy}
        onDone={(plugin) => { setDialog({ kind: 'done', plugin }) }}
        onStart={(plugin) => { setDialog({ kind: 'ask', ask: { kind: 'work', plugin } }) }} />
      {state.leftOut.length === 0 ? null : <Group heading={t('leftOut.heading')}>
        {state.leftOut.map(entry => <li key={entry.id} className={css.row} data-change-id={entry.id}>
          <div className={css.main}>
            <div className={css.name}>{entry.plugin ?? entry.summary}</div>
            <p className={css.failureText}><StateDot state="error" />{t('leftOut.body', { plugin: entry.plugin ?? entry.summary, failure: entry.leftOut?.failure ?? '' })}</p>
          </div>
          <div className={css.actions}>
            <Button variant="outline" size="sm" disabled={busy || controlOf('plugin-apply').disabled} title={controlOf('plugin-apply').title} onClick={() => { setDialog({ kind: 'ask', ask: { kind: 'applyAgain', entry } }) }}>{t('leftOut.applyAgain')}</Button>
            <Button variant="outline" size="sm" disabled={busy || controlOf('plugin-undo').disabled} title={controlOf('plugin-undo').title} onClick={() => { setDialog({ kind: 'ask', ask: { kind: 'undo', entry } }) }}>{t('confirm.undo')}</Button>
          </div>
        </li>)}
      </Group>}
      <PendingGroup folders={folders} pending={pending} requests={state.requests.length} t={t} busy={busy}
        onReview={(change) => { setDialog({ kind: 'review', change }) }}
        onReadAgain={() => { setFolderRead(read => read + 1) }} />
      {state.requests.length === 0 ? null : <Group heading={t('requests.heading')}>
        {state.requests.map(entry => <li key={entry.id} className={css.row} data-change-id={entry.id}>
          <div className={css.main}>
            <div className={css.name}>{entry.summary}</div>
            <p className={css.meta}>{t('requests.terminal')}</p>
            <CommandText className={css.command} label={t('requests.command')} text={`delorun changes apply ${entry.id}`} />
          </div>
          <div className={css.actions}>
            <Button variant="outline" size="sm" disabled={busy || controlOf('plugin-discard').disabled} title={controlOf('plugin-discard').title} onClick={() => { setDialog({ kind: 'ask', ask: { kind: 'discardRequest', entry } }) }}>{t('review.discard')}</Button>
            <Button variant="outline" size="sm" disabled={busy || controlOf('plugin-apply').disabled} title={controlOf('plugin-apply').title} onClick={() => { setDialog({ kind: 'ask', ask: { kind: 'applyRequest', entry } }) }}>{t('review.apply')}</Button>
          </div>
        </li>)}
      </Group>}
      <Recent state={state} t={t} busy={busy} onUndo={(entry) => { setDialog({ kind: 'ask', ask: { kind: 'undo', entry } }) }} />
      <SelfGroup state={state} t={t} busy={busy} pending={hasCopy ? pending : undefined} effects={effects} copy={copy}
        onMakeCopy={makeCopy}
        onReview={(change) => { setDialog({ kind: 'selfReview', change }) }}
        onDiscard={(change) => { setDialog({ kind: 'ask', ask: { kind: 'selfDiscard', change } }) }}
        onShow={(entry) => { setDialog({ kind: 'self', entry }) }}
        onUndo={(entry) => { setDialog({ kind: 'ask', ask: { kind: 'selfUndo', entry } }) }}
        onReadAgain={() => { setFolderRead(read => read + 1) }}
        onReloadPage={props.reloadPage} />
      <ProtectionGroup state={state} t={t} busy={busy}
        onTurn={(level) => { if (level === 'on') setDialog({ kind: 'protectionOn' }); else run(() => props.protectionOff(false)) }} />
    </>}
    {state === undefined ? null : <Dialogs {...props} state={state} dialog={dialog} busy={busy} run={run} close={() => { setDialog(undefined) }} />}
  </div>
}

/**
 * The dialog on display, if any, wired to the controller's calls.
 * @param props - the section's props, the state, the dialog, whether an action runs, the runner and Close.
 * @returns the dialog, or nothing.
 */
function Dialogs(props: ChangesSectionProps & {
  readonly state: ChangesStateView
  readonly dialog: Dialog | undefined
  readonly busy: boolean
  readonly run: (action: () => Promise<ActionOutcome>, flagged?: Flagged) => void
  readonly close: () => void
}) {
  const { t, state, dialog, busy, run, close } = props
  switch (dialog?.kind) {
    case undefined: return null
    case 'review': return <ReviewDialog key={dialog.change.id} change={dialog.change} state={state} t={t} show={props.show} busy={busy}
      onClose={close}
      onApply={() => { run(() => props.apply(dialog.change.id, false), { kind: 'apply', id: dialog.change.id }) }}
      onDiscard={() => { run(() => props.discard(dialog.change.id)) }} />
    case 'selfReview': return <SelfReviewDialog key={dialog.change.id} change={dialog.change} state={state} t={t} show={props.show} busy={busy}
      onClose={close}
      onApply={(to) => { run(() => props.harnessApply(dialog.change.id, to, false), { kind: 'harnessApply', id: dialog.change.id, to }) }}
      onDiscard={() => { run(() => props.harnessDiscard(dialog.change.id)) }} />
    case 'self': return <SelfDialog key={dialog.entry.id} entry={dialog.entry} state={state} t={t} show={props.show} busy={busy}
      onClose={close} onUndo={() => { run(() => props.harnessUndo(dialog.entry.id)) }} />
    case 'restart': return <RestartDialog runningChats={dialog.runningChats} t={t} busy={busy} onClose={close}
      onRestart={(stopChats) => { run(() => props.restart(stopChats)) }} />
    case 'done': return <DoneDialog key={dialog.plugin} plugin={dialog.plugin} state={state} t={t} reviewWork={props.reviewWork} busy={busy}
      onClose={close}
      onApprove={(version) => { run(() => props.done(dialog.plugin, version, false), { kind: 'done', plugin: dialog.plugin, version }) }} />
    case 'second': return <SecondConfirmation dialog={dialog} t={t} busy={busy} onClose={close}
      onConfirm={() => {
        const { flagged } = dialog
        run(() => {
          switch (flagged.kind) {
            case 'apply': return props.apply(flagged.id, true)
            case 'applyRequest': return props.applyRequest(flagged.id, true)
            case 'done': return props.done(flagged.plugin, flagged.version, true)
            case 'harnessApply': return props.harnessApply(flagged.id, flagged.to, true)
          }
        })
      }} />
    case 'ask': return <AskDialog ask={dialog.ask} t={t} busy={busy} onClose={close}
      onConfirm={() => {
        const { ask } = dialog
        switch (ask.kind) {
          case 'undo': return run(() => props.undo(ask.entry.id))
          case 'applyAgain': return run(() => props.apply(ask.entry.id, false))
          case 'discardRequest': return run(() => props.discard(ask.entry.id))
          case 'applyRequest': return run(() => props.applyRequest(ask.entry.id, false), { kind: 'applyRequest', id: ask.entry.id, summary: ask.entry.summary })
          case 'work': return run(() => props.beginWork(ask.plugin))
          case 'selfUndo': return run(() => props.harnessUndo(ask.entry.id))
          case 'selfDiscard': return run(() => props.harnessDiscard(ask.change.id))
          case 'safeModeOn': return run(() => props.startSafeMode())
          case 'safeModeOff': return run(() => props.exitSafeMode())
        }
      }} />
    case 'protectionOn': return <ProtectionOnDialog loaded={state.unreviewedSinceOff} t={t} busy={busy} onClose={close}
      onConfirm={() => { run(() => props.protectionOn()) }} />
    case 'protectionOff': return <ProtectionOffDialog willLoad={dialog.willLoad} t={t} busy={busy} onClose={close}
      onConfirm={() => { run(() => props.protectionOff(true)) }} />
  }
}

/**
 * The changes waiting for review in the plugins' folders, from the section's read of `show?pending`.
 * @param props - the plugins under Changes, the read, how many requests wait, Review and Read again.
 * @returns the group.
 */
function PendingGroup({ folders, pending: loaded, requests, t, busy, onReview, onReadAgain }: {
  readonly folders: readonly FolderView[]
  readonly pending: Loaded<PendingListView>
  readonly requests: number
  readonly t: T
  readonly busy: boolean
  readonly onReview: (change: PendingView) => void
  readonly onReadAgain: () => void
}) {
  const pending = folders.length === 0 ? [] : loaded.status === 'ready' ? loaded.value.pending : undefined
  return <Group heading={t('pending.heading')}>
    {pending === undefined && loaded.status === 'loading' ? <li className={css.empty} role="status">{t('pending.reading')}</li> : null}
    {pending === undefined && loaded.status === 'error' ? <li className={css.empty}><p className={css.failureText} role="alert"><StateDot state="error" />{t('pending.unread')}</p></li> : null}
    {pending?.length === 0 && requests === 0 ? <li className={css.empty}>{t('pending.empty')}</li> : null}
    {(pending ?? []).map(change => <li key={change.id} className={css.row} data-change-id={change.id}>
      <div className={css.main}>
        <div className={css.name}>{change.plugin}</div>
        <div className={css.metaRow}>
          <span>{t(`kind.${change.kind}`)}</span>
          <span>{t(pluralKey('pending.files', change.files), { n: change.files })}</span>
          <span className={css.path}>{change.source}</span>
        </div>
        {change.riskKinds.length === 0 ? null : <div className={css.tags}>
          {change.riskKinds.map(kind => <Tag key={kind} tone="warning">{t(`risk.${kind}`)}</Tag>)}
        </div>}
        {change.lastFailure === undefined ? null : <p className={css.failureText}><StateDot state="error" />{t('pending.failed', { failure: change.lastFailure.failure })}</p>}
      </div>
      <div className={css.actions}>
        <Button variant="outline" size="sm" disabled={busy} onClick={() => { onReview(change) }}>{t('pending.review')}</Button>
      </div>
    </li>)}
    {folders.length === 0 || loaded.status === 'loading' ? null : <li className={css.empty}>
      <Button variant="outline" size="sm" disabled={busy} onClick={onReadAgain}>{t('pending.check')}</Button>
    </li>}
  </Group>
}

/**
 * The records that cannot be read, safe mode and a failed last start.
 * @param props - the state and the dictionary.
 * @returns the notes, or nothing.
 */
function Facts({ state, t }: { readonly state: ChangesStateView, readonly t: T }) {
  const failure = state.lastStart?.failure
  if (state.problems.length === 0 && state.safeMode === undefined && failure === undefined) return null
  return <div className={css.facts}>
    {state.problems.map(problem => <p key={problem} className={css.failureText} role="note"><StateDot state="error" />{t('problem', { problem })}</p>)}
    {state.safeMode === undefined ? null : <p className={css.meta} role="note">{t('safeMode')}</p>}
    {failure === undefined ? null : <p className={css.failureText} role="note"><StateDot state="error" />{t('lastStart.failed', { failure })}</p>}
  </div>
}

/**
 * Safe mode: whether it is on, and the button that starts or ends it for the next start.
 * @param props - the state, the dictionary, whether an action runs, each control's decision and the ask.
 * @returns the card.
 */
function SafeModeCard({ state, t, busy, controlOf, onChange }: {
  readonly state: ChangesStateView
  readonly t: T
  readonly busy: boolean
  readonly controlOf: (control: ChangesControl) => { readonly disabled: boolean, readonly title: string | undefined }
  readonly onChange: (on: boolean) => void
}) {
  const on = state.safeMode !== undefined
  const use = controlOf('plugin-other')
  return <Group heading={t('safeMode.heading')}>
    <li className={css.row} data-delorun-safe-mode={on ? 'on' : 'off'}>
      <div className={css.main}>
        <p className={css.meta}>{t(on ? 'safeMode.onBody' : 'safeMode.offBody')}</p>
        <div className={css.actions}>
          <Button variant="outline" size="sm" disabled={busy || use.disabled} title={use.title} onClick={() => { onChange(!on) }}>{t(on ? 'safeMode.leave' : 'safeMode.start')}</Button>
        </div>
      </div>
    </li>
  </Group>
}

/**
 * The work session: the plugin worked on with Done, or the plugins of the last start with Start working.
 * @param props - the state, the dictionary, whether an action runs and the two actions.
 * @returns the card.
 */
function WorkCard({ state, t, busy, onDone, onStart }: {
  readonly state: ChangesStateView
  readonly t: T
  readonly busy: boolean
  readonly onDone: (plugin: string) => void
  readonly onStart: (plugin: string) => void
}) {
  const session = state.workSession
  const use = controlUse(state, 'plugin-other', t)
  if (session !== undefined) {
    return <Group heading={t('work.heading')}>
      <li className={css.row} data-work-session={session.plugin}>
        <div className={css.main}>
          <div className={css.name}><StateDot state="warning" />{t('work.active', { plugin: session.plugin })}</div>
          <p className={css.meta}>{t('work.activeBody', { folder: session.source, time: timeOfDay(session.endsAt) })}</p>
          {session.lastError === undefined ? null : <p className={css.failureText} role="alert"><StateDot state="error" />{t('work.lastError', { error: session.lastError.error })}</p>}
        </div>
        <div className={css.actions}>
          <Button variant="primary" size="sm" disabled={busy || use.disabled} title={use.title} onClick={() => { onDone(session.plugin) }}>{t('work.done')}</Button>
        </div>
      </li>
    </Group>
  }
  const plugins = state.lastStart?.plugins ?? []
  return <Group heading={t('work.heading')}>
    <li className={css.empty}>{t(plugins.length === 0 ? 'work.none' : 'work.idle')}</li>
    {plugins.map(plugin => <li key={plugin.plugin} className={css.row}>
      <div className={css.main}>
        <div className={css.name}>{plugin.plugin}</div>
        {plugin.loaded ? null : <p className={css.failureText}><StateDot state="error" />{plugin.error ?? t('work.notLoaded')}</p>}
      </div>
      <div className={css.actions}>
        <Button variant="outline" size="sm" disabled={busy || use.disabled} title={use.title} onClick={() => { onStart(plugin.plugin) }}>{t('work.start')}</Button>
      </div>
    </li>)}
  </Group>
}

/**
 * The newest decided changes with Undo where one can be undone.
 * @param props - the state, the dictionary, whether an action runs and Undo.
 * @returns the group.
 */
function Recent({ state, t, busy, onUndo }: { readonly state: ChangesStateView, readonly t: T, readonly busy: boolean, readonly onUndo: (entry: EntryView) => void }) {
  const now = Date.now()
  const undo = controlUse(state, 'plugin-undo', t)
  return <Group heading={t('recent.heading')}>
    {state.recent.length === 0 ? <li className={css.empty}>{t('recent.empty')}</li> : null}
    {state.recent.map((entry) => {
      const at = relativeTime(Date.parse(entry.decidedAt ?? entry.createdAt), now)
      return <li key={entry.id} className={css.row} data-change-id={entry.id}>
        <div className={css.main}>
          <div className={css.name}>{entry.summary}</div>
          <div className={css.metaRow}>
            <span>{t(`state.${entry.state}`)}</span>
            <span>{t(`recent.at.${at.unit}`, { n: at.n })}</span>
            {entry.decidedOn === undefined ? null : <span>{t('decidedOn', { device: entry.decidedOn })}</span>}
          </div>
        </div>
        {entry.undoable
          ? <div className={css.actions}>
            <Button variant="outline" size="sm" disabled={busy || undo.disabled} title={undo.title} onClick={() => { onUndo(entry) }}>{t('confirm.undo')}</Button>
          </div>
          : null}
      </li>
    })}
  </Group>
}

/**
 * Review one pending change, with Discard and Apply.
 * @param props - the change, the state, the read and the actions.
 * @returns the dialog.
 */
function ReviewDialog({ change, state, t, show, busy, onClose, onApply, onDiscard }: {
  readonly change: PendingView
  readonly state: ChangesStateView
  readonly t: T
  readonly show: (id: string) => Promise<ShownView>
  readonly busy: boolean
  readonly onClose: () => void
  readonly onApply: () => void
  readonly onDiscard: () => void
}) {
  const loaded = useLoaded(() => show(change.id))
  const pending = loaded.status === 'ready' && loaded.value.kind === 'pending' ? loaded.value.change : undefined
  const apply = controlUse(state, 'plugin-apply', t)
  const discard = controlUse(state, 'plugin-discard', t)
  return <Modal open onClose={onClose} title={t('review.title', { plugin: change.plugin })} closeLabel={t('confirm.close')}
    {...WIDE_DIALOG}
    footer={<>
      <Button variant="outline" data-modal-autofocus onClick={onClose}>{t('confirm.cancel')}</Button>
      <Button variant="outline" className={css.danger} disabled={busy || pending === undefined || discard.disabled} title={discard.title} onClick={onDiscard}>{t('review.discard')}</Button>
      <Button variant="primary" disabled={busy || pending === undefined || apply.disabled} title={apply.title} onClick={onApply}>{t('review.apply')}</Button>
    </>}>
    <LoadLine loaded={loaded} t={t} />
    {loaded.status === 'ready' && loaded.value.kind === 'logged' ? <p className={css.meta}>{t('review.gone')}</p> : null}
    {pending === undefined ? null : <ChangeDetail change={pending} t={t} />}
  </Modal>
}

/**
 * End the work session: the folder's version and its difference, and approving exactly that version.
 * @param props - the plugin, the state, the read and the action.
 * @returns the dialog.
 */
function DoneDialog({ plugin, state, t, reviewWork, busy, onClose, onApprove }: {
  readonly plugin: string
  readonly state: ChangesStateView
  readonly t: T
  readonly reviewWork: (plugin: string) => Promise<WorkReviewView>
  readonly busy: boolean
  readonly onClose: () => void
  readonly onApprove: (version: string) => void
}) {
  const loaded = useLoaded(() => reviewWork(plugin))
  const review = loaded.status === 'ready' ? loaded.value : undefined
  const version = review?.version
  const short = version?.slice(0, SHORT_VERSION) ?? ''
  const use = controlUse(state, 'plugin-other', t)
  return <Modal open onClose={onClose} title={t('done.title', { plugin })} closeLabel={t('confirm.close')}
    {...WIDE_DIALOG}
    footer={<>
      <Button variant="outline" data-modal-autofocus onClick={onClose}>{t('confirm.cancel')}</Button>
      {version === undefined
        ? null
        : <Button variant="primary" disabled={busy || use.disabled} title={use.title} onClick={() => { onApprove(version) }}>
          {review?.change === undefined ? t('done.end') : t('done.approve', { version: short })}
        </Button>}
    </>}>
    <LoadLine loaded={loaded} t={t} />
    {review === undefined ? null : <>
      {version === undefined
        ? <p className={css.meta}>{t('done.gone')}</p>
        : <p className={css.text} data-work-version={version}>{t('done.version', { version: short })}</p>}
      {review.failedToLoad ? <p className={css.failureText} role="alert"><StateDot state="error" />{t('done.failedToLoad')}</p> : null}
      {review.change === undefined
        ? version === undefined ? null : <p className={css.meta}>{t('done.same')}</p>
        : <ChangeDetail change={review.change} t={t} />}
    </>}
  </Modal>
}

/**
 * The second confirmation of a change the checks flagged: what they found, each file the diff does not show, and the
 * sentence that the summary is a help and not a protection.
 * @param props - what the route answered, whether an action runs, and the action.
 * @returns the dialog.
 */
function SecondConfirmation({ dialog, t, busy, onClose, onConfirm }: {
  readonly dialog: Extract<Dialog, { kind: 'second' }>
  readonly t: T
  readonly busy: boolean
  readonly onClose: () => void
  readonly onConfirm: () => void
}) {
  return <Modal open onClose={onClose} title={t(dialog.flagged.kind === 'applyRequest' ? 'confirm.applyRequest.title' : 'second.title')} closeLabel={t('confirm.close')}
    footer={<>
      <Button variant="outline" data-modal-autofocus onClick={onClose}>{t('confirm.cancel')}</Button>
      <Button variant="primary" disabled={busy} onClick={onConfirm}>{t(dialog.flagged.kind === 'done' ? 'second.approve' : 'second.apply')}</Button>
    </>}>
    {dialog.flagged.kind === 'applyRequest'
      ? <p className={css.confirmText}>{t('second.request', { summary: dialog.flagged.summary })}</p>
      : <p className={css.confirmText}>{t('second.body')}</p>}
    <ul className={css.riskList}>{dialog.kinds.map(kind => <li key={kind} data-risk-kind={kind}><span className={css.riskKind}>{t(`risk.${kind}`)}</span></li>)}</ul>
    {dialog.notShown.length === 0 ? null : <>
      <p className={css.confirmText}>{t('second.notShown')}</p>
      <ul className={css.plainList}>{dialog.notShown.map(file => <li key={file}>{file}</li>)}</ul>
    </>}
    <p className={css.notice} role="note">{t(dialog.flagged.kind === 'harnessApply' ? 'self.notice' : 'risk.notice')}</p>
  </Modal>
}

/**
 * The confirmation before Undo, Apply again, applying or discarding an agent's request, Start working, and undoing or
 * discarding a change to Delorun itself.
 * @param props - what is asked, whether an action runs, and the action.
 * @returns the dialog.
 */
function AskDialog({ ask, t, busy, onClose, onConfirm }: {
  readonly ask: Ask
  readonly t: T
  readonly busy: boolean
  readonly onClose: () => void
  readonly onConfirm: () => void
}) {
  const copy = askCopy(ask, t)
  return <Modal open onClose={onClose} title={copy.title} closeLabel={t('confirm.close')}
    footer={<>
      <Button variant="outline" data-modal-autofocus onClick={onClose}>{t('confirm.cancel')}</Button>
      <Button variant="primary" disabled={busy} onClick={onConfirm}>{copy.confirm}</Button>
    </>}>
    <p className={css.confirmText}>{copy.body}</p>
  </Modal>
}

/**
 * @param ask - what is asked.
 * @param t - the dictionary.
 * @returns the dialog's title, body and confirm label.
 */
function askCopy(ask: Ask, t: T): { readonly title: string, readonly body: string, readonly confirm: string } {
  switch (ask.kind) {
    case 'undo': return { title: t('confirm.undo.title'), body: t('confirm.undo.body', { summary: ask.entry.summary }), confirm: t('confirm.undo') }
    case 'applyAgain': return { title: t('confirm.applyAgain.title'), body: t('confirm.applyAgain.body', { summary: ask.entry.summary }), confirm: t('leftOut.applyAgain') }
    case 'discardRequest': return { title: t('confirm.discardRequest.title'), body: t('confirm.discardRequest.body', { summary: ask.entry.summary }), confirm: t('review.discard') }
    case 'applyRequest': return { title: t('confirm.applyRequest.title'), body: t('confirm.applyRequest.body', { summary: ask.entry.summary }), confirm: t('review.apply') }
    case 'work': return { title: t('confirm.work.title', { plugin: ask.plugin }), body: t('confirm.work.body'), confirm: t('work.start') }
    case 'selfUndo': return { title: t('confirm.undo.title'), body: t('confirm.selfUndo.body', { file: ask.entry.file }), confirm: t('confirm.undo') }
    case 'selfDiscard': return { title: t('confirm.selfDiscard.title'), body: t('confirm.selfDiscard.body', { file: ask.change.file }), confirm: t('review.discard') }
    case 'safeModeOn': return { title: t('confirm.safeModeOn.title'), body: t('confirm.safeModeOn.body'), confirm: t('safeMode.start') }
    case 'safeModeOff': return { title: t('confirm.safeModeOff.title'), body: t('confirm.safeModeOff.body'), confirm: t('safeMode.leave') }
  }
}
