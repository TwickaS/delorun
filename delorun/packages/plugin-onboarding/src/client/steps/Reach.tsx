/**
 * Phone access: how far Tailscale is from serving the studio and the commands that turn reach on, or one line when the
 * studio is already opened through reach.
 */
import { TAILSCALE_OPERATOR_COMMAND } from '@delorun/contract-reach-providers'
import type { ReactNode } from 'react'
import type { TailscaleReadiness } from '../../wire.ts'
import type { StepServices } from '../types.ts'
import { CommandRow } from '../ui/CommandRow.tsx'
import { useStore, type StepProps } from './shared.ts'
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
 * Phone access, while reach is not set up: how far Tailscale is from serving the studio, with the command for the first
 * thing missing, then the commands that turn reach on and approve the phone, all run at this computer.
 * @param props - the services and the guide.
 * @returns the step body.
 */
export function ReachStep({ services, guide }: StepProps): ReactNode {
  const { t } = services
  const readiness = useStore(guide.readiness)
  const tailscale = readiness.status === 'ready' ? readiness.value.tailscale : undefined
  return (
    <div className={css.stack}>
      <p className={css.lead}>{t('reach.lead')}</p>
      <div aria-live="polite">
        {readiness.status === 'loading' && <p className={css.status}>{t('reach.checking')}</p>}
        {(readiness.status === 'failed' || tailscale?.state === 'unknown') && <p className={css.status} data-tone="attention">{t('reach.unread')}</p>}
      </div>
      {tailscale !== undefined && tailscale.state !== 'unknown' && <TailscaleChecks tailscale={tailscale} t={t} />}
      <div className={css.field}>
        <span className={css.label}>{t('reach.then')}</span>
        <CommandRow command={REACH_COMMAND} t={t} />
        <CommandRow command={APPROVE_COMMAND} t={t} />
        {tailscale?.state === 'ready' && <p className={css.hint}>{t('reach.address', { address: `https://${tailscale.dnsName}` })}</p>}
      </div>
      <p className={css.hint}>{t('reach.limits')}</p>
      <p className={css.hint}>{t('reach.pin')}</p>
    </div>
  )
}

/**
 * Phone access, for a studio opened through reach: one line saying that the phone is connected and that approvals and
 * full access are decided at the computer.
 * @param props - the services.
 * @returns the step body.
 */
export function RemoteReachStep({ services }: StepProps): ReactNode {
  return <p className={css.lead}>{services.t('reach.remote')}</p>
}
