/**
 * The work-session badge at the sidebar's foot: while a work session lasts, it names the plugin whose folder loads
 * live, in the foot's free space, as a small status row that takes no focus; in the narrow rail it is a dot with the
 * same words as its tooltip. It reads the Changes state the controller keeps, so it shows from the state route's
 * `workSession` and is gone once the state no longer names one or its end time has passed.
 */
import { StateDot, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { HostObservable, InjectFace, OwnerOf, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: the 'sidebar.footer.action' SlotMap entry.
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type { ChangesLoad } from './controller.ts'
import { timeOfDay } from './time.ts'
import css from './WorkBadge.module.css'

/** What the badge reads. */
export interface WorkBadgeInjected {
  readonly hooks: { readonly changes: HostObservable<ChangesLoad> }
}

/** The badge's props: the foot's width, the copy and the Changes state. */
export type WorkBadgeProps = OwnerOf<'sidebar.footer.action'> & PropsLocale<'deloChanges'> & InjectFace<WorkBadgeInjected>

/**
 * Render the badge while a work session lasts.
 * @param props - the foot's width, the copy and the Changes state.
 * @returns the badge, or nothing.
 */
export function WorkBadge({ wide, t, useChanges }: WorkBadgeProps) {
  const session = useChanges(load => load.status === 'ready' ? load.state.workSession : undefined)
  if (session === undefined || Date.parse(session.endsAt) <= Date.now()) return null
  const name = t('badge.working', { plugin: session.plugin })
  const until = t('badge.until', { time: timeOfDay(session.endsAt) })
  if (!wide) {
    return <Tooltip label={t('badge.tooltip', { plugin: session.plugin, time: timeOfDay(session.endsAt) })}>
      <span className={css.dot} role="status" aria-label={name} data-delo-work-badge={session.plugin}><StateDot state="warning" /></span>
    </Tooltip>
  }
  return <Tooltip label={until} side="top">
    <span className={css.badge} role="status" data-delo-work-badge={session.plugin}>
      <StateDot state="warning" />
      <span className={css.text}>{name}</span>
    </span>
  </Tooltip>
}
