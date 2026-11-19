/**
 * Renders one picture of the plan-limits surfaces: `?view=card|settings|pill|pill-open&state=healthy|near|reached|signedout|old&scheme=light|dark`.
 * The Settings card and the Plans pill are the real components over a fake home; the agent card is the onboarding card
 * and state line around the real limit bars.
 */
import { StrictMode, useEffect, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { ConfigFormSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'
import { ACCOUNT_ROUTES, type AccountView } from '@delorun/external-agents/accounts/wire'
import { AgentLimits, signInText, type LimitsTranslate } from '../../bundle-local/src/client/AgentLimits.tsx'
import { en as consentsEn } from '../../bundle-local/src/client/consents-locales.ts'
import { ExternalAgentsSection, type ExternalAgentsSectionProps } from '../../bundle-local/src/client/ExternalAgentsSection.tsx'
import { Card } from '../../plugin-onboarding/src/client/ui/Card.tsx'
import { StateLine } from '../../plugin-onboarding/src/client/ui/StateLine.tsx'
import tokens from '../../plugin-onboarding/src/client/frame/tokens.module.css'
import { PlansPill, type PlansPillProps } from '../src/client/PlansPill.tsx'
import { en as costEn } from '../src/client/locales.ts'
import './gallery.css'

const params = new URLSearchParams(location.search)
const view = params.get('view') ?? 'card'
const state = params.get('state') ?? 'healthy'
const scheme = params.get('scheme') ?? 'light'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const now = Date.now()

/**
 * @param kind - the window kind.
 * @param used - the used share.
 * @param ageMs - how long ago the figures were seen.
 * @param resetsIn - when the window resets, from now.
 * @returns a stored window.
 */
function window(kind: string, used: number, ageMs: number, resetsIn: number): AccountView['windows'][number] {
  return { kind, usedPercent: used, status: used >= 100 ? 'reached' : used >= 80 ? 'near' : 'allowed', seenAt: now - ageMs, resetsAt: now + resetsIn, source: 'probe' }
}

/**
 * @param name - the picture's state.
 * @returns the seeded figures for Claude Code and Codex.
 */
function seeded(name: string): AccountView[] {
  const claude = (change: Partial<AccountView>): AccountView => ({ provider: 'claude-code', installed: true, signedIn: 'yes', plan: 'max', checkedAt: now - 2 * MINUTE, windows: [], ...change })
  const codex: AccountView = { provider: 'codex', installed: true, signedIn: 'yes', plan: 'plus', checkedAt: now - 2 * MINUTE, windows: [window('window_300m', 24, 2 * MINUTE, 3 * HOUR), window('window_10080m', 41, 2 * MINUTE, 80 * HOUR)] }
  switch (name) {
    case 'near': return [claude({ windows: [window('five_hour', 86, 2 * MINUTE, 70 * MINUTE), window('seven_day', 38, 2 * MINUTE, 52 * HOUR)] }), codex]
    case 'reached': return [claude({ windows: [window('five_hour', 100, 2 * MINUTE, 95 * MINUTE), window('seven_day', 63, 2 * MINUTE, 52 * HOUR)] }), codex]
    case 'signedout': return [claude({ signedIn: 'no', windows: [] }), { ...codex, signedIn: 'no', windows: [] }]
    case 'old': return [claude({ checkedAt: now - 2 * HOUR, windows: [window('five_hour', 52, 2 * HOUR, 20 * MINUTE), window('seven_day', 31, 2 * HOUR, 52 * HOUR)] }), codex]
    default: return [claude({ windows: [window('five_hour', 32, 2 * MINUTE, 3 * HOUR), window('seven_day', 12, 2 * MINUTE, 50 * HOUR)] }), codex]
  }
}

const accounts = seeded(state)

/** A fake home: the stored figures, and a check that answers "checked". */
const fetch = (input: string, init?: RequestInit): Promise<Response> => {
  if (input !== ACCOUNT_ROUTES.refresh && input !== ACCOUNT_ROUTES.accounts) return Promise.resolve(new Response(JSON.stringify({ error: 'NOT_FOUND', message: 'No such route' }), { status: 404 }))
  const body = input === ACCOUNT_ROUTES.refresh
    ? { outcome: { kind: 'checked' }, record: accounts[0], now: Date.now() }
    : { accounts, now: Date.now() }
  void init
  return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }))
}

/**
 * @param dictionary - English strings with `{name}` placeholders.
 * @returns a translate function over them.
 */
function translator(dictionary: Readonly<Record<string, string>>): (key: string, values?: Readonly<Record<string, string>>) => string {
  return (key, values) => (dictionary[key] ?? key).replaceAll(/\{(\w+)\}/gu, (_all, name: string) => values?.[name] ?? '')
}

const limitsT = translator(costEn) as LimitsTranslate
const claudeCard = accounts[0]!

/** @returns the onboarding agent card around the real limit bars. */
function AgentCard(): ReactNode {
  const line = signInText(limitsT, claudeCard) ?? 'Signed in'
  return (
    <div className={tokens.scale}>
      <Card title="Claude Code" monogram="C" description="Hand a coding task to Claude Code from a chat." labels={{ more: 'More', less: 'Less' }}
        action={<span>Added</span>}>
        <StateLine tone="warning">Use it at your own risk: it runs under your own account and that provider's terms, outside Delorun's sandbox and prompts.</StateLine>
        <StateLine tone={claudeCard.signedIn === 'no' ? 'warning' : 'success'}>{line}</StateLine>
        {claudeCard.signedIn === 'no' && <StateLine tone="info"><code>delorun agents login claude-code</code></StateLine>}
        <AgentLimits account={claudeCard} now={now} t={limitsT} check={() => Promise.resolve({ text: 'Checked.', failed: false })} />
      </Card>
    </div>
  )
}

/** @returns the real Settings section over the fake home. */
function Settings(): ReactNode {
  const form = createSnapshotStore<ConfigFormSnapshot<never>>({ status: 'unavailable', value: undefined, base: undefined, user: undefined, revision: 0, writable: true })
  const mutation = createSnapshotStore({ busy: false, failed: false })
  const select = <S, T>(store: { getSnapshot(): S }) => (pick: (value: S) => T): T => pick(store.getSnapshot())
  const props = {
    t: translator(consentsEn), close: () => {}, fetch,
    useAgentSettings: select(form), useAgentSettingsMutation: select(mutation), setAgentSetting: async () => {},
  } as ExternalAgentsSectionProps
  return <ExternalAgentsSection {...props} />
}

/**
 * @param props - whether to open the popover once shown.
 * @returns the pill in a composer dock.
 */
function Pill({ open }: { readonly open: boolean }): ReactNode {
  useEffect(() => {
    if (!open) return
    const timer = setInterval(() => {
      const button = document.querySelector<HTMLButtonElement>('[data-composer-stat="plans"] button')
      if (button === null) return
      clearInterval(timer)
      button.click()
    }, 100)
    return () => { clearInterval(timer) }
  }, [open])
  return <div className="dock"><PlansPill fetch={fetch} t={translator(costEn) as PlansPillProps['t']} /></div>
}

if (scheme === 'dark') document.body.setAttribute('data-ds-dark-theme', '')
const page = view === 'settings' ? <Settings /> : view === 'pill' ? <Pill open={false} /> : view === 'pill-open' ? <Pill open /> : <AgentCard />
createRoot(document.getElementById('root')!).render(<StrictMode><div className="stage">{page}</div></StrictMode>)
