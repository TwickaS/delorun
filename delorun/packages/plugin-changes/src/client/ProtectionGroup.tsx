/**
 * The protection setting in the Changes section: a switch in both directions. Turning it on asks once and says how many
 * changes loaded without review while it was off; turning it off asks once, naming what the route says would load
 * without review. That ask guards against a misclick; it is no defence. At the computer, the notices that a paired
 * device changed the setting show above the switch until the person dismisses each.
 */
import { Button, Modal, Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ChangesStateView, ProtectionNoticeView, WillLoadView } from '../wire.ts'
import css from './ChangesSection.module.css'
import { controlUse, Group, pluralKey, type T } from './parts.tsx'
import { timeOfDay } from './time.ts'

/**
 * Render the group.
 * @param props - the state, whether an action runs, the switch's action and Dismiss.
 * @returns the group, or nothing when the setting cannot be read.
 */
export function ProtectionGroup({ state, t, busy, onTurn }: {
  readonly state: ChangesStateView
  readonly t: T
  readonly busy: boolean
  readonly onTurn: (level: 'on' | 'off') => void
}) {
  if (state.protection === undefined) return null
  const on = state.protection === 'on'
  const use = controlUse(state, on ? 'protection-off' : 'protection-on', t)
  return <Group heading={t('protection.heading')}>
    <li className={css.row} data-protection={state.protection}>
      <div className={css.main}>
        <p className={css.text}>{t(`protection.${state.protection}`)}</p>
        {on || state.unreviewedSinceOff === 0 ? null : <p className={css.meta}>{t(pluralKey('protection.loaded', state.unreviewedSinceOff), { n: state.unreviewedSinceOff })}</p>}
      </div>
      <div className={css.actions}>
        <Switch checked={on} label={t('protection.switch')} disabled={busy || use.disabled} title={use.title}
          onChange={(next) => { onTurn(next ? 'on' : 'off') }} />
      </div>
    </li>
  </Group>
}

/**
 * The notices that a paired device changed the protection setting, oldest first, each with Dismiss; only the
 * computer's state carries them.
 * @param props - the notices, whether an action runs, and Dismiss.
 * @returns the notices, or nothing.
 */
export function ProtectionNotices({ notices, t, busy, onDismiss }: {
  readonly notices: readonly ProtectionNoticeView[]
  readonly t: T
  readonly busy: boolean
  readonly onDismiss: (id: string) => void
}) {
  if (notices.length === 0) return null
  return <ul className={css.rows} aria-label={t('notice.heading')}>
    {notices.map(notice => <li key={notice.id} className={`${css.row} ${css.noticeRow}`} role="note" data-protection-notice={notice.level}>
      <div className={css.main}>
        <p className={css.text}>{t(`notice.${notice.level}`, { device: notice.device, time: timeOfDay(notice.at) })}</p>
        {notice.level === 'off' ? <p className={css.meta}>{t('notice.offBody')}</p> : null}
      </div>
      <div className={css.actions}>
        <Button variant="outline" size="sm" disabled={busy} onClick={() => { onDismiss(notice.id) }}>{t('notice.dismiss')}</Button>
      </div>
    </li>)}
  </ul>
}

/**
 * The one confirmation of turning protection on: what waits for review from then on, and how many changes loaded
 * without review while it was off.
 * @param props - the count, whether an action runs, and the two answers.
 * @returns the dialog.
 */
export function ProtectionOnDialog({ loaded, t, busy, onClose, onConfirm }: {
  readonly loaded: number
  readonly t: T
  readonly busy: boolean
  readonly onClose: () => void
  readonly onConfirm: () => void
}) {
  return <Modal open onClose={onClose} title={t('protection.on.title')} closeLabel={t('confirm.close')}
    footer={<>
      <Button variant="outline" data-modal-autofocus onClick={onClose}>{t('confirm.cancel')}</Button>
      <Button variant="primary" disabled={busy} onClick={onConfirm}>{t('protection.on.confirm')}</Button>
    </>}>
    <p className={css.confirmText}>{t('protection.on.body')}</p>
    {loaded === 0 ? null : <p className={css.confirmText}>{t(pluralKey('protection.on.loaded', loaded), { n: loaded })}</p>}
  </Modal>
}

/**
 * The one confirmation of turning protection off: what changes, and what the route says would load without review.
 * @param props - what would load, whether an action runs, and the two answers.
 * @returns the dialog.
 */
export function ProtectionOffDialog({ willLoad, t, busy, onClose, onConfirm }: {
  readonly willLoad: WillLoadView
  readonly t: T
  readonly busy: boolean
  readonly onClose: () => void
  readonly onConfirm: () => void
}) {
  const nothing = willLoad.plugins.length === 0 && willLoad.harnessFiles === 0
  return <Modal open onClose={onClose} title={t('protection.off.title')} closeLabel={t('confirm.close')}
    footer={<>
      <Button variant="outline" data-modal-autofocus onClick={onClose}>{t('confirm.cancel')}</Button>
      <Button variant="outline" className={css.danger} disabled={busy} onClick={onConfirm}>{t('protection.off.confirm')}</Button>
    </>}>
    <p className={css.confirmText}>{t('protection.off.body')}</p>
    {nothing
      ? <p className={css.confirmText}>{t('protection.off.nothing')}</p>
      : <>
        <p className={css.confirmText}>{t('protection.off.willLoad')}</p>
        <ul className={css.plainList} data-will-load>
          {willLoad.plugins.map(plugin => <li key={plugin}>{plugin}</li>)}
          {willLoad.harnessFiles === 0 ? null : <li>{t(pluralKey('protection.off.files', willLoad.harnessFiles), { n: willLoad.harnessFiles })}</li>}
        </ul>
      </>}
  </Modal>
}
