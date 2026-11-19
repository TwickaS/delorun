/**
 * The frame-wide update cards: the progress card while an update or a rollback waits for chats or switches, the
 * outcome card from the home process's record ("Updated to …", or that it did not work and Delorun went back), the
 * report dialog the sidebar's Update now and Settings → Updates open, and the line that says the page reloads. They
 * outlive the Settings dialog, so a person who closed Settings still sees the update finish.
 */
import { useState } from 'react'
import { Button, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import type { HostObservable, InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { UpdateResultView, UpdateStateView } from '../wire.ts'
import type { UpdateLoad } from './controller.ts'
import { UpdateDialog, type UpdateDialogActions } from './UpdateDialog.tsx'
import css from './UpdatePanel.module.css'
import { controlUse, pluralKey, type T } from './parts.tsx'

/** What the overlay reads and does. */
export interface UpdateOverlayInjected {
  readonly hooks: { readonly load: HostObservable<UpdateLoad>, readonly switching: HostObservable<boolean>, readonly dialog: HostObservable<boolean> }
  readonly actions: UpdateDialogActions
  readonly cancel: () => Promise<unknown>
  readonly dismiss: () => Promise<unknown>
  readonly closeDialog: () => void
  readonly openChanges: () => void
}

/** Props of the `shell.overlay` entry. */
export type UpdateOverlayProps = PropsRuntime<'shell.overlay'> & PropsLocale<'delorunUpdate'> & InjectFace<UpdateOverlayInjected>

/**
 * Render the overlay's cards and dialog.
 * @param props - the hooks, the actions and the dictionary.
 * @returns the cards and the dialog, or nothing.
 */
export function UpdateOverlay(props: UpdateOverlayProps) {
  const { t, actions, cancel, dismiss, closeDialog, openChanges } = props
  const load = props.useLoad(value => value)
  const switching = props.useSwitching(value => value)
  const dialog = props.useDialog(value => value)
  return <UpdateCards t={t} load={load} switching={switching} dialog={dialog} actions={actions} cancel={cancel} dismiss={dismiss} closeDialog={closeDialog} openChanges={openChanges} />
}

/** What {@link UpdateCards} draws, read from the hooks. */
export interface UpdateCardsProps extends Omit<UpdateOverlayInjected, 'hooks'> {
  readonly t: T
  readonly load: UpdateLoad
  readonly switching: boolean
  readonly dialog: boolean
}

/**
 * Draw the cards and the dialog for the values the hooks gave.
 * @param props - the values, the actions and the dictionary.
 * @returns the cards and the dialog, or nothing.
 */
export function UpdateCards({ t, load, switching, dialog, actions, cancel, dismiss, closeDialog, openChanges }: UpdateCardsProps) {
  const state = load.status === 'ready' ? load.state : undefined
  const reconnecting = load.status === 'ready' && load.reconnecting
  return <>
    {state === undefined ? null : <div className={css.overlay}>
      <ProgressCard state={state} switching={switching} reconnecting={reconnecting} t={t} cancel={cancel} />
      {state.result === undefined || state.progress.kind !== 'idle' ? null : <OutcomeCard state={state} result={state.result} t={t} dismiss={dismiss} />}
    </div>}
    {dialog && state !== undefined
      ? <UpdateDialog state={state} t={t} actions={actions} onClose={closeDialog} openChanges={openChanges} />
      : null}
  </>
}

/**
 * The card while an update or a rollback runs: waiting for chats with Cancel, or switching and reconnecting.
 * @param props - the state, whether this page began a switch, whether the Host is out of reach, and Cancel.
 * @returns the card, or nothing.
 */
function ProgressCard({ state, switching, reconnecting, t, cancel }: {
  readonly state: UpdateStateView
  readonly switching: boolean
  readonly reconnecting: boolean
  readonly t: T
  readonly cancel: () => Promise<unknown>
}) {
  const [busy, setBusy] = useState(false)
  const progress = state.progress
  const use = controlUse(state, 'update-cancel', t)
  if (progress.kind === 'applying' || progress.kind === 'rolling-back') {
    const waiting = progress.phase === 'waiting'
    const text = waiting
      ? progress.runningChats === 0 ? t('progress.waiting.zero') : t(pluralKey('progress.waiting', progress.runningChats), { count: progress.runningChats })
      : t(progress.kind === 'applying' ? 'progress.switching' : 'progress.rollback.switching', { version: progress.target })
    return <div className={`${css.card} ${css.warn}`} role="status" data-update-progress={progress.phase}>
      <div className={css.cardRow}>
        <div className={css.main}>
          <p className={css.title}><StateDot state="ongoing" />{text}</p>
        </div>
        {waiting ? <div className={css.actions}>
          <Button variant="outline" size="sm" disabled={busy || use.disabled} title={use.title} onClick={() => { setBusy(true); void cancel().finally(() => { setBusy(false) }) }}>{t('progress.cancel')}</Button>
        </div> : null}
      </div>
    </div>
  }
  if (reconnecting || (switching && progress.kind === 'idle' && state.result === undefined)) {
    return <div className={`${css.card} ${css.warn}`} role="status" data-update-progress="reconnecting">
      <p className={css.title}><StateDot state="ongoing" />{t('progress.reconnecting')}</p>
    </div>
  }
  return null
}

/**
 * The criterion or reason sentence for an outcome that did not finish.
 * @param result - the record.
 * @param t - the dictionary.
 * @returns the sentence.
 */
function whyText(result: UpdateResultView, t: T): string {
  if (result.outcome === 'rolled-back') {
    const key = `criterion.${result.criterion ?? 'none'}`
    return t((key in CRITERIA ? key : 'criterion.none') as 'criterion.none')
  }
  const key = `reason.${result.reason ?? 'none'}`
  return t((key in REASONS ? key : 'reason.none') as 'reason.none')
}

/** The criterion codes the dictionary words. */
const CRITERIA: Readonly<Record<string, true>> = {
  'criterion.H1-release-verified': true, 'criterion.H2-host-ready': true, 'criterion.H3-only-named-disabled': true,
  'criterion.H4-unnamed-rows-load': true, 'criterion.H5-bundle-list-predicted': true, 'criterion.none': true,
}

/** The reason codes the dictionary words. */
const REASONS: Readonly<Record<string, true>> = {
  'reason.DRAIN_TIMEOUT': true, 'reason.CHATS_RUNNING': true, 'reason.HOST_STOP_FAILED': true, 'reason.VERIFY_FAILED': true,
  'reason.HARNESS_CHANGES_PENDING': true, 'reason.none': true,
}

/**
 * The outcome card: how the last update or rollback ended, with Show details and Dismiss.
 * @param props - the state, the record, the dictionary and Dismiss.
 * @returns the card.
 */
function OutcomeCard({ state, result, t, dismiss }: {
  readonly state: UpdateStateView
  readonly result: UpdateResultView
  readonly t: T
  readonly dismiss: () => Promise<unknown>
}) {
  const [details, setDetails] = useState(false)
  const [busy, setBusy] = useState(false)
  const use = controlUse(state, 'update-dismiss', t)
  const kind = t(`outcome.kind.${result.kind}`)
  const values = { to: result.to, from: result.from, kind, criterion: result.outcome === 'rolled-back' ? whyText(result, t) : '', reason: whyText(result, t) }
  const good = result.outcome === 'committed'
  const [title, body] = result.outcome === 'committed' || result.outcome === 'rolled-back'
    ? [t(`outcome.${result.kind}.${result.outcome}`, values), t(`outcome.${result.kind}.${result.outcome}.body`, values)] as const
    : [t(`outcome.${result.outcome}`, values), t(`outcome.${result.outcome}.body`, values)] as const
  return <div className={`${css.card} ${good ? '' : css.bad}`} role={good ? 'status' : 'alert'} data-update-outcome={result.outcome} data-update-kind={result.kind}>
    <div className={css.cardRow}>
      <div className={css.main}>
        <p className={css.title}><StateDot state={good ? 'done' : 'error'} />{title}</p>
        <p className={css.body}>{body}</p>
      </div>
      <div className={css.actions}>
        <Button variant="outline" size="sm" aria-expanded={details} onClick={() => { setDetails(value => !value) }}>{t(details ? 'outcome.details.hide' : 'outcome.details')}</Button>
        <Button variant="outline" size="sm" disabled={busy || use.disabled} title={use.title} onClick={() => { setBusy(true); void dismiss().finally(() => { setBusy(false) }) }}>{t('outcome.dismiss')}</Button>
      </div>
    </div>
    {details ? <div data-update-details>
      {result.reason === undefined ? null : <p className={css.meta}>{t('outcome.details.reason', { reason: result.reason })}</p>}
      {result.criterion === undefined ? null : <p className={css.meta}>{t('outcome.details.criterion', { criterion: result.criterion })}</p>}
      <p className={css.meta}>{t('outcome.details.at', { at: result.at })}</p>
    </div> : null}
  </div>
}
