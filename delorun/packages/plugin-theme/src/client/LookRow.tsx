/**
 * The General row that brings Delorun's look back: the one thing this plugin
 * registers while the studio additions are off, so the stock studio always
 * has a way to return.
 */
import { useState } from 'react'
import { Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ConfigForm } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ThemeSettings } from '../config.ts'
import { useFormWrites } from './form-writes.ts'
import { SettingRow } from '@delorun/settings-controls'

/** What the row reads and writes. */
export interface LookRowInjected {
  /** The theme settings, stored by the host half; the row only reads whether they are writable. */
  readonly settings: ConfigForm<ThemeSettings>
  /**
   * Turn Delorun's look and the Delorun studio plugins on.
   * @returns whether the setting was saved.
   */
  readonly useDelorunLook: () => Promise<boolean>
}

/** The props the row reads: its dictionary and its injected services. */
export type LookRowProps = PropsRuntime<'settings.general.item'> & PropsLocale<'settings.delorunLook'> & InjectFace<LookRowInjected>

/**
 * Render the row. It exists only while the look is off, so its switch starts off.
 * @param props - the dictionary and the services.
 * @returns the row.
 */
export function LookRow({ t, settings, useDelorunLook }: LookRowProps) {
  const { disabled, failed, track } = useFormWrites(settings)
  const [pending, setPending] = useState(false)
  const turnOn = (): void => {
    setPending(true)
    const write = useDelorunLook()
    track(write)
    const settle = (): void => { setPending(false) }
    void write.then(settle, settle)
  }
  return (
    <SettingRow title={t('title')} description={t('description')} failure={failed ? t('saveFailed') : undefined}>
      <Switch checked={false} disabled={pending || disabled} label={t('title')} onChange={turnOn} />
    </SettingRow>
  )
}
