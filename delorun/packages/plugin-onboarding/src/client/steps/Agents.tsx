/**
 * Agents: Claude Code and Codex, each with its sign-in on this computer, added only after the person reads what adding
 * one means and confirms.
 */
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { AgentSignIn } from '../../wire.ts'
import { StateLine, type StateTone } from '../ui/StateLine.tsx'
import { BundleCard } from './BundleCard.tsx'
import { useBundle, useRefresh, useStore, type StepProps } from './shared.ts'
import css from './steps.module.css'

/** The delegation bundles the agents step offers, by package name, the key of their copy and their connection id. */
export const AGENT_BUNDLES = [
  { name: '@deepseek-ai/dsh-subagent-claude-code', key: 'claude', agent: 'claude-code' },
  { name: '@deepseek-ai/dsh-subagent-codex', key: 'codex', agent: 'codex' },
] as const

/** The state line of an agent's sign-in. */
const SIGN_IN_TONES: Readonly<Record<AgentSignIn, StateTone>> = { found: 'success', missing: 'warning', unknown: 'info' }

/**
 * One coding agent: where its sign-in stands and, after Add, what adding it means, confirmed with a second press.
 * @param props - the agent and the services.
 * @returns the card.
 */
function AgentCard({ agent, services, guide }: { readonly agent: typeof AGENT_BUNDLES[number] } & StepProps): ReactNode {
  const { t, bundles } = services
  const readiness = useStore(guide.readiness)
  const [confirming, setConfirming] = useState(false)
  // Set when Continue is pressed with the confirmation open: the card asks before the flow goes on.
  const [asking, setAsking] = useState(false)
  const question = useRef<HTMLDivElement>(null)
  const title = t(`agents.${agent.key}.title`)
  const signIn = readiness.status === 'ready' ? readiness.value.agents[agent.agent] : undefined
  const loading = readiness.status === 'loading'
  useEffect(() => {
    if (!confirming) return undefined
    guide.setGate(agent.name, () => { setAsking(true); return false })
    return () => { guide.setGate(agent.name, undefined) }
  }, [confirming, guide, agent.name])
  useEffect(() => { if (asking) question.current?.focus() }, [asking])
  const settle = (add: boolean): void => {
    setConfirming(false)
    setAsking(false)
    if (add) void bundles.install(agent.name)
  }
  const bundleState = useBundle(services, agent.name)?.state
  // One state line at a time: the sign-in shows only once the package's own state (checking, adding, failed, not included) is settled.
  const showSignIn = bundleState === 'available' || bundleState === 'installed' || bundleState === 'restart'
  return (
    <BundleCard name={agent.name} title={title} description={t(`agents.${agent.key}.description`)} services={services} onAdd={() => { setConfirming(true) }}>
      {showSignIn && (
        <StateLine tone={loading ? 'loading' : signIn === undefined ? 'info' : SIGN_IN_TONES[signIn]}>
          {loading ? t('agents.signIn.checking') : signIn === undefined ? t('agents.signIn.unread') : t(`agents.${agent.key}.signIn.${signIn}`)}
        </StateLine>
      )}
      {asking && (
        <div ref={question} tabIndex={-1} className={css.confirm} role="alertdialog" aria-label={t('agents.ask', { name: title })}>
          <p className={css.lead}>{t('agents.ask', { name: title })}</p>
          <div className={css.actions}>
            <Button variant="primary" size="sm" className={css.target} onClick={() => { settle(true) }}>{t('agents.ask.add')}</Button>
            <Button variant="ghost" size="sm" className={css.target} onClick={() => { settle(false) }}>{t('agents.ask.skip')}</Button>
          </div>
        </div>
      )}
      {confirming && !asking && (
        <div className={css.confirm} role="group" data-confirming="" aria-label={t('agents.confirm.label', { name: title })}>
          <ul className={css.facts}>
            <li>{t('agents.confirm.handoff')}</li>
            <li>{t('agents.confirm.limits')}</li>
            <li>{t('agents.confirm.outside')}</li>
            <li>{t('agents.confirm.files')}</li>
            <li>{t('agents.confirm.billing')}</li>
          </ul>
          <div className={css.actions}>
            <Button variant="primary" size="sm" className={css.target} onClick={() => { setConfirming(false); void bundles.install(agent.name) }}>{t('bundle.addNamed', { name: title })}</Button>
            <Button variant="ghost" size="sm" className={css.target} onClick={() => { setConfirming(false) }}>{t('chooser.cancel')}</Button>
          </div>
        </div>
      )}
    </BundleCard>
  )
}

/**
 * @param props - the services and the guide.
 * @returns the step body.
 */
export function AgentsStep({ services, guide }: StepProps): ReactNode {
  const { t } = services
  useRefresh(services, AGENT_BUNDLES.map(each => each.name))
  return (
    <div className={css.stack}>
      <p className={css.lead}>{t('agents.lead')}</p>
      <ul className={css.cards}>
        {AGENT_BUNDLES.map(agent => <AgentCard key={agent.name} agent={agent} services={services} guide={guide} />)}
      </ul>
      <p className={css.hint}>{t('agents.later')}</p>
    </div>
  )
}
