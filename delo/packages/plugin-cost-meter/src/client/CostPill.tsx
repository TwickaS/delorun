/**
 * The composer-dock pill with the open chat's estimated cost, and the total with its subagents and teammates when they
 * cost anything, opening an anchored dialog with the breakdown. Costs come finished from the harness's `costMeter`
 * projection: the open chat's live value, and each agent's from its Session summary or loaded projections.
 */
import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { UseProjection } from '@deepseek-ai/dsh-api-session-controller/client'
import { useDismissOnOutsidePointer } from '@deepseek-ai/dsh-client-ui-primitives'
import type { UseSessions } from '@deepseek-ai/dsh-client-ui-session/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
// Type-only: the subagentCatalog projection merge.
import type {} from '@deepseek-ai/dsh-subagent/client'
// Type-only: the costMeter projection merge.
import type {} from '../view.ts'
import { CostBreakdown, type CostGroup } from './CostBreakdown.tsx'
import { addCosts, collectAgents, counted, formatCost, NO_COST, type Translate } from './costs.ts'
import css from './CostPill.module.css'

/** What the dock entry injects. */
export interface CostPillInjected {
  /**
   * Ask the harness for the projections of agents whose cost is not on the page; a failure leaves them listed as not
   * available, and the next opening asks again.
   * @param ids - the agents' Sessions.
   */
  readonly loadCosts: (ids: readonly SessionId[]) => void
}

/** Props of the dock entry. */
export interface CostPillProps extends CostPillInjected {
  /** The open chat. */
  readonly sessionId: SessionId
  /** The open chat's projection values. */
  readonly useProjection: UseProjection
  /** The Session list, with each row's summary values and the loaded projections. */
  readonly useSessions: UseSessions
  /** The dictionary. */
  readonly t: Translate
}

/** A coin, drawn at the stock pills' icon size. */
function CoinIcon() {
  return (
    <svg className={css.icon} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.3} aria-hidden>
      <circle cx={8} cy={8} r={6.25} />
      <path d="M10 6.1c-.3-.6-1-1-2-1-1.1 0-1.9.6-1.9 1.4 0 1.9 4 1 4 2.9 0 .9-.9 1.5-2.1 1.5-1 0-1.8-.4-2.1-1.1M8 4.2v7.6" strokeLinecap="round" />
    </svg>
  )
}

/**
 * The pill and its dialog; renders nothing until the chat or one of its agents has made a request.
 * @param props - the open chat, its projection reads, the Session list, the loader and the dictionary.
 * @returns the pill, or `null`.
 */
export function CostPill({ sessionId, useProjection, useSessions, t, loadCosts }: CostPillProps) {
  const own = useProjection('costMeter')
  const catalog = useProjection('subagentCatalog')
  const byId = useSessions(state => state.byId)
  const loaded = useSessions(state => state.projectionsBySession)
  const tree = useMemo(() => collectAgents(sessionId, catalog, byId, loaded), [sessionId, catalog, byId, loaded])
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLSpanElement | null>(null)
  const buttonRef = useRef<HTMLButtonElement | null>(null)
  const panelRef = useRef<HTMLDivElement | null>(null)
  const titleId = useId()
  const anchorName = `--delo-cost-${useId().replaceAll(':', '')}`
  useDismissOnOutsidePointer(rootRef, open, setOpen, panelRef)

  useEffect(() => {
    if (!open) return
    panelRef.current?.focus()
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      setOpen(false)
      buttonRef.current?.focus()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => { document.removeEventListener('keydown', onKeyDown) }
  }, [open])

  const agentsCost = addCosts(tree.agents.map(agent => agent.cost))
  const hasAgents = agentsCost.requests > 0
  if ((own === undefined || own.requests === 0) && !hasAgents) return null
  const self = own ?? NO_COST
  const total = addCosts([self, agentsCost])
  const cost = formatCost(self.usd)
  const totalText = formatCost(total.usd)
  const label = hasAgents ? t('pill.labelWithAgents', { cost, total: totalText }) : t('pill.label', { cost })
  const title = t(hasAgents ? 'dialog.titleWithAgents' : 'dialog.title')
  const groups: CostGroup[] | null = hasAgents
    ? [{ id: 'self', name: t('group.thisChat'), value: self }, ...tree.agents.map(agent => ({
        id: agent.id, name: agent.label ?? t('group.agent', { id: agent.id.slice(-6) }), value: agent.cost,
      }))].filter(group => group.value.requests > 0)
    : null
  const notes = [
    total.unpriced > 0 ? counted(t, 'note.unpriced', total.unpriced) : null,
    tree.missing.length > 0 ? counted(t, 'note.loading', tree.missing.length) : null,
    tree.external > 0 ? counted(t, 'note.external', tree.external) : null,
  ].filter(note => note !== null)

  const toggle = (): void => {
    if (!open && tree.missing.length > 0) loadCosts(tree.missing)
    setOpen(!open)
  }

  return (
    <span ref={rootRef} style={{ anchorName }} className={css.anchor} data-composer-stat="cost">
      <button
        ref={buttonRef}
        type="button"
        className={css.pill}
        title={label}
        aria-label={label}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={toggle}
      >
        <CoinIcon />
        <span className={css.label}>
          {cost}
          {hasAgents && <span className={css.sep} aria-hidden>·</span>}
          {hasAgents && t('pill.withAgents', { total: totalText })}
        </span>
      </button>
      {open && createPortal(
        <div ref={panelRef} className={css.panel} role="dialog" aria-labelledby={titleId} tabIndex={-1} style={{ positionAnchor: anchorName }}>
          <div className={css.title}>
            <span id={titleId}>{title}</span>
            <span className={css.titleValue}>{totalText}</span>
          </div>
          <div className={css.rule} aria-hidden />
          <CostBreakdown self={self} groups={groups} t={t} />
          {notes.length > 0 && (
            <ul className={css.notes}>
              {notes.map(note => <li key={note}>{note}</li>)}
            </ul>
          )}
          <p className={css.estimate}>{t('note.estimate')}</p>
        </div>,
        document.body,
      )}
    </span>
  )
}
