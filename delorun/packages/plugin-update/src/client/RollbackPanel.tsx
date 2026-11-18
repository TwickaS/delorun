/**
 * The Go back panel of Settings → Updates: shown while the committed update record names the release this Host runs.
 * It says what going back does to the chats (set aside, not deleted) and, when the update took no copy of them, that only
 * the settings can go back. Going back asks first and lets the person wait for running chats or stop them. The Host and
 * the home process decide who may go back and whether it can; this panel words their refusal and asks.
 */
import { useState } from 'react'
import { Button, Checkbox, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ChatChoice, RollbackBody, UpdateStateView } from '../wire.ts'
import type { Outcome, UpdateRefusal } from './controller.ts'
import css from './UpdatePanel.module.css'
import { controlUse, refusalText, type T } from './parts.tsx'

/** Props of {@link RollbackPanel}. */
export interface RollbackPanelProps {
  readonly state: UpdateStateView
  readonly t: T
  /** Go back from the committed update. */
  readonly rollback: (body: RollbackBody) => Promise<Outcome<unknown>>
}

/** Re-exported so the panel can word a refusal the same way as the dialog. */
export type { UpdateRefusal }

/**
 * Render the panel.
 * @param props - the state, the dictionary and the rollback action.
 * @returns the panel, or nothing while no committed update record names the running release.
 */
export function RollbackPanel({ state, t, rollback }: RollbackPanelProps) {
  const [asking, setAsking] = useState(false)
  const [chats, setChats] = useState<ChatChoice>('wait')
  const [working, setWorking] = useState(false)
  const [refusal, setRefusal] = useState<string | undefined>()
  if (!state.rollback.available || state.rollback.to === undefined) return null
  const { to } = state.rollback
  const settingsOnly = state.rollback.dataCopyMissing === true
  const use = controlUse(state, 'update-rollback', t)
  const idle = state.progress.kind === 'idle'
  const go = (): void => {
    setWorking(true)
    setRefusal(undefined)
    void rollback({ chats, profileOnly: settingsOnly }).then((outcome) => {
      if (outcome.ok) setAsking(false)
      else setRefusal(refusalText(outcome.refusal, t))
    }).finally(() => { setWorking(false) })
  }
  return <div className={css.card} data-rollback-panel>
    <div className={css.cardRow}>
      <div className={css.main}>
        <p className={css.title}>{t('rollback.title', { version: to })}</p>
        <p className={css.meta}>{t('rollback.body', { running: state.release.delorun, version: to })}</p>
        {settingsOnly ? <p className={css.meta} data-rollback-no-copy>{t('rollback.noCopy')}</p> : null}
        {refusal === undefined || asking ? null : <p className={css.meta} role="alert">{refusal}</p>}
      </div>
      <div className={css.actions}>
        {use.disabled
          ? <span className={css.meta}>{t('needs.computer')}</span>
          : <Button variant="outline" size="sm" disabled={!idle || working} title={use.title} onClick={() => { setRefusal(undefined); setAsking(true) }}>
            {t(settingsOnly ? 'rollback.buttonSettings' : 'rollback.button')}
          </Button>}
      </div>
    </div>
    {asking
      ? <Modal open onClose={() => { setAsking(false) }} title={t('rollback.dialog.title', { version: to })} closeLabel={t('dialog.close')}
        footer={<>
          <Button variant="outline" data-modal-autofocus onClick={() => { setAsking(false) }}>{t('dialog.cancel')}</Button>
          <Button variant="primary" disabled={working} onClick={go}>{t(settingsOnly ? 'rollback.confirmSettings' : 'rollback.confirm')}</Button>
        </>}>
        <p className={css.body}>{t(settingsOnly ? 'rollback.dialog.bodySettings' : 'rollback.dialog.body', { version: to })}</p>
        <Checkbox checked={chats === 'stop'} onChange={(stop) => { setChats(stop ? 'stop' : 'wait') }} label={t('rollback.chats.stop')} />
        {refusal === undefined ? null : <p className={css.meta} role="alert">{refusal}</p>}
      </Modal>
      : null}
  </div>
}
