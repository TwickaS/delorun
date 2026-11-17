/**
 * Changes to Delorun itself in the Changes section: Make my copy while the person has none; the changes waiting in the
 * copy with Review and Discard, whose review applies exactly the content it showed; the decided changes with Undo and
 * when each takes effect; and the terminal command that goes back to the installed release, which stays a terminal step.
 * A Host that cannot change Delorun's own files (one not run from an installed release by `delorun start`) lists the
 * decided changes and says so. The dialogs review a waiting change (Discard, Apply) and a decided one (Undo).
 */
import { Button, CommandText, Modal, relativeTime, StateDot, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ChangesStateView, HarnessCopyView, HarnessEntryView, HarnessPendingView, PendingListView, ShownView } from '../wire.ts'
import { ChangeDetail } from './ChangeDetail.tsx'
import type { HarnessEffects } from './controller.ts'
import css from './ChangesSection.module.css'
import { controlUse, Group, LoadLine, SHORT_VERSION, useLoaded, WIDE_DIALOG, type Loaded, type T } from './parts.tsx'

/** The command that takes Delorun back to the installed release; it also works when Delorun does not start. */
export const RELEASE_COMMAND = 'delorun changes edit-harness --discard'

/** Props of {@link SelfGroup}. */
export interface SelfGroupProps {
  readonly state: ChangesStateView
  readonly t: T
  readonly busy: boolean
  /** The read of the copy's waiting changes; undefined while the person has no copy or the Host cannot read one. */
  readonly pending: Loaded<PendingListView> | undefined
  readonly effects: HarnessEffects
  /** The copy Make my copy made or found on this page. */
  readonly copy: HarnessCopyView | undefined
  readonly onMakeCopy: () => void
  readonly onReview: (change: HarnessPendingView) => void
  readonly onDiscard: (change: HarnessPendingView) => void
  readonly onShow: (entry: HarnessEntryView) => void
  readonly onUndo: (entry: HarnessEntryView) => void
  readonly onReadAgain: () => void
}

/**
 * Render the group.
 * @param props - the state, the read of the copy, and the actions.
 * @returns the group.
 */
export function SelfGroup(props: SelfGroupProps) {
  const { state, t, busy, pending } = props
  const available = state.harnessAvailable.kind === 'available' ? state.harnessAvailable : undefined
  const waiting = pending?.status === 'ready' ? pending.value.harness : []
  const problem = pending?.status === 'ready' ? pending.value.harnessProblem : undefined
  const makeCopy = controlUse(state, 'make-copy', t)
  const discard = controlUse(state, 'harness-discard', t)
  return <Group heading={t('self.heading')} lead={<p className={css.lead}>{t(available === undefined ? 'self.unavailable' : 'self.intro')}</p>}>
    {available === undefined || available.copy ? null : <li className={css.row} data-self-copy="none">
      <div className={css.main}>
        <p className={css.text}>{t('self.copy.none')}</p>
      </div>
      <div className={css.actions}>
        <Button variant="primary" size="sm" disabled={busy || makeCopy.disabled} title={makeCopy.title} onClick={props.onMakeCopy}>{t('self.copy.make')}</Button>
      </div>
    </li>}
    {props.copy === undefined ? null : <li className={css.row} data-self-copy={props.copy.created ? 'made' : 'found'} role="status">
      <div className={css.main}>
        <p className={css.text}>{t(props.copy.created ? 'self.copy.made' : 'self.copy.found', { version: props.copy.runtime })}</p>
        <CommandText className={css.command} label={t('self.copy.place')} text={props.copy.place} />
        <p className={css.meta}>{t('self.copy.next')}</p>
      </div>
    </li>}
    {pending?.status === 'loading' ? <li className={css.empty} role="status">{t('self.reading')}</li> : null}
    {pending?.status === 'error' || problem !== undefined
      ? <li className={css.empty}><p className={css.failureText} role="alert"><StateDot state="error" />{problem === undefined ? t('self.unread') : t('self.problem', { problem })}</p></li>
      : null}
    {waiting.map(change => <li key={change.id} className={css.row} data-change-id={change.id} data-self-state="pending">
      <div className={css.main}>
        <div className={`${css.name} ${css.path}`}>{change.file}</div>
        <div className={css.metaRow}>
          <span>{t('self.waiting')}</span>
          <span>{t(`review.file.${change.status}`)}</span>
          <span>{t('self.version', { version: change.runtime })}</span>
        </div>
      </div>
      <div className={css.actions}>
        <Button variant="outline" size="sm" disabled={busy || discard.disabled} title={discard.title} onClick={() => { props.onDiscard(change) }}>{t('review.discard')}</Button>
        <Button variant="primary" size="sm" disabled={busy} onClick={() => { props.onReview(change) }}>{t('pending.review')}</Button>
      </div>
    </li>)}
    {available?.copy === true && pending?.status === 'ready' && waiting.length === 0 && problem === undefined
      ? <li className={css.empty}>{t('self.nothingWaits')}</li>
      : null}
    <Decided {...props} />
    {available?.copy === true && pending?.status !== 'loading'
      ? <li className={css.empty}><Button variant="outline" size="sm" disabled={busy} onClick={props.onReadAgain}>{t('self.check')}</Button></li>
      : null}
    {available === undefined ? null : <li className={css.empty}>
      <p className={css.meta}>{t('self.release')}</p>
      <CommandText className={css.command} label={t('self.command')} text={RELEASE_COMMAND} />
    </li>}
  </Group>
}

/**
 * The decided changes to Delorun itself, newest first, with Review, Undo where it takes one back, who decided on a
 * paired device, and when a change this page decided takes effect.
 * @param props - the group's props.
 * @returns the rows.
 */
