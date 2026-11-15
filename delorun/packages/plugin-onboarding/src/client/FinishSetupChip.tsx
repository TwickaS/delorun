/**
 * The chip above the message box that brings the setup guide back after Finish later, for the rest of this visit. It
 * disappears once the guide is finished.
 */
import type { InjectFace, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { useCallback, useEffect, useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import type { ConfigForm } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { OnboardingSettings } from '../config.ts'
import type { LaterStore } from './types.ts'
import css from './FinishSetupChip.module.css'

/** The flag that a chat's input dock currently holds the chip. */
export interface DockedStore extends LaterStore {}

/** What the chip reads and calls. */
export interface FinishSetupInjected {
  /** Whether the guide was set aside in this visit. */
  readonly later: LaterStore
  /** Whether a chat's dock shows the chip, so the floating one stays away. */
  readonly docked: DockedStore
  /** The guide's saved progress; the chip hides once it is done. */
  readonly progress: ConfigForm<OnboardingSettings>
  /** Show the guide again at the saved step. */
  readonly reopen: () => void
}

/** The props of the chip in the input dock: this plugin's copy and the services. */
export type FinishSetupChipProps = PropsLocale<'delorunOnboarding'> & InjectFace<FinishSetupInjected>

/**
 * Whether the chip should show: the guide was set aside and is not finished.
 * @param later - the set-aside flag.
 * @param progress - the guide's saved progress.
 * @returns whether to draw the chip.
 */
function useChipVisible(later: LaterStore, progress: FinishSetupInjected['progress']): boolean {
  const aside = useSyncExternalStore(later.subscribe, later.getSnapshot)
  const snapshot = useSyncExternalStore(useCallback(listener => progress.subscribe(listener), [progress]), () => progress.getSnapshot())
  return aside && snapshot.status === 'ready' && snapshot.value !== undefined && !snapshot.value.done
}

/**
 * Render the chip in a chat's input dock while the guide is set aside and unfinished. While it is mounted the floating
 * chip steps aside.
 * @param props - this plugin's copy and the services.
 * @returns the chip, or nothing.
 */
export function FinishSetupChip({ t, later, progress, reopen, docked }: FinishSetupChipProps): ReactNode {
  useEffect(() => {
    docked.set(true)
    return () => { docked.set(false) }
  }, [docked])
  if (!useChipVisible(later, progress)) return null
  return (
    <div className={css.dock}>
      <button type="button" className={css.chip} onClick={reopen}>{t('finishSetup')}</button>
    </div>
  )
}

/**
 * Render the chip over the studio where no chat has a dock, as on the first screen before any chat exists.
 * @param props - this plugin's copy and the services.
 * @returns the chip, or nothing.
 */
export function FloatingFinishSetupChip({ t, later, progress, reopen, docked }: FinishSetupChipProps): ReactNode {
  const inDock = useSyncExternalStore(docked.subscribe, docked.getSnapshot)
  if (!useChipVisible(later, progress) || inDock) return null
  return (
    <div className={css.floating}>
      <button type="button" className={css.chip} onClick={reopen}>{t('finishSetup')}</button>
    </div>
  )
}
