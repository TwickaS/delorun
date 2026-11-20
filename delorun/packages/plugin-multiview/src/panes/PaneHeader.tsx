/**
 * A pane's header: the grip, the monogram, the name and task, the status badge with its time, the pane's actions (move, open the
 * full chat, stop, close) and, for a live external agent, the limits line read softly from the `agentSeat` projection.
 */
import { useEffect, useMemo, useState } from 'react'
import {
  IconChevronDownOutlineRegular, IconCloseOutlineRegular, IconShareOutlineRegular, IconStopFillRegular, Menu, Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { PaneTarget } from '../layout/index.ts'
import type { PANES_NS } from './locales.ts'
import type { PaneHeaderOwnerProps } from './slots.ts'
import {
  advanceClock, formatElapsed, FRESH_CLOCK, initialsOf, limitChips, paneStatus, SEAT_AGENTS, type RunClock, type SeatLimits,
} from './status.ts'
import css from './PaneHeader.module.css'

/** Props of the pane header entry. */
export type PaneHeaderProps = PropsRuntime<'multiview.pane.header'> & PropsLocale<typeof PANES_NS> & PaneHeaderOwnerProps

type Translate = PropsLocale<typeof PANES_NS>['t']

/** The key of a Move to… item, which names the target it applies. */
function itemId(target: PaneTarget): string {
  return target.kind === 'edge' ? `edge:${target.edge}` : `pane:${target.region}:${target.pane}`
}

/**
 * Keep a pane's run clock: when the current run began and how long the last one took.
 * @param status - the status now.
 * @param runStart - when the chat says the run began, when it knows.
 * @returns the clock and the time now, which ticks each second while the chat works.
 */
function useRunClock(status: ReturnType<typeof paneStatus>, runStart: number | undefined): { readonly clock: RunClock; readonly now: number } {
  const [clock, setClock] = useState<RunClock>(() => advanceClock(FRESH_CLOCK, status, Date.now(), runStart))
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => { setClock(previous => advanceClock(previous, status, Date.now(), runStart)) }, [status, runStart])
  const ticking = clock.startedAt !== undefined
  useEffect(() => {
    if (!ticking) return undefined
    setNow(Date.now())
    const timer = setInterval(() => { setNow(Date.now()) }, 1000)
    return () => { clearInterval(timer) }
  }, [ticking])
  return { clock, now }
}

/** The badge's text. */
function badgeText(t: Translate, status: ReturnType<typeof paneStatus>, clock: RunClock, now: number, knownDuration: number | undefined): string {
  switch (status) {
    case 'needs-approval': return t('status.needs-approval')
    case 'idle': return t('status.idle')
    case 'working':
      return clock.startedAt === undefined ? t('status.working.now') : t('status.working', { time: formatElapsed(now - clock.startedAt) })
    case 'done': {
      const duration = clock.lastDuration ?? knownDuration
      return duration === undefined ? t('status.done.now') : t('status.done', { time: formatElapsed(duration) })
    }
  }
}

/**
 * Draw the header of the pane bound to this chat.
 * @param props - the chat's sources, the pane's controls and callbacks, and the dictionary.
 * @returns the header.
 */
