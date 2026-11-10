/**
 * The General row that brings Delo's look back: the one thing this plugin
 * registers while the studio additions are off, so the stock studio always
 * has a way to return.
 */
import { useCallback, useState, useSyncExternalStore } from 'react'
import { Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ConfigForm } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ThemeSettings } from '../config.ts'
import css from './LookRow.module.css'

/** What the row reads and writes. */
export interface LookRowInjected {
  /** The theme settings, stored by the host half; the row only reads whether they are writable. */
  readonly settings: ConfigForm<ThemeSettings>
  /**
   * Turn Delo's look and the Delo studio plugins on.
   * @returns whether the setting was saved.
   */
  readonly useDeloLook: () => Promise<boolean>
}

/** The props the row reads: its dictionary and its injected services. */
export type LookRowProps = PropsRuntime<'settings.general.item'> & PropsLocale<'settings.deloLook'> & InjectFace<LookRowInjected>

/**
 * Render the row. It exists only while the look is off, so its switch starts off.
 * @param props - the dictionary and the services.
 * @returns the row.
 */
export function LookRow({ t, settings, useDeloLook }: LookRowProps) {
  // A stable subscribe function: a new one per render would resubscribe on every render.
  const subscribe = useCallback((listener: () => void) => settings.subscribe(listener), [settings])
  const snapshot = useSyncExternalStore(subscribe, () => settings.getSnapshot())
  const [pending, setPending] = useState(false)
  const [failed, setFailed] = useState(false)
  const turnOn = (): void => {
    setPending(true)
    setFailed(false)
    void useDeloLook().then((ok) => { if (!ok) setFailed(true) }, () => { setFailed(true) }).finally(() => { setPending(false) })
  }
  return (
    <div className={css.row}>
      <div className={css.text}>
        <div className={css.title}>{t('title')}</div>
        <div className={css.description}>{t('description')}</div>
        {failed && <div className={css.failure} role="alert">{t('saveFailed')}</div>}
      </div>
      <Switch checked={false} disabled={pending || !snapshot.writable} label={t('title')} onChange={turnOn} />
    </div>
  )
}
