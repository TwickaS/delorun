/**
 * The snooze dialog: the menu's presets as quick picks, then a date and time
 * or a duration, with when the chat comes back shown before it is snoozed.
 * Ported from T3 Code's `CustomSnoozeDialog` (MIT, © 2026 T3 Tools Inc.) onto
 * the studio's primitives.
 */
import { useState, useSyncExternalStore } from 'react'
import { Button, Input, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { HostObservable, InjectFace, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { ChoiceGroup } from '@delorun/settings-controls'
import type { ChatStateRequest } from '../wire.ts'
import { localSnoozeDate, localSnoozeTime, resolveCustomSnooze, type CustomSnoozeInput, type SnoozePresetSetting } from '../snooze.ts'
import { snoozeOptions, snoozeWhenText } from './snooze-text.ts'
import css from './CustomSnooze.module.css'

/** What the dialog reads and does. */
export interface CustomSnoozeInjected {
  /** The chat the dialog snoozes, or null while it is closed. */
  readonly custom: HostObservable<SessionId | null>
  /** Close the dialog. */
  readonly closeCustom: () => void
  /** Ask for a change. */
  readonly change: (request: ChatStateRequest) => void
  /** The studio's language, for dates and times. */
  readonly locale: () => string
  /** The clock. */
  readonly now: () => number
  /** The person's snooze presets, the dialog's quick picks. */
  readonly presets: () => readonly SnoozePresetSetting[]
}

/** The dialog's props. */
export type CustomSnoozeProps = PropsLocale<'delorunChatStates'> & InjectFace<CustomSnoozeInjected>

type Unit = Extract<CustomSnoozeInput, { mode: 'duration' }>['unit']

/** The units a duration can be entered in. */
const UNITS: readonly Unit[] = ['minutes', 'hours', 'days']

/** The hour after opening, where the date and time fields start. */
const STARTING_OFFSET_MS = 60 * 60_000

/**
 * The dialog, shown while a chat waits for a custom snooze.
 * @param props - what the dialog reads and does, and its copy.
 * @returns the dialog, or nothing while it is closed.
 */
export function CustomSnoozeDialog(props: CustomSnoozeProps) {
  const session = useSyncExternalStore(listener => props.custom.subscribe(listener), () => props.custom.getSnapshot())
  // Keyed by the chat, so each opening starts from fresh fields.
  return session === null ? null : <CustomSnoozeForm key={session} session={session} {...props} />
}

function CustomSnoozeForm({ session, closeCustom, change, locale, now, presets, t }: CustomSnoozeProps & { readonly session: SessionId }) {
  const [opened] = useState(() => new Date(now()))
  const [initial] = useState(() => new Date(opened.getTime() + STARTING_OFFSET_MS))
  const [mode, setMode] = useState<CustomSnoozeInput['mode']>('date')
  const [date, setDate] = useState(localSnoozeDate(initial))
  const [time, setTime] = useState(localSnoozeTime(initial))
  const [amount, setAmount] = useState('2')
  const [unit, setUnit] = useState<Unit>('hours')
  const [error, setError] = useState<string | null>(null)
  const language = locale()
  const { options } = snoozeOptions(opened, t, language, presets())
  const input: CustomSnoozeInput = mode === 'date' ? { mode, date, time } : { mode, amount, unit }
  const until = resolveCustomSnooze(input, new Date(now()))
  const snooze = (end: number): void => {
    change({ action: 'snooze', session, until: end })
    closeCustom()
  }
  const submit = (): void => {
    // The clock moves while the dialog is open, so the end is resolved again at the submit.
    const end = resolveCustomSnooze(input, new Date(now()))
    if (end === null) {
      setError(t(mode === 'date' ? 'custom.invalid.date' : 'custom.invalid.duration'))
      return
    }
    snooze(end)
  }
  const edit = <T,>(set: (value: T) => void) => (value: T): void => {
    set(value)
    setError(null)
  }
  return (
    <Modal
      open
      onClose={closeCustom}
      closeLabel={t('custom.close')}
      title={t('custom.title')}
      description={t('custom.lead')}
      footer={(
        <>
          <Button variant="outline" onClick={closeCustom}>{t('custom.cancel')}</Button>
          <Button variant="primary" onClick={submit}>{t('custom.submit')}</Button>
        </>
      )}
    >
      <form className={css.form} onSubmit={(event) => { event.preventDefault(); submit() }}>
        <section className={css.group} aria-label={t('custom.quick')}>
          <span className={css.heading}>{t('custom.quick')}</span>
          <div className={css.quick}>
            {options.map(option => (
              <button key={option.id} type="button" className={css.chip} onClick={() => { snooze(option.until) }}>
                <span className={css.chipLabel}>{option.label}</span>
                <span className={css.chipWhen}>{option.when}</span>
              </button>
            ))}
          </div>
        </section>
        <ChoiceGroup
          label={t('custom.mode')}
          value={mode}
          options={[{ value: 'date', label: t('custom.mode.date') }, { value: 'duration', label: t('custom.mode.duration') }]}
          onChange={edit(setMode)}
          disabled={false}
        />
        <div className={css.fields}>
          {mode === 'date'
            ? (
              <>
                <label className={css.field}>
                  <span className={css.label}>{t('custom.date')}</span>
                  <Input type="date" required min={localSnoozeDate(opened)} value={date} data-modal-autofocus
                    onChange={(event) => { edit(setDate)(event.target.value) }} />
                </label>
                <label className={css.field}>
                  <span className={css.label}>{t('custom.time')}</span>
                  <Input type="time" required value={time} onChange={(event) => { edit(setTime)(event.target.value) }} />
                </label>
              </>
            )
            : (
              <>
                <label className={css.field}>
                  <span className={css.label}>{t('custom.amount')}</span>
                  <Input type="number" min={0} step="any" inputMode="decimal" required value={amount} data-modal-autofocus
                    onChange={(event) => { edit(setAmount)(event.target.value) }} />
                </label>
                <div className={css.field}>
                  <span className={css.label}>{t('custom.unit')}</span>
                  <ChoiceGroup
                    label={t('custom.unit')}
                    value={unit}
                    options={UNITS.map(value => ({ value, label: t(`custom.unit.${value}`) }))}
                    onChange={edit(setUnit)}
                    disabled={false}
                  />
                </div>
              </>
            )}
        </div>
        {error !== null
          ? <p className={css.error} role="alert">{error}</p>
          : until !== null && <p className={css.ends}>{t('custom.ends', { when: snoozeWhenText(until, new Date(now()), language, true) })}</p>}
        {/* The footer's buttons sit outside the form, so Enter in a field submits through this one. */}
        <button type="submit" hidden aria-hidden="true" tabIndex={-1} />
      </form>
    </Modal>
  )
}
