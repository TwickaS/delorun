/**
 * The Changes section in Settings: the work session, the changes a start left out, the changes and the agent's
 * requests waiting for review, the recent changes and the protection setting. Review opens a change with its diff and
 * risk summary; Apply, Discard, Undo, Apply again, Start working and Done act through the harness's Changes routes, and
 * a change the checks flagged asks a second confirmation that names what they found. A page that is not at the
 * computer shows everything with every action disabled.
 */
import { useEffect, useState, type ReactNode } from 'react'
import { Button, CommandText, Modal, relativeTime, StateDot, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import type { HostObservable, InjectFace, PropsLocale, PropsRuntime, TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { ChangesStateView, EntryView, PendingView, RiskKindView, ShownView, WorkReviewView } from '../wire.ts'
import type { ActionOutcome, ChangesLoad } from './controller.ts'
import { ChangeDetail } from './ChangeDetail.tsx'
import css from './ChangesSection.module.css'
import { timeOfDay } from './time.ts'

/** The controller's reads and calls the section uses. */
export interface ChangesSectionInjected {
  readonly hooks: { readonly changes: HostObservable<ChangesLoad>, readonly refusedRemote: HostObservable<boolean> }
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
}

/** Props the renderer binds for the section. */
export type ChangesSectionProps = PropsRuntime<'settings.section'> & PropsLocale<'deloChanges'> & InjectFace<ChangesSectionInjected>

/** The dictionary the section's parts read. */
type T = TranslateNS<'deloChanges'>

/** What a second confirmation would send once the person confirms. */
type Flagged = { readonly kind: 'apply', readonly id: string } | { readonly kind: 'done', readonly plugin: string, readonly version: string }

/** A smaller confirmation before an action that needs no review. */
type Ask =
  | { readonly kind: 'undo', readonly entry: EntryView }
  | { readonly kind: 'applyAgain', readonly entry: EntryView }
  | { readonly kind: 'discardRequest', readonly entry: EntryView }
  | { readonly kind: 'work', readonly plugin: string }

/** The dialog on display. */
type Dialog =
  | { readonly kind: 'review', readonly change: PendingView }
  | { readonly kind: 'done', readonly plugin: string }
  | { readonly kind: 'second', readonly flagged: Flagged, readonly kinds: readonly RiskKindView[], readonly notShown: readonly string[] }
  | { readonly kind: 'ask', readonly ask: Ask }

/** Skeleton rows the first load lays out. */
const SKELETON_ROWS = [0, 1, 2] as const

/** The review dialogs' classes: wider than a confirmation, with the detail scrolling inside. The module defines both. */
const WIDE_DIALOG = { className: String(css.wideDialog), contentClassName: String(css.wideContent) }

/** How many hex digits of a version the person reads, as the terminal prints it. */
const SHORT_VERSION = 7

/**
 * The key of the singular or the plural copy for a count.
 * @param base - the key without its `.one` or `.other` suffix.
 * @param count - the count the copy states.
 * @returns the key to translate.
 */
function pluralKey<B extends string>(base: B, count: number) {
  return `${base}.${count === 1 ? 'one' : 'other'}` as const
}

/**
 * Render the section.
 * @param props - the dictionary, the state and the controller's calls.
 * @returns the section.
 */
export function ChangesSection(props: ChangesSectionProps) {
  const { t, reload, retry } = props
  const load = props.useChanges(value => value)
  const refusedRemote = props.useRefusedRemote(value => value)
  const [dialog, setDialog] = useState<Dialog | undefined>()
  const [busy, setBusy] = useState(false)
  useEffect(() => { void reload() }, [reload])
  const state = load.status === 'ready' ? load.state : undefined
  const canAct = state?.atComputer === true && !refusedRemote
  const run = (action: () => Promise<ActionOutcome>, flagged?: Flagged): void => {
    setBusy(true)
    void action().then((outcome) => {
      setDialog(outcome.kind === 'confirm' && flagged !== undefined
        ? { kind: 'second', flagged, kinds: outcome.kinds, notShown: outcome.notShown }
        : undefined)
    }).finally(() => { setBusy(false) })
  }
  const disabled = busy || !canAct
  return <div className={css.section} aria-busy={load.status === 'loading'}>
    <div className={css.header}>
      <h2 className={css.heading}>{t('title')}</h2>
    </div>
    <p className={css.meta}>{t('intro')}</p>
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
      {canAct ? null : <div className={css.remote} role="note" data-delo-changes-remote>
        <p className={css.remoteTitle}>{t('remote.title')}</p>
        <p className={css.meta}>{t('remote.body')}</p>
      </div>}
      <Facts state={state} t={t} />
      <WorkCard state={state} t={t} disabled={disabled}
        onDone={(plugin) => { setDialog({ kind: 'done', plugin }) }}
        onStart={(plugin) => { setDialog({ kind: 'ask', ask: { kind: 'work', plugin } }) }} />
      {state.leftOut.length === 0 ? null : <Group heading={t('leftOut.heading')}>
        {state.leftOut.map(entry => <li key={entry.id} className={css.row} data-change-id={entry.id}>
          <div className={css.main}>
            <div className={css.name}>{entry.plugin ?? entry.summary}</div>
            <p className={css.failureText}><StateDot state="error" />{t('leftOut.body', { plugin: entry.plugin ?? entry.summary, failure: entry.leftOut?.failure ?? '' })}</p>
          </div>
          <div className={css.actions}>
            <Button variant="outline" size="sm" disabled={disabled} onClick={() => { setDialog({ kind: 'ask', ask: { kind: 'applyAgain', entry } }) }}>{t('leftOut.applyAgain')}</Button>
            <Button variant="outline" size="sm" disabled={disabled} onClick={() => { setDialog({ kind: 'ask', ask: { kind: 'undo', entry } }) }}>{t('confirm.undo')}</Button>
          </div>
        </li>)}
      </Group>}
      <Group heading={t('pending.heading')}>
        {state.pending.length === 0 && state.requests.length === 0 ? <li className={css.empty}>{t('pending.empty')}</li> : null}
        {state.pending.map(change => <li key={change.id} className={css.row} data-change-id={change.id}>
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
            <Button variant="outline" size="sm" disabled={busy} onClick={() => { setDialog({ kind: 'review', change }) }}>{t('pending.review')}</Button>
          </div>
        </li>)}
      </Group>
      {state.requests.length === 0 ? null : <Group heading={t('requests.heading')}>
        {state.requests.map(entry => <li key={entry.id} className={css.row} data-change-id={entry.id}>
          <div className={css.main}>
            <div className={css.name}>{entry.summary}</div>
            <p className={css.meta}>{t('requests.terminal')}</p>
            <CommandText className={css.command} label={t('requests.command')} text={`delorun changes apply ${entry.id}`} />
          </div>
          <div className={css.actions}>
            <Button variant="outline" size="sm" disabled={disabled} onClick={() => { setDialog({ kind: 'ask', ask: { kind: 'discardRequest', entry } }) }}>{t('review.discard')}</Button>
          </div>
        </li>)}
      </Group>}
      <Recent state={state} t={t} disabled={disabled} onUndo={(entry) => { setDialog({ kind: 'ask', ask: { kind: 'undo', entry } }) }} />
      <Protection state={state} t={t} />
    </>}
    {dialog?.kind === 'review'
      ? <ReviewDialog key={dialog.change.id} change={dialog.change} t={t} show={props.show} busy={busy} canAct={canAct}
        onClose={() => { setDialog(undefined) }}
        onApply={() => { run(() => props.apply(dialog.change.id, false), { kind: 'apply', id: dialog.change.id }) }}
        onDiscard={() => { run(() => props.discard(dialog.change.id)) }} />
      : null}
    {dialog?.kind === 'done'
      ? <DoneDialog key={dialog.plugin} plugin={dialog.plugin} t={t} reviewWork={props.reviewWork} busy={busy} canAct={canAct}
        onClose={() => { setDialog(undefined) }}
        onApprove={(version) => { run(() => props.done(dialog.plugin, version, false), { kind: 'done', plugin: dialog.plugin, version }) }} />
      : null}
    {dialog?.kind === 'second'
      ? <SecondConfirmation dialog={dialog} t={t} busy={busy} canAct={canAct}
        onClose={() => { setDialog(undefined) }}
        onConfirm={() => {
          const { flagged } = dialog
          run(() => flagged.kind === 'apply' ? props.apply(flagged.id, true) : props.done(flagged.plugin, flagged.version, true))
        }} />
      : null}
    {dialog?.kind === 'ask'
      ? <AskDialog ask={dialog.ask} t={t} busy={busy} canAct={canAct}
        onClose={() => { setDialog(undefined) }}
        onConfirm={() => {
          const { ask } = dialog
          switch (ask.kind) {
            case 'undo': return run(() => props.undo(ask.entry.id))
            case 'applyAgain': return run(() => props.apply(ask.entry.id, false))
            case 'discardRequest': return run(() => props.discard(ask.entry.id))
            case 'work': return run(() => props.beginWork(ask.plugin))
          }
        }} />
      : null}
  </div>
}

/**
 * One titled list of the section.
 * @param props - the heading and the rows.
 * @returns the group.
 */
function Group({ heading, children }: { readonly heading: string, readonly children: ReactNode }) {
  return <section className={css.group} aria-label={heading}>
    <h3 className={css.groupHeading}>{heading}</h3>
    <ul className={css.rows}>{children}</ul>
  </section>
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
 * The work session: the plugin worked on with Done, or the plugins of the last start with Start working.
 * @param props - the state, the dictionary, whether actions are disabled and the two actions.
 * @returns the card.
 */
function WorkCard({ state, t, disabled, onDone, onStart }: {
  readonly state: ChangesStateView
  readonly t: T
  readonly disabled: boolean
  readonly onDone: (plugin: string) => void
  readonly onStart: (plugin: string) => void
}) {
  const session = state.workSession
  if (session !== undefined) {
    return <Group heading={t('work.heading')}>
      <li className={css.row} data-work-session={session.plugin}>
        <div className={css.main}>
          <div className={css.name}><StateDot state="warning" />{t('work.active', { plugin: session.plugin })}</div>
          <p className={css.meta}>{t('work.activeBody', { folder: session.source, time: timeOfDay(session.endsAt) })}</p>
          {session.lastError === undefined ? null : <p className={css.failureText} role="alert"><StateDot state="error" />{t('work.lastError', { error: session.lastError.error })}</p>}
        </div>
        <div className={css.actions}>
          <Button variant="primary" size="sm" disabled={disabled} onClick={() => { onDone(session.plugin) }}>{t('work.done')}</Button>
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
        <Button variant="outline" size="sm" disabled={disabled} onClick={() => { onStart(plugin.plugin) }}>{t('work.start')}</Button>
      </div>
    </li>)}
  </Group>
}

/**
 * The newest decided changes with Undo where one can be undone.
 * @param props - the state, the dictionary, whether actions are disabled and Undo.
 * @returns the group.
 */
function Recent({ state, t, disabled, onUndo }: { readonly state: ChangesStateView, readonly t: T, readonly disabled: boolean, readonly onUndo: (entry: EntryView) => void }) {
  const now = Date.now()
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
          </div>
        </div>
        {entry.undoable
          ? <div className={css.actions}>
            <Button variant="outline" size="sm" disabled={disabled} onClick={() => { onUndo(entry) }}>{t('confirm.undo')}</Button>
          </div>
          : null}
      </li>
    })}
  </Group>
}

