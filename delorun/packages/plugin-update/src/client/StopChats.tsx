/**
 * "Stop running chats and update": the menu on the update alert, the confirm step that names each chat that will stop
 * (Cancel is the default; the red button is the destructive one), and the per-chat line under the composer for a chat the
 * update stopped. The stop itself is the controller's `stopChats`, a strong action the Host decides.
 */
import { useId, useState } from 'react'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import { canContinueByHand, type RunningChatView, type StoppedChatsView } from '../wire.ts'
import css from './UpdatePanel.module.css'
import { pluralKey, refusalText, type T } from './parts.tsx'
import type { Outcome } from './controller.ts'

/** What the stop needs. */
export interface StopChatsOffer {
  /** The chats that will stop. */
  readonly chats: readonly RunningChatView[]
  /** The background jobs that stop too; none continue. */
  readonly jobs: number
  /** Whether the stopped chats continue by themselves after the update. */
  readonly automatic: boolean
  /**
   * Stop the chats.
   * @returns the outcome, with the Host's refusal on failure.
   */
  readonly run: () => Promise<Outcome<unknown>>
}

/**
 * The ⋯ button of the update alert and its one item.
 * @param props - the offer and the dictionary.
 * @returns the button, its menu and the confirm step.
 */
export function StopChatsMenu({ offer, t }: { readonly offer: StopChatsOffer, readonly t: T }) {
  const [open, setOpen] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const menuId = useId()
  return <>
    <button type="button" className={css.alertMenuButton} aria-haspopup="true" aria-expanded={open} aria-controls={menuId} aria-label={t('stop.menu')} onClick={() => { setOpen(value => !value) }}>⋯</button>
    {open ? <div id={menuId} className={css.alertMenu} role="group">
      <button type="button" className={css.alertMenuItem} onClick={() => { setOpen(false); setConfirming(true) }}>{t('stop.item')}</button>
    </div> : null}
    {confirming ? <StopChatsConfirm offer={offer} t={t} onClose={() => { setConfirming(false) }} /> : null}
  </>
}

/**
 * The confirm step.
 * @param props - the offer, the dictionary and the closer.
 * @returns the dialog.
 */
function StopChatsConfirm({ offer, t, onClose }: { readonly offer: StopChatsOffer, readonly t: T, readonly onClose: () => void }) {
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | undefined>()
  const stop = (): void => {
    setBusy(true)
    setFailure(undefined)
    void offer.run().then((outcome) => {
      setBusy(false)
      if (outcome.ok) onClose()
      else setFailure(refusalText(outcome.refusal, t))
    })
  }
  return <Modal open onClose={onClose} title={t('stop.title')} closeLabel={t('stop.cancel')}
    footer={<>
      <Button variant="outline" data-modal-autofocus onClick={onClose}>{t('stop.cancel')}</Button>
      <Button variant="outline" className={css.danger} disabled={busy} onClick={stop}>{t('stop.confirm')}</Button>
    </>}>
    <div className={css.dialogBody} data-stop-chats-confirm>
      {offer.chats.length === 0 && offer.jobs === 0
        ? <p className={css.body}>{t('stop.none')}</p>
        : <>
          <p className={css.body}>{t('stop.lead')}</p>
          <ul className={css.highlights}>{offer.chats.map(chat => <li key={chat.sessionId}>{chat.title === '' ? t('stop.untitled') : chat.title}</li>)}</ul>
        </>}
      {offer.jobs === 0 ? null : <p className={css.body}>{t(pluralKey('stop.jobs', offer.jobs), { count: offer.jobs })}</p>}
      <p className={css.body}>{t(offer.automatic ? 'stop.after.automatic' : 'stop.after.manual')}</p>
      {failure === undefined ? null : <p className={css.body} role="alert">{failure}</p>}
    </div>
  </Modal>
}

/**
 * The line under a chat's composer after the update stopped it.
 * @param props - the stopped chats, this chat, the dictionary and the Continue action.
 * @returns the line, or nothing when the update did not stop this chat.
 */
export function StoppedChatLine({ stopped, sessionId, t, onContinue }: {
  readonly stopped: StoppedChatsView | undefined
  readonly sessionId: string
  readonly t: T
  readonly onContinue: (sessionId: string) => Promise<unknown>
}) {
  const [busy, setBusy] = useState(false)
  const chat = stopped?.chats.find(each => each.sessionId === sessionId)
  if (chat === undefined) return null
  const text = chat.state === 'continued' ? t('stopped.continuing')
    : chat.state === 'stopped' ? t('stopped.line')
      : t('stopped.skipped')
  return <div className={css.stoppedLine} role="status" data-update-stopped={chat.state}>
    <span>{text}</span>
    {canContinueByHand(stopped?.automatic === true, chat.state)
      ? <Button variant="outline" size="sm" className={css.alertButton} disabled={busy} onClick={() => { setBusy(true); void onContinue(sessionId).finally(() => { setBusy(false) }) }}>{t('stopped.continue')}</Button>
      : null}
  </div>
}
