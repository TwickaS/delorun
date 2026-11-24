/**
 * The External agents settings section: the switch that asks before an external agent such as Claude Code runs, the
 * switch that lets a Full access chat start one without asking, and the run time limit, each written to the consent plugin's row through its Host settings form, then each agent allowed to
 * start in a workspace without asking, with a one-click revoke that makes it ask again at its next start there. The
 * list and the revoke go to the home through the injected `fetch`; the home answers only its own computer, and the
 * section says in place on a remote studio that the answer is given at the computer. Each answer's outcome is one line
 * above the groups, which no list owns, so a list that changes after the answer does not take it with it.
 */
import { useCallback, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { RUN_TIMEOUT_MINUTES, type AgentLevelView, type DelegationConsentSettings } from '@delorun/plugin-delegation-consent/wire'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import { Input, Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import { Button } from '@delorun/brand'
import type { ConfigFormSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { SettingsCard } from '@delorun/settings-controls'
import { AgentLimits, signInText, useAccounts, type LimitsTranslate } from './AgentLimits.tsx'
import { readAgentGrants, readAgentLevels, revokeAgentGrant, type GrantsAnswer, type GrantView } from './consents-api.ts'
import { AgentLevels } from './AgentLevels.tsx'
import { formatTime, listLine, readListing, type GroupProps, type Listing, type Translate } from './ConsentListing.tsx'
import { consentFailureOf, consentFailureText } from './FullAccessConsent.tsx'
import { useDangerousMode } from './dangerous-mode.ts'
import type { HostFetch } from './host-api.ts'
import type { OptInMutation } from './opt-in.ts'
import css from './ConsentSections.module.css'

/** The command that lists and revokes the external agents allowed per workspace. */
export const AGENTS_COMMAND = 'delorun workspace external-agents'

/** What the plugin supplies the section. */
export interface ExternalAgentsSectionInjected {
  /** Sends the section's same-origin requests: the browser's `fetch`, or a spec's fake. */
  fetch: HostFetch
  hooks: {
    /** The external-agent consent row's Host settings form. */
    agentSettings: ObservableSnapshot<ConfigFormSnapshot<DelegationConsentSettings>>
    /** The write state of that form's fields. */
    agentSettingsMutation: ObservableSnapshot<OptInMutation>
  }
  /**
   * Write one field of the external-agent consent row.
   * @param field - the field.
   * @param value - the value the person chose.
   * @returns after the write settles.
   */
  setAgentSetting<K extends keyof DelegationConsentSettings>(field: K, value: DelegationConsentSettings[K]): Promise<void>
}

/** Props the renderer binds for the section. */
export type ExternalAgentsSectionProps = PropsRuntime<'settings.section'> & PropsLocale<'delorunConsents'> & InjectFace<ExternalAgentsSectionInjected>

/**
 * Render the section.
 * @param props - the copy, the request function, the consent row's form and its writer.
 * @returns the section.
 */
export function ExternalAgentsSection({ t, fetch, useAgentSettings, useAgentSettingsMutation, setAgentSetting }: ExternalAgentsSectionProps): ReactNode {
  const agentSettings = useAgentSettings(value => value)
  const agentSettingsMutation = useAgentSettingsMutation(value => value)
  const [agents, setAgents] = useState<Listing<GrantsAnswer>>({ kind: 'loading' })
  const [busy, setBusy] = useState(false)
  const [outcome, setOutcome] = useState<{ readonly text: string; readonly failed: boolean } | undefined>()

  const [levels, setLevels] = useState<readonly AgentLevelView[]>([])

  const refresh = useCallback(async (): Promise<void> => {
    setAgents(await readListing(t, () => readAgentGrants(fetch)))
  }, [fetch, t])
  useEffect(() => { void refresh() }, [refresh])
  // The levels' sandbox facts come from the home; the saved levels come from the form, which updates at once.
  const savedLevels = agentSettings.value === undefined ? '' : `${agentSettings.value.claudeCodeLevel}/${agentSettings.value.codexLevel}`
  useEffect(() => {
    void readAgentLevels(fetch).then(answer => { setLevels(answer?.levels ?? []) }, () => { setLevels([]) })
  }, [fetch, savedLevels])

  const revokeAgent = async (grant: GrantView): Promise<void> => {
    setBusy(true)
    setOutcome(undefined)
    try {
      await revokeAgentGrant(fetch, grant)
      setOutcome({ text: t('agents.revoked', { agent: grant.agent, workspace: grant.workspace }), failed: false })
    } catch (error) {
      setOutcome({ text: consentFailureText(t, consentFailureOf(error), 'action.changeAgent'), failed: true })
    } finally {
      setBusy(false)
    }
    await refresh()
  }

  const dangerous = useDangerousMode(fetch)
  // While dangerous mode holds, a remote studio offers the actions; each asks for Face ID or the PIN.
  const remote = agents.kind === 'remote' && !dangerous

  return <div className={css.section}>
    <h2 className={css.heading}>{t('agents.title')}</h2>
    {outcome === undefined ? null : <p className={outcome.failed ? css.failed : css.line} role={outcome.failed ? 'alert' : 'status'}>{outcome.text}</p>}
    {remote
      ? <p className={css.line} role="status">{t('agents.remote')} <code className={css.command}>{AGENTS_COMMAND}</code></p>
      : agents.kind === 'remote' ? <p className={css.line} role="status">{t('confirmHere')}</p> : null}
    {agentSettings.value === undefined || agentSettings.status === 'unavailable' ? null : <AgentLevels t={t} saved={agentSettings.value} views={levels} remote={agents.kind === 'remote'}
      disabled={agentSettingsMutation.busy || agentSettings.status !== 'ready' || !agentSettings.writable} set={(field, level) => setAgentSetting(field, level)} />}
    <AgentSettings t={t} form={agentSettings} mutation={agentSettingsMutation} remote={remote} set={setAgentSetting} />
    <PlansAndLimits t={t} fetch={fetch} />
    <SettingsCard title={t('agents.allowed.heading')} description={t('agents.allowed.description')} group="external-agents">
      <AgentsGroup t={t} listing={agents} busy={busy} revoke={revokeAgent} />
    </SettingsCard>
  </div>
}

/**
 * One row per added agent with its sign-in line, bars and "Check now". Reading the figures starts no check.
 * @param props - the copy and the request function.
 * @returns the card, or nothing while the home does not serve the figures.
 */
function PlansAndLimits({ t, fetch }: { readonly t: Translate; readonly fetch: HostFetch }): ReactNode {
  const limitsT: LimitsTranslate = t
  const { state, check } = useAccounts(fetch, limitsT)
  if (state.kind === 'unavailable') return null
  const added = state.kind === 'ready' ? state.accounts.filter(account => account.installed) : []
  return <SettingsCard title={t('agents.limits.heading')} description={t('agents.limits.description')} group="external-agent-limits">
    {state.kind === 'loading'
      ? <p className={css.boxLine}>{t('permissions.loading')}</p>
      : added.length === 0
        ? <p className={css.boxLine}>{t('agents.limits.none')}</p>
        : <ul className={css.list}>
          {added.map(account => <li key={account.provider} className={css.row} data-agent={account.provider}>
            <div className={css.details}>
              <div className={css.title}>{t(`agents.limits.agent.${account.provider}`)}</div>
              <div className={css.description}>{signInText(limitsT, account) ?? t('limits.signInUnknown')}</div>
              <AgentLimits account={account} now={state.now} t={limitsT} check={check} />
            </div>
          </li>)}
        </ul>}
  </SettingsCard>
}

/**
 * The external agents group: each agent allowed to start in a workspace without asking, with its revoke.
 * @param props - the group's list and its revoke.
 * @returns the group's content.
 */
function AgentsGroup({ t, listing, busy, revoke }: GroupProps<GrantsAnswer> & { readonly revoke: (grant: GrantView) => Promise<void> }): ReactNode {
  if (listing.kind !== 'ready') return listLine(t, listing, 'agents.unavailable')
  const { grants, storeProblem } = listing.value
  return <>
    {storeProblem === undefined ? null : <p className={css.boxFailed} role="alert">{t('agents.storeProblem', { problem: storeProblem })}</p>}
    {grants.length === 0
      ? <p className={css.boxLine}>{t('agents.none')}</p>
      : <ul className={css.list}>
        {grants.map(grant => <li key={`${grant.workspace}\n${grant.provider}`} className={css.row} data-agent={grant.provider}>
          <div className={css.details}>
            <div className={css.title}>{grant.agent}</div>
            <div className={css.description}>{grant.workspace}</div>
            <div className={css.description}>{t('agents.allowedAt', { time: formatTime(t, grant.grantedAt) })}</div>
          </div>
          <Button variant="secondary" size="sm" disabled={busy} onClick={() => { void revoke(grant) }}>{t('agents.revoke')}</Button>
        </li>)}
      </ul>}
  </>
}

/**
 * The external-agent consent's two switches and run time limit, written to the plugin's row. A remote studio cannot write
 * settings, so all are disabled there and each switch says which direction needs the home's own computer. The time
 * limit is written once the field loses focus or Enter is pressed, and only as a whole number of minutes within
 * {@link RUN_TIMEOUT_MINUTES}; any other entry goes back to the saved value.
 * @param props - the copy, the row's form and write state, whether the studio is remote, and the writer.
 * @returns the card, or nothing while the profile does not serve the row.
 */
function AgentSettings({ t, form, mutation, remote, set }: {
  readonly t: Translate
  readonly form: ConfigFormSnapshot<DelegationConsentSettings>
  readonly mutation: OptInMutation
  readonly remote: boolean
  readonly set: ExternalAgentsSectionInjected['setAgentSetting']
}): ReactNode {
  const saved = form.value?.runTimeoutMinutes
  const [draft, setDraft] = useState<string | undefined>()
  if (form.status === 'unavailable' || form.value === undefined) return null
  const disabled = remote || mutation.busy || form.status !== 'ready' || !form.writable
  const commit = (): void => {
    const minutes = Number(draft)
    setDraft(undefined)
    if (Number.isInteger(minutes) && minutes >= RUN_TIMEOUT_MINUTES.min && minutes <= RUN_TIMEOUT_MINUTES.max && minutes !== saved) {
      void set('runTimeoutMinutes', minutes)
    }
  }
  return <SettingsCard title={t('agents.settings.heading')} description={t('agents.settings.description')} group="external-agent-settings">
    <ul className={css.list} data-agent-settings="">
      <li className={`${css.row} ${css.switchRow}`}>
        <div className={css.details}>
          <div className={css.title}>{t('agents.ask.title')}</div>
          <div className={css.description}>{t('agents.ask.description')}</div>
          {remote && form.value.enabled ? <div className={css.description}>{t('agents.ask.computerOnly')}</div> : null}
          {mutation.failed ? <p className={css.failed} role="alert">{t('agents.settings.failed')}</p> : null}
        </div>
        <Switch checked={form.value.enabled} label={t('agents.ask.title')} disabled={disabled}
          onChange={(enabled) => { void set('enabled', enabled) }} />
      </li>
      <li className={`${css.row} ${css.switchRow}`}>
        <div className={css.details}>
          <div className={css.title}>{t('agents.fullAccess.title')}</div>
          <div className={css.description}>{t('agents.fullAccess.description')}</div>
          {remote && !form.value.fullAccessStartsAgents ? <div className={css.description}>{t('agents.fullAccess.computerOnly')}</div> : null}
        </div>
        <Switch checked={form.value.fullAccessStartsAgents} label={t('agents.fullAccess.title')} disabled={disabled}
          onChange={(fullAccessStartsAgents) => { void set('fullAccessStartsAgents', fullAccessStartsAgents) }} />
      </li>
      <li className={css.row}>
        <div className={css.details}>
          <div className={css.title}>{t('agents.limit.title')}</div>
          <div className={css.description}>{t('agents.limit.description', { min: String(RUN_TIMEOUT_MINUTES.min), max: String(RUN_TIMEOUT_MINUTES.max) })}</div>
        </div>
        <span className={css.minutes}>
          <Input type="number" inputMode="numeric" aria-label={t('agents.limit.title')} disabled={disabled}
            min={RUN_TIMEOUT_MINUTES.min} max={RUN_TIMEOUT_MINUTES.max} step={1} value={draft ?? String(saved)}
            onChange={(event) => { setDraft(event.currentTarget.value) }}
            onBlur={commit}
            onKeyDown={(event) => { if (event.key === 'Enter') commit() }} />
        </span>
      </li>
    </ul>
  </SettingsCard>
}