/**
 * The protection setting, with the terminal command that changes it and no control.
 * @param props - the state and the dictionary.
 * @returns the group, or nothing when the setting cannot be read.
 */
function Protection({ state, t }: { readonly state: ChangesStateView, readonly t: T }) {
  if (state.protection === undefined) return null
  return <Group heading={t('protection.heading')}>
    <li className={css.row} data-protection={state.protection}>
      <div className={css.main}>
        <p className={css.text}>{t(`protection.${state.protection}`)}</p>
        <p className={css.meta}>{t('protection.change')}</p>
        <CommandText className={css.command} label={t('protection.command')} text="delorun changes protection block|warn|off" />
      </div>
    </li>
  </Group>
}

/** A read the dialogs wait for: loading, failed, or the answer. */
type Loaded<V> = { readonly status: 'loading' } | { readonly status: 'error' } | { readonly status: 'ready', readonly value: V }

/**
 * Read once when a dialog opens.
 * @param read - the read.
 * @returns the read's progress.
 */
function useLoaded<V>(read: () => Promise<V>): Loaded<V> {
  const [loaded, setLoaded] = useState<Loaded<V>>({ status: 'loading' })
  useEffect(() => {
    let live = true
    read().then(
      (value) => { if (live) setLoaded({ status: 'ready', value }) },
      (error: unknown) => {
        console.warn('delo-changes: the change was not read:', error)
        if (live) setLoaded({ status: 'error' })
      },
    )
    return () => { live = false }
    // A dialog reads once while it is open; the section keys each dialog by its change or plugin, so another reads again.
  }, [])
  return loaded
}

