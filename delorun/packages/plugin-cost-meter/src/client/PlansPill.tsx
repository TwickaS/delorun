/**
 * The Plans pill beside the cost pill: the highest used share across the added agents' plan limits, coloured amber
 * from 80% and red at a reached limit, opening a popover with each agent's bars and "Check now". It renders nothing
 * while no agent pack is added. Showing it reads stored figures only; a check starts only from a button (T12).
 */
import { useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useDismissOnOutsidePointer } from '@deepseek-ai/dsh-client-ui-primitives'
import { AgentLimits, highestShare, pillStanding, signInText, useAccounts, type LimitsTranslate } from '@delorun/bundle-local/agent-limits'
import type { HostFetch } from '@delorun/bundle-local/host-api'
import type { Translate } from './costs.ts'
import css from './CostPill.module.css'
import plans from './PlansPill.module.css'

/** What the dock entry injects. */
export interface PlansPillInjected {
  /** Sends the pill's same-origin requests: the browser's `fetch`, or a spec's fake. */
  readonly fetch: HostFetch
}

/** Props of the dock entry. */
export interface PlansPillProps extends PlansPillInjected {
  /** The dictionary. */
  readonly t: Translate
}

/** A gauge, drawn at the stock pills' icon size. */
function GaugeIcon() {
  return (
    <svg className={css.icon} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.3} aria-hidden>
      <path d="M2.5 11.5a6 6 0 1 1 11 0" strokeLinecap="round" />
      <path d="M8 9.5 10.5 6" strokeLinecap="round" />
    </svg>
  )
}

/**
 * The pill and its popover.
 * @param props - the request function and the dictionary.
 * @returns the pill, or `null` while no agent pack is added or the figures cannot be read.
 */
export function PlansPill({ fetch, t }: PlansPillProps) {
  const limitsT: LimitsTranslate = t
  const { state, reload, check } = useAccounts(fetch, limitsT)
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLSpanElement | null>(null)
  const buttonRef = useRef<HTMLButtonElement | null>(null)
  const panelRef = useRef<HTMLDivElement | null>(null)
  const titleId = useId()
  const anchorName = `--delorun-plans-${useId().replaceAll(':', '')}`
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

  if (state.kind !== 'ready') return null
  const added = state.accounts.filter(account => account.installed)
  if (added.length === 0) return null
  const share = highestShare(added, state.now)
  const standing = pillStanding(share, added, state.now)
  const text = standing === 'reached' ? t('limits.status.reached') : share === undefined ? undefined : `${String(share)}%`
  const label = text === undefined ? t('plans.label.none') : t('plans.label', { value: text })
  const toggle = (): void => {
    // Opening reads the stored figures again, which starts no check.
    if (!open) void reload()
    setOpen(!open)
  }

  return (
    <span ref={rootRef} style={{ anchorName }} className={css.anchor} data-composer-stat="plans">
      <button ref={buttonRef} type="button" className={`${css.pill} ${plans.pill}`} data-standing={standing} title={label} aria-label={label}
        aria-haspopup="dialog" aria-expanded={open} onClick={toggle}>
        <GaugeIcon />
        <span className={css.label}>{t('plans.pill')}{text !== undefined && ` ${text}`}</span>
      </button>
      {open && createPortal(
        <div ref={panelRef} className={css.panel} role="dialog" aria-labelledby={titleId} tabIndex={-1} style={{ positionAnchor: anchorName }}>
          <div className={css.title}><span id={titleId}>{t('plans.title')}</span></div>
          <div className={css.rule} aria-hidden />
          <div className={plans.agents}>
            {added.map(account => (
              <section key={account.provider} className={plans.agent} aria-label={t('limits.group', { agent: t(`plans.agent.${account.provider}`) })}>
                <div className={plans.name}>{t(`plans.agent.${account.provider}`)}<span className={plans.signIn}>{signInText(limitsT, account) ?? t('limits.signInUnknown')}</span></div>
                <AgentLimits account={account} now={state.now} t={limitsT} check={check} />
              </section>
            ))}
          </div>
          <p className={css.estimate}>{t('plans.note')}</p>
        </div>,
        document.body,
      )}
    </span>
  )
}
