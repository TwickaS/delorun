/**
 * Settings → Face ID → "Ask again after" (A499): how long one Face ID on a phone lets strong actions go without asking
 * again: Every time, 5, 15, 30 or 60 minutes. At the computer a choice saves at once; on a phone it takes Face ID itself
 * each time (an always-ask action), and a phone with no Face ID set up does not show the row, since no pass opens on it.
 */
import { useState } from 'react'
import type { ReactNode } from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { FaceGrant } from '@delorun/plugin-changes/face-grant'
import { GRANT_HEADER } from './face-id-api.ts'
import { PASS_CHANGED, PASS_ROUTES, PASS_SETTING_ACTION, type PassState } from './face-id-pass.ts'
import { call, fields, type HostFetch } from './host-api.ts'
import css from './FacePassSetting.module.css'

/** Props of the row. */
export interface FacePassSettingProps {
  readonly t: PropsLocale<'delorunFaceId'>['t']
  readonly fetch: HostFetch
  /** The pass setting and its choices. */
  readonly pass: PassState
  /** Whether the page is on the home's own computer. */
  readonly atComputer: boolean
  /** The confirmation a phone's change takes. */
  readonly grant: FaceGrant
}

/**
 * Save one choice: at the computer directly, on a phone with a grant for exactly the body sent.
 * @param fetch - the request function.
 * @param grant - the confirmation.
 * @param minutes - the new length.
 * @param atComputer - whether the page is the computer's.
 * @returns whether it was saved; false when the person cancelled the sheet.
 */
export async function savePassMinutes(fetch: HostFetch, grant: FaceGrant, minutes: number, atComputer: boolean): Promise<boolean> {
  const body = { minutes }
  let headers: Record<string, string> | undefined
  if (!atComputer) {
    const grantId = await grant({ action: PASS_SETTING_ACTION, call: { args: body } })
    if (grantId === undefined) return false
    headers = { [GRANT_HEADER]: grantId }
  }
  await call<object>(fetch, PASS_ROUTES.pass, fields({}), body, headers === undefined ? undefined : { headers })
  globalThis.window?.dispatchEvent(new Event(PASS_CHANGED))
  return true
}

/**
 * Render the row.
 * @param props - see {@link FacePassSettingProps}.
 * @returns the row.
 */
export function FacePassSetting({ t, fetch, pass, atComputer, grant }: FacePassSettingProps): ReactNode {
  const [chosen, setChosen] = useState<number | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const current = chosen ?? pass.minutes
  const choose = (minutes: number): void => {
    if (busy || minutes === current) return
    setBusy(true)
    setFailed(false)
    void savePassMinutes(fetch, grant, minutes, atComputer).then((saved) => { if (saved) setChosen(minutes) }, () => { setFailed(true) }).finally(() => { setBusy(false) })
  }
  return (
    <div className={css.row} data-delorun-face-pass-setting="">
      <div className={css.label} id="delorun-face-pass-setting">{t('pass.setting')}</div>
      <div className={css.choices} role="radiogroup" aria-labelledby="delorun-face-pass-setting">
        {pass.choices.map(minutes => (
          <button key={minutes} type="button" role="radio" aria-checked={minutes === current} disabled={busy} className={css.choice} data-minutes={minutes}
            onClick={() => { choose(minutes) }}>
            {minutes === 0 ? t('pass.everyTime') : t('pass.minutes', { minutes: String(minutes) })}
          </button>
        ))}
      </div>
      <p className={css.help}>{t('pass.settingHelp')}</p>
      {failed ? <p className={css.failed} role="alert">{t('pass.saveFailed')}</p> : null}
    </div>
  )
}