/**
 * The loading line or the failure of a dialog's read.
 * @param props - the progress and its copy.
 * @returns the line, or nothing once read.
 */
function LoadLine({ loaded, t, loading, failed }: { readonly loaded: Loaded<unknown>, readonly t: T, readonly loading: 'review.loading', readonly failed: 'review.failed' }) {
  if (loaded.status === 'loading') return <p className={css.meta} role="status">{t(loading)}</p>
  if (loaded.status === 'error') return <p className={css.failureText} role="alert"><StateDot state="error" />{t(failed)}</p>
  return null
}

/**
 * Review one pending change, with Discard and Apply.
 * @param props - the change, the read, the actions and whether they are available.
 * @returns the dialog.
 */
function ReviewDialog({ change, t, show, busy, canAct, onClose, onApply, onDiscard }: {
  readonly change: PendingView
  readonly t: T
  readonly show: (id: string) => Promise<ShownView>
  readonly busy: boolean
  readonly canAct: boolean
  readonly onClose: () => void
  readonly onApply: () => void
  readonly onDiscard: () => void
}) {
  const loaded = useLoaded(() => show(change.id))
  const pending = loaded.status === 'ready' && loaded.value.kind === 'pending' ? loaded.value.change : undefined
  const disabled = busy || !canAct || pending === undefined
  return <Modal open onClose={onClose} title={t('review.title', { plugin: change.plugin })} closeLabel={t('confirm.close')}
    {...WIDE_DIALOG}
    footer={<>
      <Button variant="outline" data-modal-autofocus onClick={onClose}>{t('confirm.cancel')}</Button>
      <Button variant="outline" className={css.danger} disabled={disabled} onClick={onDiscard}>{t('review.discard')}</Button>
      <Button variant="primary" disabled={disabled} onClick={onApply}>{t('review.apply')}</Button>
    </>}>
    <LoadLine loaded={loaded} t={t} loading="review.loading" failed="review.failed" />
    {loaded.status === 'ready' && loaded.value.kind === 'logged' ? <p className={css.meta}>{t('review.gone')}</p> : null}
    {pending === undefined ? null : <ChangeDetail change={pending} t={t} />}
  </Modal>
}

