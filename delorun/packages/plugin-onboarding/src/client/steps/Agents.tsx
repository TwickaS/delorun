/**
 * Agents: Claude Code and Codex, each with how a chat uses it, a use-at-your-own-risk warning and its sign-in on this
 * computer. One Add takes the defaults.
 */
import type { ReactNode } from 'react'
import type { AgentSignIn } from '../../wire.ts'
import { StateLine, type StateTone } from '../ui/StateLine.tsx'
import { AgentAdvanced } from './AgentAdvanced.tsx'
import { BundleCard } from './BundleCard.tsx'
import { useBundle, useRefresh, useStore, type StepProps } from './shared.ts'
import css from './steps.module.css'

/**
 * The delegation bundles the agents step offers, by package name, the key of their copy, their connection id and the
 * size of the pinned program Add downloads for this platform, in megabytes.
 */
export const AGENT_BUNDLES = [
  { name: '@deepseek-ai/dsh-subagent-claude-code', key: 'claude', agent: 'claude-code', downloadMb: 206 },
  { name: '@deepseek-ai/dsh-subagent-codex', key: 'codex', agent: 'codex', downloadMb: 320 },
] as const

/** The state line of an agent's sign-in. */
const SIGN_IN_TONES: Readonly<Record<AgentSignIn, StateTone>> = { found: 'success', missing: 'warning', unknown: 'info' }

/** Where the guide explains how a chat uses an agent. */
export const AGENTS_GUIDE_URL = 'https://docs.delorun.com/guide/agents'

/**
 * One coding agent: how a chat uses it, the use-at-your-own-risk warning, where its sign-in stands and one Add that
 * takes the defaults. The first hand-off in a workspace asks for its own consent at the computer.
 * @param props - the agent and the services.
 * @returns the card.
 */
function AgentCard({ agent, services, guide }: { readonly agent: typeof AGENT_BUNDLES[number] } & StepProps): ReactNode {
  const { t } = services
  const readiness = useStore(guide.readiness)
  const title = t(`agents.${agent.key}.title`)
  const signIn = readiness.status === 'ready' ? readiness.value.agents[agent.agent] : undefined
  const loading = readiness.status === 'loading'
  const bundleState = useBundle(services, agent.name)?.state
  // One state line at a time: the sign-in shows only once the package's own state (checking, adding, failed, not included) is settled.
  const showSignIn = bundleState === 'available' || bundleState === 'installed' || bundleState === 'restart'
  return (
    <BundleCard name={agent.name} title={title} description={t(`agents.${agent.key}.description`)} services={services}>
      <p className={css.how}>
        {t(`agents.${agent.key}.how`)}{' '}
        <a href={AGENTS_GUIDE_URL} target="_blank" rel="noopener noreferrer">{t('agents.guide')}</a>
      </p>
      {bundleState === 'available' && <p className={css.how}>{t('agents.download', { size: String(agent.downloadMb) })}</p>}
      <StateLine tone="warning">{t(`agents.${agent.key}.risk`)}</StateLine>
      {showSignIn && (
        <StateLine tone={loading ? 'loading' : signIn === undefined ? 'info' : SIGN_IN_TONES[signIn]}>
          {loading ? t('agents.signIn.checking') : signIn === undefined ? t('agents.signIn.unread') : t(`agents.${agent.key}.signIn.${signIn}`)}
        </StateLine>
      )}
      <AgentAdvanced agent={agent.agent} copy={agent.key} title={title} services={services} />
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
