/** The plugin downloads settings section: the npm mirror switch, which sits beside the plugin inventory in Settings, Plugins. */
import type { ReactNode } from 'react'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { ConfigFormSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { OptInMutation, OptInSettings } from './opt-in.ts'
import { OptInRow } from './OptInRow.tsx'
import { SettingsCard } from '@delorun/settings-controls'
import css from './SettingsSection.module.css'

/** The npm mirror's form and write state, and its writer. */
export interface PluginInstallsSectionInjected {
  hooks: {
    npmMirror: ObservableSnapshot<ConfigFormSnapshot<OptInSettings>>
    npmMirrorMutation: ObservableSnapshot<OptInMutation>
  }
  /**
   * Write the plugin install check's `npmMirror` field.
   * @param enabled - the value to write.
   * @returns after the write settles.
   */
  setEnabled(enabled: boolean): Promise<void>
}

/** Props the renderer binds for the section. */
export type PluginInstallsSectionProps = PropsRuntime<'settings.section'> & PropsLocale<'delorunPrivacy'> & InjectFace<PluginInstallsSectionInjected>

/**
 * Render the npm mirror switch under its heading, asking for consent before it turns on. A profile that does not load
 * the plugin install check, which holds the setting, shows nothing.
 * @param props - localized copy, the mirror's form and write state, and the writer.
 * @returns the section, or nothing while the install check's row is absent.
 */
export function PluginInstallsSection({ t, useNpmMirror, useNpmMirrorMutation, setEnabled }: PluginInstallsSectionProps): ReactNode {
  const form = useNpmMirror(value => value)
  const mutation = useNpmMirrorMutation(value => value)
  if (form.status === 'unavailable') return null
  return <div className={css.section}>
    <SettingsCard title={t('installs.heading')}>
      <OptInRow id="npmMirror" t={t} form={form} mutation={mutation} setEnabled={setEnabled} />
    </SettingsCard>
  </div>
}
