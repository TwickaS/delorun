/**
 * The "Finish setup" entry at the sidebar's foot on the computer, the way back into the guide. Wide, it is a labelled
 * line of its own above the foot's icon buttons; on the rail it is an icon with a tooltip, and the count of waiting steps when there is one. While the guide is
 * unfinished it reads "Finish setup" and reopens it at the saved step. Once the guide is finished it counts the steps a
 * phone deferred to this computer ("Finish setup · N left"), opens the guide with only those steps, and is gone at zero. A deferred step whose work is already
 * done (phone access is on, a PIN is set) is cleared when the entry reads, so it never counts a finished step.
 */
import { IconChecklistOutlineRegular, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, OwnerOf, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: the 'sidebar.footer.action' SlotMap entry.
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import { readPinMode } from '@delorun/bundle-local/pin-api'
import type { HostFetch } from '@delorun/bundle-local/host-api'
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import type { ConfigForm } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { OnboardingSettings } from '../config.ts'
import type { DeferrableStep, SetupRecord } from '../wire.ts'
import { withSteps } from './flow.tsx'
import type { HostFace, LaterStore } from './types.ts'
import css from './DeferredSetupEntry.module.css'

/** What the entry reads and calls. */
export interface DeferredSetupInjected {
  /** The deferred steps' record and the reads that tell which are done. */
  readonly host: Pick<HostFace, 'reach' | 'reachAddress' | 'defer'>
  /** The home's setup record, which lists the deferred steps. */
  readonly loadRecord: () => Promise<SetupRecord>
  /** Sends the PIN read. */
  readonly fetch: HostFetch
  /** Whether this studio is on the home's own computer; the entry shows nowhere else. */
  readonly atComputer: () => boolean
  /** The dialog's deferred-only flag: the entry sets it before opening the guide, and re-reads when it clears. */
  readonly deferredOnly: LaterStore
  /** Bumps when a step is deferred or cleared, so the entry reads again. */
  readonly changed: { getSnapshot(): number; subscribe(listener: () => void): () => void }
  /** The guide's saved progress; the entry shows while it is unfinished. */
  readonly progress: ConfigForm<OnboardingSettings>
  /** Open the guide at its saved place. */
  readonly open: () => void
}

/** The entry's props: the foot's width, the copy and the services. */
export type DeferredSetupEntryProps = OwnerOf<'sidebar.footer.action'> & PropsLocale<'delorunOnboarding'> & InjectFace<DeferredSetupInjected>

/**
 * Read the steps still waiting for this computer, clearing the ones already done.
 * @param input - the services the read uses.
 * @returns the steps that still wait, in the guide's order.
 */
export async function readWaiting({ host, loadRecord, fetch }: Pick<DeferredSetupInjected, 'host' | 'loadRecord' | 'fetch'>): Promise<DeferrableStep[]> {
  const waiting = withSteps((await loadRecord()).deferred ?? [])
  if (waiting.length === 0) return []
  const done = new Set<DeferrableStep>()
  if (waiting.includes('reach') && await host.reach() === 'set-up') done.add('reach')
  if (waiting.includes('pin')) {
    try {
      if ((await readPinMode(fetch))?.enabled === true) done.add('pin')
    } catch (error) {
      // An unreadable PIN state leaves the step counted: the person can still open it.
      console.warn('delorun onboarding: PIN mode was not read for the Finish setup entry', error)
    }
  }
  await Promise.all([...done].map(id => host.defer(id, false)))
  return waiting.filter(id => !done.has(id))
}

/**
 * Render the entry on the computer while a deferred step waits.
 * @param props - the foot's width, the copy and the services.
 * @returns the entry, or nothing.
 */
export function DeferredSetupEntry({ wide, t, host, loadRecord, fetch, atComputer, progress, deferredOnly, changed, open }: DeferredSetupEntryProps): ReactNode {
  const [waiting, setWaiting] = useState<readonly DeferrableStep[]>([])
  const revision = useSyncExternalStore(changed.subscribe, changed.getSnapshot)
  const guideOpen = useSyncExternalStore(deferredOnly.subscribe, deferredOnly.getSnapshot)
  const computer = atComputer()
  useEffect(() => {
    if (!computer || guideOpen) return
    let live = true
    void readWaiting({ host, loadRecord, fetch }).then((steps) => { if (live) setWaiting(steps) }, (error: unknown) => { console.warn('delorun onboarding: the deferred steps were not read', error) })
    return () => { live = false }
  }, [computer, guideOpen, revision, host, loadRecord, fetch])
  const saved = useSyncExternalStore(useCallback(listener => progress.subscribe(listener), [progress]), () => progress.getSnapshot())
  const unfinished = saved.status === 'ready' && saved.value !== undefined && !saved.value.done
  const start = useCallback((): void => {
    deferredOnly.set(!unfinished)
    open()
  }, [deferredOnly, open, unfinished])
  if (!computer || (!unfinished && waiting.length === 0)) return null
  const label = waiting.length === 0 ? t('finishSetup') : t('deferred.entry', { n: String(waiting.length) })
  const button = <button type="button" className={wide ? css.entry : css.rail} aria-label={label} data-delorun-finish-setup-left={waiting.length} data-sidebar-foot-line={wide ? '' : undefined} onClick={start}>
    <IconChecklistOutlineRegular aria-hidden="true" />
    {wide ? <span className={css.text}>{label}</span> : waiting.length > 0 && <span className={css.count}>{waiting.length}</span>}
  </button>
  return wide ? button : <Tooltip label={label}>{button}</Tooltip>
}