export function PaneHeader(props: PaneHeaderProps) {
  const { sessionId, useSession, useSessions, useSessionStatus, useProjection, useAccess, isMain, focused, page, controls, onOpen, onStop, onClose, clock: formatClock, t } = props
  const running = useSession(session => session.running)
  const stoppable = useSession(session => session.running && (session.subagent === null || session.subagent.address.mode === 'continuable'))
  const waiting = useSessionStatus(statuses => statuses.get(sessionId)?.pendingInteraction !== undefined)
  const title = useSessions(state => titleOf(state.byId[sessionId]))
  const createdAt = useSessions(state => state.byId[sessionId]?.createdAt)
  const updatedAt = useSessions(state => state.byId[sessionId]?.updatedAt)
  // The projection is declared by `@delorun/plugin-agent-seats`; a studio without it returns no value and the line is absent.
  const seat = (useProjection as (key: string) => SeatLimits | null | undefined)('agentSeat')
  const stopDenied = useAccess('session/cancel') === false
  const status = paneStatus({ running: running === true, waiting, isMain })
  const known = seat === null || seat === undefined ? undefined : SEAT_AGENTS[seat.agent ?? '']
  const name = isMain ? title : known?.name ?? title
  const task = isMain ? t('badge.mainChat') : name === title ? '' : title
  const monogram = known?.monogram ?? initialsOf(name)
  const { clock, now } = useRunClock(status, isMain ? undefined : createdAt)
  const knownDuration = createdAt !== undefined && updatedAt !== undefined && updatedAt >= createdAt && !isMain ? updatedAt - createdAt : undefined
  const chips = useMemo(() => limitChips(seat, formatClock), [seat, formatClock])
  const targets = [...new Set(controls.moveOptions.flatMap(option => (option.target.kind === 'pane' ? [option.target.pane] : [])))]
  const titles = useSessions(state => targets.map(id => titleOf(state.byId[id])).join('\u0000')).split('\u0000')
  const nameOf = (pane: SessionId): string => titles[targets.indexOf(pane)] ?? pane
  const [menuOpen, setMenuOpen] = useState(false)
  const items = [
    ...controls.swapCandidates.map(other => ({ id: `swap:${other}`, label: `${t('action.swap')} · ${nameOf(other)}` })),
    ...(controls.swapCandidates.length > 0 && controls.moveOptions.length > 0 ? [{ type: 'separator' as const, id: 'separator' }] : []),
    ...controls.moveOptions.map(option => ({
      id: itemId(option.target),
      label: option.target.kind === 'edge' ? t(`move.edge.${option.target.edge}`) : t(`move.pane.${option.target.region}`, { pane: nameOf(option.target.pane) }),
    })),
  ]
  return (
    <div className={css.header} data-pane-header={sessionId} data-status={status} data-focused={focused || undefined} data-main={isMain || undefined} data-page={page || undefined}>
      <div className={css.top}>
        {page ? null : controls.grip}
        <span className={css.monogram} data-agent={seat?.agent} aria-hidden>{monogram}</span>
        <span className={css.name}>{name}</span>
        {task === '' ? null : <span className={css.task}>{task}</span>}
        <span className={css.badge} data-status={status} role="status">{badgeText(t, status, clock, now, knownDuration)}</span>
        {page ? null : <span className={css.actions}>
          {items.length === 0 ? null : (
            <Menu
              open={menuOpen}
              portal
              align="end"
              onClose={() => { setMenuOpen(false) }}
              items={items}
              onSelect={(id) => {
                setMenuOpen(false)
                applyChoice(id, sessionId, controls)
              }}
              anchor={
                <button type="button" className={css.action} aria-haspopup="menu" aria-expanded={menuOpen} aria-label={t('action.move')} onClick={() => { setMenuOpen(open => !open) }}>
                  <IconChevronDownOutlineRegular size={14} />
                </button>
              }
            />
          )}
          {isMain ? null : (
            <Tooltip label={t('action.open')} side="bottom" delayMs={500} portal>
              <button type="button" className={css.action} aria-label={t('action.open')} onClick={onOpen}><IconShareOutlineRegular size={14} /></button>
            </Tooltip>
          )}
          {stoppable === true && !stopDenied && (
            <Tooltip label={t('action.stop')} side="bottom" delayMs={500} portal>
              <button type="button" className={`${css.action} ${css.stop}`} aria-label={t('action.stop')} onClick={onStop}><IconStopFillRegular size={14} /></button>
            </Tooltip>
          )}
          {controls.canClose && (
            <Tooltip label={t('action.close')} side="bottom" delayMs={500} portal>
              <button type="button" className={css.action} aria-label={t('action.close')} onClick={onClose}><IconCloseOutlineRegular size={14} /></button>
            </Tooltip>
          )}
        </span>}
      </div>
      {chips.length === 0 ? null : (
        <div className={css.limits} role="group" aria-label={t('limits.label')}>
          {chips.map(chip => <span key={chip.key} className={css.chip}>{t(chip.key, chip.values)}</span>)}
        </div>
      )}
    </div>
  )
}

/**
 * The display name of a chat's list row.
 * @param row - the row, or undefined for a chat the list does not hold.
 * @returns the agent's label when it has one, otherwise the row's title.
 */
function titleOf(row: { readonly displayTitle: string; readonly projectionValues?: { readonly subagent?: { readonly label?: string } | null } | undefined } | undefined): string {
  return row?.projectionValues?.subagent?.label ?? row?.displayTitle ?? ''
}

/** Apply the chosen menu item through the layout's actions. */
function applyChoice(id: string, pane: SessionId, controls: PaneHeaderOwnerProps['controls']): void {
  if (id.startsWith('swap:')) { controls.actions.swap(pane, id.slice('swap:'.length) as SessionId); return }
  const option = controls.moveOptions.find(candidate => itemId(candidate.target) === id)
  if (option !== undefined) controls.actions.move(pane, option.target)
}
