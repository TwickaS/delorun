/**
 * The External agents settings section: the switch that asks before an external agent such as Claude Code runs and its
 * run time limit, both written to the consent plugin's row through its Host settings form, then each agent allowed to
 * start in a workspace without asking, with a one-click revoke that makes it ask again at its next start there. The
 * list and the revoke go to the home through the injected `fetch`; the home answers only its own computer, and the
 * section says in place on a remote studio that the answer is given at the computer. Each answer's outcome is one line
 * above the groups, which no list owns, so a list that changes after the answer does not take it with it.
 */
import { useCallback, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { RUN_TIMEOUT_MINUTES, type DelegationConsentSettings } from '@delorun/plugin-delegation-consent/wire'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import { Button, Input, Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ConfigFormSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { SettingsCard } from '@delorun/settings-controls'
import { readAgentGrants, revokeAgentGrant, type GrantsAnswer, type GrantView } from './consents-api.ts'
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

  const refresh = useCallback(async (): Promise<void> => {
    setAgents(await readListing(t, () => readAgentGrants(fetch)))
  }, [fetch, t])
  useEffect(() => { void refresh() }, [refresh])

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
  // While dangerous mode holds, a remote studio offers the actions; the unlock the home asks for decides them.
  const remote = agents.kind === 'remote' && !dangerous

  return <div className={css.section}>
    <h2 className={css.heading}>{t('agents.title')}</h2>
    {outcome === undefined ? null : <p className={outcome.failed ? css.failed : css.line} role={outcome.failed ? 'alert' : 'status'}>{outcome.text}</p>}
    {remote
      ? <p className={css.line} role="status">{t('agents.remote')} <code className={css.command}>{AGENTS_COMMAND}</code></p>
      : agents.kind === 'remote' ? <p className={css.line} role="status">{t('unlockHere')}</p> : null}
    <AgentSettings t={t} form={agentSettings} mutation={agentSettingsMutation} remote={remote} set={setAgentSetting} />
    <SettingsCard title={t('agents.allowed.heading')} description={t('agents.allowed.description')} group="external-agents">
      <AgentsGroup t={t} listing={agents} busy={busy} revoke={revokeAgent} />
    </SettingsCard>
  </div>
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
          <Button variant="outline" size="sm" disabled={busy} onClick={() => { void revoke(grant) }}>{t('agents.revoke')}</Button>
        </li>)}
      </ul>}
  </>
}

/**
 * The external-agent consent's switch and run time limit, written to the plugin's row. A remote studio cannot write
 * settings, so both are disabled there and the switch says that turning it off needs the home's own computer. The time
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
      <li className={css.row}>
        <div className={css.details}>
          <div className={css.title}>{t('agents.ask.title')}</div>
          <div className={css.description}>{t('agents.ask.description')}</div>
          {remote && form.value.enabled ? <div className={css.description}>{t('agents.ask.computerOnly')}</div> : null}
          {mutation.failed ? <p className={css.failed} role="alert">{t('agents.settings.failed')}</p> : null}
        </div>
        <Switch checked={form.value.enabled} label={t('agents.ask.title')} disabled={disabled}
          onChange={(enabled) => { void set('enabled', enabled) }} />
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
