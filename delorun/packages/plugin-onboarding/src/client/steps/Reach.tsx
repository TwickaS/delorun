/**
 * Phone access: what it does and the command that turns it on, with the Tailscale checks under More.
 */
import { TAILSCALE_OPERATOR_COMMAND } from '@delorun/contract-reach-providers'
import type { ReactNode } from 'react'
import type { TailscaleReadiness } from '../../wire.ts'
import type { StepServices } from '../types.ts'
import { CommandRow } from '../ui/CommandRow.tsx'
import { StateLine } from '../ui/StateLine.tsx'
import { useStore, type StepProps } from './shared.ts'
import more from './reach.module.css'
import css from './steps.module.css'

/** The command that turns reach on at the computer. */
export const REACH_COMMAND = 'delorun reach on tailscale'

/** The command that approves a phone once reach is on. */
export const APPROVE_COMMAND = 'delorun devices approve'

/** Tailscale's checks in the order a person fixes them, and the readiness state that stops at each. */
const TAILSCALE_CHECKS = [
  { key: 'installed', stops: 'not-installed' },
  { key: 'signedIn', stops: 'signed-out' },
  { key: 'https', stops: 'https-off' },
  { key: 'operator', stops: 'needs-operator' },
] as const

/** The command that fixes a check, where one does. */
const FIXES: Readonly<Partial<Record<typeof TAILSCALE_CHECKS[number]['key'], string>>> = { signedIn: 'tailscale up', operator: TAILSCALE_OPERATOR_COMMAND }

/**
 * Tailscale's checks as rows: each done, the first one missing with its fix, and the rest waiting.
 * @param props - the readiness and this plugin's copy.
 * @returns the rows.
 */
function TailscaleChecks({ tailscale, t }: { readonly tailscale: TailscaleReadiness; readonly t: StepServices['t'] }): ReactNode {
  const stop = TAILSCALE_CHECKS.findIndex(check => check.stops === tailscale.state)
  const reached = tailscale.state === 'ready' ? TAILSCALE_CHECKS.length : stop
  return (
    <ul className={css.rows}>
      {TAILSCALE_CHECKS.map((check, index) => {
        const state = index < reached ? 'done' : index === reached ? 'todo' : 'waiting'
        const fix = FIXES[check.key]
        return (
          <li key={check.key} className={css.check} data-state={state}>
            <span className={css.checkMark} aria-hidden="true">{state === 'done' ? '✓' : state === 'todo' ? '!' : '·'}</span>
            <span className={css.checkText}>
              <span>{t(`reach.check.${check.key}`)}<span className={css.visuallyHidden}>{t(`reach.state.${state}`)}</span></span>
              {state === 'todo' && <span className={css.hint}>{t(`reach.fix.${check.key}`)}</span>}
              {state === 'todo' && fix !== undefined && <CommandRow command={fix} t={t} />}
            </span>
          </li>
        )
      })}
    </ul>
  )
}

/**
 * Phone access, while reach is not set up: one sentence on what it does and the command that turns it on; the Tailscale
 * checks and the approval command sit under More; the PIN step follows once reach is on. A studio opened from a phone has no such step.
 * @param props - the services and the guide.
 * @returns the step body.
 */
export function ReachStep({ services, guide }: StepProps): ReactNode {
  const { t } = services
  const readiness = useStore(guide.readiness)
  const tailscale = readiness.status === 'ready' ? readiness.value.tailscale : undefined
  return (
    <div className={css.stack}>
      {tailscale?.state === 'ready'
        ? <StateLine tone="success">{t('reach.ready')}</StateLine>
        : <><p className={css.lead}>{t('reach.lead')}</p><CommandRow command={REACH_COMMAND} t={t} /></>}
      <details className={more.details}>
        <summary className={more.summary}>{t('reach.more')}</summary>
        <div className={more.more}>
          <div aria-live="polite">
            {readiness.status === 'loading' && <p className={css.status}>{t('reach.checking')}</p>}
            {(readiness.status === 'failed' || tailscale?.state === 'unknown') && <p className={css.status} data-tone="attention">{t('reach.unread')}</p>}
          </div>
          {tailscale !== undefined && tailscale.state !== 'unknown' && <TailscaleChecks tailscale={tailscale} t={t} />}
          <span>{t('reach.then')}</span>
          <CommandRow command={APPROVE_COMMAND} t={t} />
          {tailscale?.state === 'ready' && <span>{t('reach.address', { address: `https://${tailscale.dnsName}` })}</span>}
          <span>{t('reach.limits')}</span>
        </div>
      </details>
    </div>
  )
}
