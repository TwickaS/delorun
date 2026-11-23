/**
 * The restart card at the top of the Changes section, from the state's `restart`. While changes to Delorun itself wait
 * for a restart, it names how many files and offers Restart now, whose dialog says what a restart interrupts; without a
 * home process to restart (Delorun not started by `delorun start`) it says they run at the next start. While Delorun
 * restarts, it says whether it waits for running chats, with Cancel restart, or is starting, when this page reconnects
 * by itself. After a failed restart Delorun keeps running as before; the card says why, names the change left out
 * with Undo, and offers Try again where waiting chats or a stop that failed ended it.
 */
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import { Alert } from '@delorun/brand/alert'
import type { ChangesStateView, HarnessEntryView } from '../wire.ts'
import css from './ChangesSection.module.css'
import { controlUse, pluralKey, type T } from './parts.tsx'

/** Props of {@link RestartCard}. */
export interface RestartCardProps {
  readonly state: ChangesStateView
  /** True from this page's Restart until a state read shows no restart under way. */
  readonly restarting: boolean
  readonly t: T
  readonly busy: boolean
  /** Open the restart dialog, with the chats a restart waits for now, or undefined when the state does not say. */
  readonly onRestart: (runningChats: number | undefined) => void
  readonly onCancel: () => void
  /** Ask to undo the change a failed restart left out. */
  readonly onUndo: (entry: HarnessEntryView) => void
}

/**
 * Render the card.
 * @param props - the state, whether this page asked a restart, whether an action runs, and the actions.
 * @returns the card, or nothing when no restart is needed, under way or failed.
 */
export function RestartCard(props: RestartCardProps) {
  const { state, restarting, t, busy } = props
  const restart = state.restart
  const use = controlUse(state, 'restart', t)
  if (restart?.kind === 'restarting' || (restarting && restart?.kind !== 'failed')) {
    const waiting = restart?.kind === 'restarting' && restart.phase === 'waiting' && restart.runningChats > 0 ? restart.runningChats : 0
    return <Alert kind="progress" role="status" data-restart="restarting" title={t('restart.restarting')}
      line={waiting === 0 ? t('restart.starting') : t(pluralKey('restart.waiting', waiting), { n: waiting })}
      secondary={waiting === 0 ? undefined : { label: t('restart.cancel'), disabled: busy || use.disabled, title: use.title, onClick: props.onCancel }} />
  }
  switch (restart?.kind) {
    case undefined: return null
    case 'failed': {
      const undo = controlUse(state, 'harness-undo', t)
      const leftOut = restart.leftOut === undefined ? undefined : state.harness.find(entry => entry.id === restart.leftOut?.id)
      const undoTarget = leftOut?.undoable === true ? leftOut : undefined
      const again = restart.reason === 'health' ? undefined : { label: t('restart.again'), disabled: busy || use.disabled, title: use.title, onClick: () => { props.onRestart(undefined) } }
      const undoOffer = undoTarget === undefined ? undefined : { label: t('restart.failed.undo'), disabled: busy || undo.disabled, title: undo.title, onClick: () => { props.onUndo(undoTarget) } }
      return <Alert kind="error" role="alert" data-restart="failed" data-restart-reason={restart.reason} title={t(`restart.failed.${restart.reason}`)}
        line={<>
          {t('restart.failed.kept', { failure: restart.failure })}
          {restart.leftOut === undefined ? null : <span className={css.restartExtra}>{t('restart.failed.leftOut', { file: restart.leftOut.file })}</span>}
        </>}
        primary={again ?? undoOffer} secondary={again === undefined ? undefined : undoOffer} />
    }
    case 'needed': return <Alert kind="info" role="note" data-restart="needed" title={t(pluralKey('restart.needed', restart.changes), { n: restart.changes })}
      line={restart.available ? t('restart.body') : t('restart.unavailable')}
      primary={restart.available ? { label: t('restart.now'), disabled: busy || use.disabled, title: use.title, onClick: () => { props.onRestart(restart.runningChats) } } : undefined} />
  }
}

/**
 * The confirmation before a restart: what it does, and the running chats it waits for or stops.
 * @param props - how many chats run (undefined when the state does not say), whether an action runs, and the answers.
 * @returns the dialog.
 */
export function RestartDialog({ runningChats, t, busy, onClose, onRestart }: {
  readonly runningChats: number | undefined
  readonly t: T
  readonly busy: boolean
  readonly onClose: () => void
  readonly onRestart: (stopChats: boolean) => void
}) {
  return <Modal open onClose={onClose} title={t('restart.title')} closeLabel={t('confirm.close')} className={String(css.restartDialog)}
    footer={<>
      <Button variant="outline" data-modal-autofocus onClick={onClose}>{t('confirm.cancel')}</Button>
      {runningChats === 0 ? null : <Button variant="outline" className={css.danger} disabled={busy} onClick={() => { onRestart(true) }}>{t('restart.stopChats')}</Button>}
      <Button variant="primary" disabled={busy} onClick={() => { onRestart(false) }}>{t(runningChats === 0 ? 'restart.confirm' : 'restart.wait')}</Button>
    </>}>
    <p className={css.confirmText}>{t('restart.dialogBody')}</p>
    <p className={css.confirmText}>{runningChats === undefined ? t('restart.chats.unknown') : runningChats === 0 ? t('restart.chats.none') : t(pluralKey('restart.chats', runningChats), { n: runningChats })}</p>
  </Modal>
}
