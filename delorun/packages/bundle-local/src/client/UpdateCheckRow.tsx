/** The General row of Delorun's release check: its switch asks before it turns on and writes off at once. */
import { useEffect, useState, type ReactNode } from 'react'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { ConfigFormSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { OptInMutation, OptInSettings } from './opt-in.ts'
import { UPDATE_CHANNEL_PATH, type UpdateChannelResponse } from '@delorun/contract-update-report'
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
export type UpdateCheckRowProps = PropsRuntime<'settings.general.item'> & PropsLocale<'delorunPrivacy'> & InjectFace<UpdateCheckRowInjected>

/**
 * Render the release check's switch; a profile that does not serve the check's row says so instead.
 * @param props - the copy, the form and write state, and the writer.
 * @returns the row.
 */
export function UpdateCheckRow({ t, useUpdateCheck, useUpdateCheckMutation, setEnabled }: UpdateCheckRowProps): ReactNode {
  const form = useUpdateCheck(value => value)
  const mutation = useUpdateCheckMutation(value => value)
  const [channelHost, setChannelHost] = useState<string | undefined>(undefined)
  useEffect(() => {
    const controller = new AbortController()
    fetch(UPDATE_CHANNEL_PATH.slice(1), { headers: { accept: 'application/json' }, signal: controller.signal })
      .then(async (response) => response.ok ? await response.json() as UpdateChannelResponse : undefined)
      .then((answer) => { if (typeof answer?.host === 'string') setChannelHost(answer.host) })
      // A missing route or a failed request leaves the production wording; the copy never blocks the switch.
      .catch(() => undefined)
    return () => { controller.abort() }
  }, [])
  return <OptInRow id="updateCheck" t={t} channelHost={channelHost} form={form} mutation={mutation} unavailable="updateCheck.unavailable" setEnabled={setEnabled} />
}