/**
 * End the work session: the folder's version and its difference, and approving exactly that version.
 * @param props - the plugin, the read, the action and whether it is available.
 * @returns the dialog.
 */
function DoneDialog({ plugin, t, reviewWork, busy, canAct, onClose, onApprove }: {
  readonly plugin: string
  readonly t: T
  readonly reviewWork: (plugin: string) => Promise<WorkReviewView>
  readonly busy: boolean
  readonly canAct: boolean
  readonly onClose: () => void
  readonly onApprove: (version: string) => void
}) {
  const loaded = useLoaded(() => reviewWork(plugin))
  const review = loaded.status === 'ready' ? loaded.value : undefined
  const version = review?.version
  const short = version?.slice(0, SHORT_VERSION) ?? ''
  return <Modal open onClose={onClose} title={t('done.title', { plugin })} closeLabel={t('confirm.close')}
    {...WIDE_DIALOG}
    footer={<>
      <Button variant="outline" data-modal-autofocus onClick={onClose}>{t('confirm.cancel')}</Button>
      {version === undefined
        ? null
        : <Button variant="primary" disabled={busy || !canAct} onClick={() => { onApprove(version) }}>
          {review?.change === undefined ? t('done.end') : t('done.approve', { version: short })}
        </Button>}
    </>}>
    <LoadLine loaded={loaded} t={t} loading="review.loading" failed="review.failed" />
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
 * @param props - what the route answered, the action and whether it is available.
 * @returns the dialog.
 */
function SecondConfirmation({ dialog, t, busy, canAct, onClose, onConfirm }: {
  readonly dialog: Extract<Dialog, { kind: 'second' }>
  readonly t: T
  readonly busy: boolean
  readonly canAct: boolean
  readonly onClose: () => void
  readonly onConfirm: () => void
}) {
  return <Modal open onClose={onClose} title={t('second.title')} closeLabel={t('confirm.close')}
    footer={<>
      <Button variant="outline" data-modal-autofocus onClick={onClose}>{t('confirm.cancel')}</Button>
      <Button variant="primary" disabled={busy || !canAct} onClick={onConfirm}>{t(dialog.flagged.kind === 'apply' ? 'second.apply' : 'second.approve')}</Button>
    </>}>
    <p className={css.confirmText}>{t('second.body')}</p>
    <ul className={css.riskList}>{dialog.kinds.map(kind => <li key={kind} data-risk-kind={kind}><span className={css.riskKind}>{t(`risk.${kind}`)}</span></li>)}</ul>
    {dialog.notShown.length === 0 ? null : <>
      <p className={css.confirmText}>{t('second.notShown')}</p>
      <ul className={css.plainList}>{dialog.notShown.map(file => <li key={file}>{file}</li>)}</ul>
    </>}
    <p className={css.notice} role="note">{t('risk.notice')}</p>
  </Modal>
}

/**
 * The confirmation before Undo, Apply again, discarding an agent's request and Start working.
 * @param props - what is asked, the action and whether it is available.
 * @returns the dialog.
 */
function AskDialog({ ask, t, busy, canAct, onClose, onConfirm }: {
  readonly ask: Ask
  readonly t: T
  readonly busy: boolean
  readonly canAct: boolean
  readonly onClose: () => void
  readonly onConfirm: () => void
}) {
  const copy = askCopy(ask, t)
  return <Modal open onClose={onClose} title={copy.title} closeLabel={t('confirm.close')}
    footer={<>
      <Button variant="outline" data-modal-autofocus onClick={onClose}>{t('confirm.cancel')}</Button>
      <Button variant="primary" disabled={busy || !canAct} onClick={onConfirm}>{copy.confirm}</Button>
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
    case 'work': return { title: t('confirm.work.title', { plugin: ask.plugin }), body: t('confirm.work.body'), confirm: t('work.start') }
  }
}
