/**
 * Agents: Claude Code and Codex, each with its sign-in on this computer, added only after the person reads what adding
 * one means and confirms.
 */
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import { useState } from 'react'
import type { ReactNode } from 'react'
import type { AgentSignIn } from '../../wire.ts'
import { StateLine, type StateTone } from '../ui/StateLine.tsx'
import { BundleCard } from './BundleCard.tsx'
import { useRefresh, useStore, type StepProps } from './shared.ts'
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
  const title = t(`agents.${agent.key}.title`)
  const signIn = readiness.status === 'ready' ? readiness.value.agents[agent.agent] : undefined
  const loading = readiness.status === 'loading'
  return (
    <BundleCard name={agent.name} title={title} description={t(`agents.${agent.key}.description`)} services={services} onAdd={() => { setConfirming(true) }}>
      <StateLine tone={loading ? 'loading' : signIn === undefined ? 'info' : SIGN_IN_TONES[signIn]}>
        {loading ? t('agents.signIn.checking') : signIn === undefined ? t('agents.signIn.unread') : t(`agents.${agent.key}.signIn.${signIn}`)}
      </StateLine>
      {confirming && (
        <div className={css.confirm} role="group" aria-label={t('agents.confirm.label', { name: title })}>
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
