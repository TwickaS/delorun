/**
 * The chip above the message box that brings the setup guide back after Finish later, for the rest of this visit. It
 * disappears once the guide is finished.
 */
import type { InjectFace, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import type { ConfigForm } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { OnboardingSettings } from '../config.ts'
import type { LaterStore } from './types.ts'
import css from './FinishSetupChip.module.css'

/** What the chip reads and calls. */
export interface FinishSetupInjected {
  /** Whether the guide was set aside in this visit. */
  readonly later: LaterStore
  /** The guide's saved progress; the chip hides once it is done. */
  readonly progress: ConfigForm<OnboardingSettings>
  /** Show the guide again at the saved step. */
  readonly reopen: () => void
}

/** The props of the chip in the input dock: this plugin's copy and the services. */
export type FinishSetupChipProps = PropsLocale<'delorunOnboarding'> & InjectFace<FinishSetupInjected>

/**
 * Render the chip while the guide is set aside and unfinished.
 * @param props - this plugin's copy and the services.
 * @returns the chip, or nothing.
 */
export function FinishSetupChip({ t, later, progress, reopen }: FinishSetupChipProps): ReactNode {
  const aside = useSyncExternalStore(later.subscribe, later.getSnapshot)
  const snapshot = useSyncExternalStore(progress.subscribe, () => progress.getSnapshot())
  if (!aside || snapshot.status !== 'ready' || snapshot.value.done) return null
  return (
    <div className={css.dock}>
      <button type="button" className={css.chip} onClick={reopen}>{t('finishSetup')}</button>
    </div>
  )
}
