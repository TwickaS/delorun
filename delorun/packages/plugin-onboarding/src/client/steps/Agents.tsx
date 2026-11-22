/**
 * Agents: Claude Code and Codex, each with how a chat uses it, a use-at-your-own-risk warning and its sign-in on this
 * computer. One Add takes the defaults.
 */
import { useState } from 'react'
import type { ReactNode } from 'react'
import { AgentLimits, runCheck, signInText, type AccountFigures } from '@delorun/bundle-local/agent-limits'
import type { AgentSignIn } from '../../wire.ts'
import { StateLine, type StateTone } from '../ui/StateLine.tsx'
import { AgentAdvanced } from './AgentAdvanced.tsx'
import { CommandRow } from '../ui/CommandRow.tsx'
import { Disclosure } from '../ui/Disclosure.tsx'
import { BundleCard } from './BundleCard.tsx'
import { keepSignInTogether, useBundle, useRefresh, useStore, type StepProps } from './shared.ts'
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
const SIGN_IN_TONES: Readonly<Record<AgentSignIn, StateTone>> = { found: 'info', missing: 'info', unknown: 'info' }

/** Where the guide explains how a chat uses an agent. */
export const AGENTS_GUIDE_URL = 'https://docs.delorun.com/guide/everyday-use/agents'

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
  const added = bundleState === 'installed' || bundleState === 'restart'
  const stored = readiness.status === 'ready' ? readiness.value.accounts : undefined
  const [checked, setChecked] = useState<{ readonly record: AccountFigures; readonly now: number } | undefined>()
  const account: AccountFigures | undefined = checked?.record ?? stored?.agents.find(each => each.provider === agent.agent)
  const now = checked?.now ?? stored?.now ?? 0
  // The store's answer outranks the file hint once a check has said; before it, the hint stands in.
  const known = account === undefined ? undefined : signInText(t, account)
  const storeSignedOut = account?.signedIn === 'no'
  // The sign-in stays visible while the package is added; it hides while the package's own state is checking, failed or not available.
  const showSignIn = bundleState === 'available' || bundleState === 'installing' || bundleState === 'slow' || added
  return (
    <BundleCard name={agent.name} title={title} description={keepSignInTogether(t(`agents.${agent.key}.description`))} services={services}>
      <p className={css.how}>
        {keepSignInTogether(t(`agents.${agent.key}.how`))}{' '}
        <a href={AGENTS_GUIDE_URL} target="_blank" rel="noopener noreferrer">{t('agents.guide')}</a>
      </p>
      <Disclosure label={t('agents.permissions')} size="quiet">
        <p className={css.how}>{keepSignInTogether(t(`agents.${agent.key}.permissions`))}</p>
      </Disclosure>
      {bundleState !== undefined && bundleState !== 'checking' && bundleState !== 'unavailable' && !added && <p className={css.how}>{t('agents.download', { size: String(agent.downloadMb) })}</p>}
      <StateLine tone="warning">{t(`agents.${agent.key}.risk`)}</StateLine>
      {showSignIn && (
        <StateLine tone={loading ? 'loading' : known !== undefined ? (storeSignedOut ? 'warning' : 'success') : signIn === undefined ? 'info' : SIGN_IN_TONES[signIn]}>
          {loading ? t('agents.signIn.checking') : known ?? (signIn === undefined ? t('agents.signIn.unread') : t(`agents.${agent.key}.signIn.${signIn}`))}
        </StateLine>
      )}
      {showSignIn && !loading && (storeSignedOut || (known === undefined && signIn === 'missing')) && <CommandRow command={`delorun agents login ${agent.agent}`} t={t} />}
      {added && account !== undefined && (
        <AgentLimits account={{ ...account, installed: true }} now={now} t={t}
          check={async (provider) => {
            const result = await runCheck(services.pin.fetch, t, provider)
            if (result.kind === 'done') setChecked({ record: result.record, now: result.now })
            return result.note
          }} />
      )}
      <AgentAdvanced agent={agent.agent} title={title} services={services} added={added} />
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