function Decided({ state, t, busy, effects, onShow, onUndo }: SelfGroupProps) {
  const now = Date.now()
  const undo = controlUse(state, 'harness-undo', t)
  if (state.harness.length === 0) return <li className={css.empty}>{t('self.empty')}</li>
  return <>
    {state.harness.map((entry) => {
      const at = relativeTime(Date.parse(entry.decidedAt ?? entry.createdAt), now)
      const effect = effects[entry.id]
      return <li key={entry.id} className={css.row} data-change-id={entry.id} data-self-state={entry.state}>
        <div className={css.main}>
          <div className={`${css.name} ${css.path}`}>{entry.file}</div>
          <div className={css.metaRow}>
            <span>{t(`state.${entry.state}`)}</span>
            <span>{t(`recent.at.${at.unit}`, { n: at.n })}</span>
            {entry.decidedOn === undefined ? null : <span>{t('decidedOn', { device: entry.decidedOn })}</span>}
            <span>{t('self.version', { version: entry.runtime })}</span>
          </div>
          {effect === undefined || entry.state === 'discarded' ? null : <div className={css.tags}>
            <Tag tone={effect === 'live' ? 'success' : 'warning'}>{t(`self.effect.${effect}`)}</Tag>
          </div>}
          {entry.leftOut === undefined ? null : <p className={css.failureText}><StateDot state="error" />{t('self.leftOut', { failure: entry.leftOut.failure })}</p>}
        </div>
        <div className={css.actions}>
          <Button variant="outline" size="sm" disabled={busy} onClick={() => { onShow(entry) }}>{t('pending.review')}</Button>
          {entry.undoable
            ? <Button variant="outline" size="sm" disabled={busy || undo.disabled} title={undo.title} onClick={() => { onUndo(entry) }}>{t('confirm.undo')}</Button>
            : null}
        </div>
      </li>
    })}
  </>
}

/**
 * Review a change waiting in the person's copy of Delorun: its diff and risk summary, then Discard or Apply, which
 * sends the content version this review showed.
 * @param props - the change, the read, the actions and whether they are offered.
 * @returns the dialog.
 */
export function SelfReviewDialog({ change, state, t, show, busy, onClose, onApply, onDiscard }: {
  readonly change: HarnessPendingView
  readonly state: ChangesStateView
  readonly t: T
  readonly show: (id: string) => Promise<ShownView>
  readonly busy: boolean
  readonly onClose: () => void
  readonly onApply: (to: string) => void
  readonly onDiscard: () => void
}) {
  const loaded = useLoaded(() => show(change.id))
  const shown = loaded.status === 'ready' && loaded.value.kind === 'harness-pending' ? loaded.value : undefined
  const apply = controlUse(state, 'harness-apply', t)
  const discard = controlUse(state, 'harness-discard', t)
  return <Modal open onClose={onClose} title={t('self.title', { file: change.file })} closeLabel={t('confirm.close')}
    {...WIDE_DIALOG}
    footer={<>
      <Button variant="outline" data-modal-autofocus onClick={onClose}>{t('confirm.cancel')}</Button>
      <Button variant="outline" className={css.danger} disabled={busy || shown === undefined || discard.disabled} title={discard.title} onClick={onDiscard}>{t('review.discard')}</Button>
      <Button variant="primary" disabled={busy || shown === undefined || apply.disabled} title={apply.title}
        onClick={() => { if (shown !== undefined) onApply(shown.change.to) }}>{t('review.apply')}</Button>
    </>}>
    <LoadLine loaded={loaded} t={t} />
    {loaded.status === 'ready' && shown === undefined ? <p className={css.meta}>{t('review.gone')}</p> : null}
    {shown === undefined ? null : <>
      <p className={css.text} data-self-to={shown.change.to}>{t('self.reviewVersion', { version: shown.change.to.slice(0, SHORT_VERSION) })}</p>
      <p className={css.meta}>{t('self.applyNote')}</p>
      <ChangeDetail change={shown.review} t={t} />
    </>}
  </Modal>
}

/**
 * Review one decided change to Delorun itself: its files, risk summary and diff, or that Delorun no longer keeps its
 * content, with Undo where it takes the change back.
 * @param props - the change, the read, Undo and Close.
 * @returns the dialog.
 */
export function SelfDialog({ entry, state, t, show, busy, onClose, onUndo }: {
  readonly entry: HarnessEntryView
  readonly state: ChangesStateView
  readonly t: T
  readonly show: (id: string) => Promise<ShownView>
  readonly busy: boolean
  readonly onClose: () => void
  readonly onUndo: () => void
}) {
  const loaded = useLoaded(() => show(entry.id))
  const shown = loaded.status === 'ready' && loaded.value.kind === 'harness' ? loaded.value : undefined
  const undo = controlUse(state, 'harness-undo', t)
  return <Modal open onClose={onClose} title={t('self.title', { file: entry.file })} closeLabel={t('confirm.close')}
    {...WIDE_DIALOG}
    footer={<>
      <Button variant="outline" data-modal-autofocus onClick={onClose}>{t('confirm.close')}</Button>
      {entry.undoable
        ? <Button variant="primary" disabled={busy || undo.disabled} title={undo.title} onClick={onUndo}>{t('confirm.undo')}</Button>
        : null}
    </>}>
    <LoadLine loaded={loaded} t={t} />
    {loaded.status !== 'ready' ? null : shown?.review === undefined ? <p className={css.meta}>{t('self.gone')}</p> : <ChangeDetail change={shown.review} t={t} />}
  </Modal>
}
