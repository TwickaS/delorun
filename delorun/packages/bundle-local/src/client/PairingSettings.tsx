/**
 * The pairing part of Settings → Devices: the devices asking to connect without an approval window, each with Enter code
 * and Decline, and the home's pairing choices. The choices are written to the `pairing` section of the home-auth row
 * through its Host form and change only at the home's own computer; on a remote studio the part says so and shows no
 * control. The values shown are the ones the Host accepted, else the ones the home runs with.
 */
import { useState } from 'react'
import type { ReactNode } from 'react'
import { Input } from '@deepseek-ai/dsh-client-ui-primitives'
import { Button } from '@delorun/brand'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { ConfigFormSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'
import { ChoiceGroup, RadioList, SettingRow, SettingsCard } from '@delorun/settings-controls'
import { PAIRING_BOUNDS, WINDOWLESS_MODES, type PairingConfig, type PairingView, type RequestDisplay } from '@delorun/home-auth/wire'
import type { ApprovalRequestId, PendingDevice } from './devices-api.ts'
import type { OptInMutation } from './opt-in.ts'
import type { PairingRowSettings } from './pairing-writer.ts'
import type { PairingState } from './pairing-source.ts'
import { userOf } from './PairingNotice.tsx'
import css from './DevicesSection.module.css'

type Translate = PropsLocale<'delorunDevices'>['t']

/** The numeric choices, in screen order, with their copy prefixes. */
const NUMBER_CHOICES = [
  { field: 'windowMinutes', copy: 'pairing.window' },
  { field: 'requestExpiryMinutes', copy: 'pairing.expiry' },
  { field: 'pendingPerIdentity', copy: 'pairing.per' },
] as const

/** The ways a request can show, in screen order: the default first. */
const DISPLAY_CHOICES: readonly RequestDisplay[] = ['dialog', 'notice', 'none']

/** What the part is given. */
export interface PairingSettingsProps {
  readonly t: Translate
  readonly time: (at: number) => string
  readonly state: PairingState
  readonly form: ConfigFormSnapshot<PairingRowSettings>
  readonly mutation: OptInMutation
  /** Write one field of the `pairing` section. */
  readonly set: <K extends keyof PairingConfig>(field: K, value: NonNullable<PairingConfig[K]>) => Promise<void>
  readonly openCode: (id: ApprovalRequestId) => void
  readonly decline: (id: ApprovalRequestId) => Promise<unknown>
}

/**
 * Render the waiting requests and the choices.
 * @param props - the copy, the home's pairing state, the row's form and write state, and the actions.
 * @returns the cards, a sentence on a remote studio, or nothing before the first read.
 */
export function PairingSettings({ t, time, state, form, mutation, set, openCode, decline }: PairingSettingsProps): ReactNode {
  if (state.place === 'unknown') return null
  if (state.place === 'remote') return <p className={css.line} role="status" data-pairing="remote">{t('pairing.computerOnly')}</p>
  const { view } = state
  if (view === undefined) return null
  const saved = form.value?.pairing
  const shown: PairingView = { ...view, ...Object.fromEntries(Object.entries(saved ?? {}).filter(([, value]) => value !== undefined)) }
  const disabled = mutation.busy || form.status !== 'ready' || !form.writable
  return <div data-pairing="computer">
    {state.requests.length === 0 ? null : <WaitingRequests t={t} time={time} requests={state.requests} openCode={openCode} decline={decline} />}
    <SettingsCard title={t('pairing.heading')} description={t('pairing.fixed')} group="pairing">
      <SettingRow title={t('pairing.may.title')} description={t('pairing.may.description')} failure={mutation.failed ? t('pairing.failed') : undefined} stacked>
        <ChoiceGroup label={t('pairing.may.title')} value={shown.mayAskWithoutWindow} disabled={disabled} fill
          options={WINDOWLESS_MODES.map(value => ({ value, label: t(`pairing.may.${value}`) }))}
          onChange={(next) => { void set('mayAskWithoutWindow', next) }} />
      </SettingRow>
      <SettingRow title={t('pairing.show.title')} description={t('pairing.show.description')} stacked>
        <RadioList label={t('pairing.show.title')} value={shown.showRequest} disabled={disabled}
          rows={DISPLAY_CHOICES.map(value => ({ value, label: t(`pairing.show.${value}`) }))}
          onChange={(next) => { void set('showRequest', next) }} />
      </SettingRow>
      {NUMBER_CHOICES.map(({ field, copy }) => <SettingRow key={field} title={t(`${copy}.title`)}
        description={t(`${copy}.description`, { min: String(PAIRING_BOUNDS[field].min), max: String(PAIRING_BOUNDS[field].max) })}>
        <NumberField label={t(`${copy}.title`)} value={shown[field]} min={PAIRING_BOUNDS[field].min} max={PAIRING_BOUNDS[field].max}
          disabled={disabled} onCommit={(next) => { void set(field, next) }} />
      </SettingRow>)}
    </SettingsCard>
  </div>
}

/**
 * A whole-number field written once it loses focus or Enter is pressed, and only within its bounds; any other entry
 * goes back to the saved value.
 * @param props - the accessible name, the saved value, the bounds, whether it refuses input and the write.
 * @returns the field.
 */
function NumberField({ label, value, min, max, disabled, onCommit }: {
  readonly label: string
  readonly value: number
  readonly min: number
  readonly max: number
  readonly disabled: boolean
  readonly onCommit: (next: number) => void
}): ReactNode {
  const [draft, setDraft] = useState<string | undefined>()
  const commit = (): void => {
    const next = Number(draft)
    setDraft(undefined)
    if (draft !== undefined && Number.isInteger(next) && next >= min && next <= max && next !== value) onCommit(next)
  }
  return <Input type="number" inputMode="numeric" aria-label={label} disabled={disabled} min={min} max={max} step={1}
    className={css.number as string} value={draft ?? String(value)} onChange={(event) => { setDraft(event.currentTarget.value) }} onBlur={commit}
    onKeyDown={(event) => { if (event.key === 'Enter') commit() }} />
}

/**
 * The devices asking to connect without an approval window.
 * @param props - the copy, the requests and the actions.
 * @returns the card.
 */
function WaitingRequests({ t, time, requests, openCode, decline }: Pick<PairingSettingsProps, 't' | 'time' | 'openCode' | 'decline'> & { readonly requests: readonly PendingDevice[] }): ReactNode {
  return <SettingsCard title={t('pairing.waiting.title')} group="pairing-waiting">
    <ul className={css.list}>
      {requests.map(request => <li key={request.requestId} className={css.row} data-request-id={request.requestId}>
        <div className={css.details}>
          <div className={css.title}>{request.label}</div>
          <div className={css.description}>{t('pairing.waiting.from', { user: userOf(t, request), platform: request.platform, time: time(request.createdAt) })}</div>
        </div>
        <span className={css.approve}>
          <Button variant="primary" size="sm" onClick={() => { openCode(request.requestId) }}>{t('pairing.waiting.enter')}</Button>
          <Button variant="ghost" size="sm" onClick={() => { void decline(request.requestId) }}>{t('pairing.waiting.decline')}</Button>
        </span>
      </li>)}
    </ul>
  </SettingsCard>
}
