/** The General row of Delo's release check: its switch asks before it turns on and writes off at once. */
import type { ReactNode } from 'react'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { ConfigFormSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { OptInMutation, OptInSettings } from './opt-in.ts'
import { OptInRow } from './OptInRow.tsx'

/** The release check's form and write state, and its writer. */
export interface UpdateCheckRowInjected {
  hooks: {
    updateCheck: ObservableSnapshot<ConfigFormSnapshot<OptInSettings>>
    updateCheckMutation: ObservableSnapshot<OptInMutation>
  }
  /**
   * Write the release check's `enabled` field.
   * @param enabled - the value to write.
   * @returns after the write settles.
   */
  setEnabled(enabled: boolean): Promise<void>
}

/** General-row props plus the injected face. */
export type UpdateCheckRowProps = PropsRuntime<'settings.general.item'> & PropsLocale<'deloPrivacy'> & InjectFace<UpdateCheckRowInjected>

/**
 * Render the release check's switch; a profile that does not serve the check's row says so instead.
 * @param props - the copy, the form and write state, and the writer.
 * @returns the row.
 */
export function UpdateCheckRow({ t, useUpdateCheck, useUpdateCheckMutation, setEnabled }: UpdateCheckRowProps): ReactNode {
  const form = useUpdateCheck(value => value)
  const mutation = useUpdateCheckMutation(value => value)
  return <OptInRow id="updateCheck" t={t} form={form} mutation={mutation} unavailable="updateCheck.unavailable" setEnabled={setEnabled} />
}
