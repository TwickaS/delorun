/**
 * The Permissions settings section: every grant the person gave at the home's own computer, each with a one-click
 * revoke. Full access lists the workspaces that hold a grant, with the other workspaces behind a disclosure where full
 * access is allowed through the consent; revoking drops the workspace and its open full-access chats back to the safer
 * preset. MCP servers lists the servers waiting for the person's OK, each opening the review or declined in place, the
 * servers the person declined or revoked, which stay stopped until allowed, and the allowed servers with their starts;
 * revoking one stops that server until the person allows it again. Every request goes to the home through the injected `fetch`; the home answers only its own
 * computer, and the section says in place on a remote studio that the answer is given at the computer. Each answer's
 * outcome is one line above the groups, which no list owns, so a list that changes after the answer does not take it
 * with it, and nothing covers the Settings dialog.
 */
import { useCallback, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ConfigFormSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import {
  declineServer, FULL_ACCESS_PRESET, MCP_ASK_MODES, readEverywhere, readServers, readWorkspaces, revokeServer, setFullAccess, turnEverywhereOff,
  type AcceptedServer, type EverywhereAnswer, type McpAskMode, type McpConsentSettings, type PendingServer, type PendingServersAnswer, type WorkspaceAccess, type WorkspacesAnswer,
} from './consents-api.ts'
import { consentFailureOf, consentFailureText, FULL_ACCESS_COMMAND, workspaceName, type FullAccessConsentSource } from './FullAccessConsent.tsx'
import { serverChangeText, ServerStart, type McpReviewSource } from './McpServerReview.tsx'
import type { HostFetch } from './host-api.ts'
import type { OptInMutation } from './opt-in.ts'
import { formatTime, listLine, readListing, type GroupProps, type Listing } from './ConsentListing.tsx'
import { SettingsCard } from '@delorun/settings-controls'
import css from './ConsentSections.module.css'

/** The command the remote line names for the home's own computer. */
export const MCP_COMMAND = 'delorun mcp list'

/** The command that turns dangerous mode off, which the Settings card names. */
const SETUP_PROMPTS_COMMAND = 'delorun setup prompts'

/** What the plugin supplies the section. */
export interface PermissionsSectionInjected {
  /** Sends the section's same-origin requests: the browser's `fetch`, or a spec's fake. */
  fetch: HostFetch
  /** Shows the full-access consent and waits for the person's answer. */
  ask: FullAccessConsentSource['ask']
  /** Shows a waiting MCP server's review and waits for the person's answer. */
  review: McpReviewSource['ask']
  hooks: {
    /** The MCP consent row's Host settings form. */
    mcpConsent: ObservableSnapshot<ConfigFormSnapshot<McpConsentSettings>>
    /** The write state of the row's `ask` field. */
    mcpConsentMutation: ObservableSnapshot<OptInMutation>
  }
  /**
   * Write which MCP servers ask first.
   * @param mode - the mode the person chose.
   * @returns after the write settles.
   */
  setMcpAsk(mode: McpAskMode): Promise<void>
}

/** Props the renderer binds for the section. */
export type PermissionsSectionProps = PropsRuntime<'settings.section'> & PropsLocale<'delorunConsents'> & InjectFace<PermissionsSectionInjected>

/**
 * Render the section.
 * @param props - the copy, the request function, the consent and the review.
 * @returns the section.
 */
export function PermissionsSection({ t, fetch, ask, review, useMcpConsent, useMcpConsentMutation, setMcpAsk }: PermissionsSectionProps): ReactNode {
  const mcpConsent = useMcpConsent(value => value)
  const mcpConsentMutation = useMcpConsentMutation(value => value)
  const [workspaces, setWorkspaces] = useState<Listing<WorkspacesAnswer>>({ kind: 'loading' })
  const [servers, setServers] = useState<Listing<PendingServersAnswer>>({ kind: 'loading' })
  const [everywhere, setEverywhere] = useState<EverywhereAnswer>({ on: false })
  const [busy, setBusy] = useState(false)
  const [outcome, setOutcome] = useState<{ readonly text: string; readonly failed: boolean } | undefined>()

  const refresh = useCallback(async (): Promise<void> => {
    // Dangerous mode is read on its own route, which a remote studio may read too.
    const [nextWorkspaces, nextServers, nextEverywhere] = await Promise.all([readListing(t, () => readWorkspaces(fetch)), readListing(t, () => readServers(fetch)), readEverywhere(fetch)])
    setEverywhere(nextEverywhere)
    setWorkspaces(nextWorkspaces)
    setServers(nextServers)
  }, [fetch, t])
  useEffect(() => { void refresh() }, [refresh])

  const answer = async (action: () => Promise<string | undefined>, failureAction: 'action.changeAccess' | 'action.answerServer'): Promise<void> => {
    setBusy(true)
    setOutcome(undefined)
    try {
      const text = await action()
      if (text !== undefined) setOutcome({ text, failed: false })
    } catch (error) {
      setOutcome({ text: consentFailureText(t, consentFailureOf(error), failureAction), failed: true })
    } finally {
      setBusy(false)
    }
    await refresh()
  }

  const allowWorkspace = (access: WorkspaceAccess): Promise<void> =>
    answer(async () => { await ask(access); return undefined }, 'action.changeAccess')
  const revokeWorkspace = (access: WorkspaceAccess): Promise<void> => answer(async () => {
    const change = await setFullAccess(fetch, access, false)
    return t('access.revoked', { workspace: workspaceName(access), count: String(change.chats) })
  }, 'action.changeAccess')
  const turnOff = (): Promise<void> => answer(async () => {
    await turnEverywhereOff(fetch)
    return t('everywhere.turnedOff')
  }, 'action.changeAccess')
  const reviewServer = (server: PendingServer): Promise<void> => answer(async () => {
    const started = await review(server)
    if (started === undefined) return undefined
    return t(started > 0 ? 'mcp.started' : 'mcp.acceptedLater', { server: server.serverName })
  }, 'action.answerServer')
  const declineWaiting = (server: PendingServer): Promise<void> => answer(async () => {
    await declineServer(fetch, server)
    return t('mcp.declined', { server: server.serverName })
  }, 'action.answerServer')
  const revokeAccepted = (accepted: AcceptedServer): Promise<void> => answer(async () => {
    const { stopped } = await revokeServer(fetch, accepted)
    return t('mcp.revoked', { count: String(stopped) })
  }, 'action.answerServer')

  const remote = workspaces.kind === 'remote' || servers.kind === 'remote'

  return <div className={css.section}>
    <h2 className={css.heading}>{t('permissions.title')}</h2>
    {outcome === undefined ? null : <p className={outcome.failed ? css.failed : css.line} role={outcome.failed ? 'alert' : 'status'}>{outcome.text}</p>}
    {remote && everywhere.on ? <p className={css.line} role="status">{t('confirmHere')}</p> : null}
    {remote && !everywhere.on
      ? <p className={css.line} role="status">{t('permissions.remote')} <code className={css.command}>{FULL_ACCESS_COMMAND}</code> <code className={css.command}>{MCP_COMMAND}</code></p>
      : null}
    {everywhere.on || everywhere.problem !== undefined
      ? <SettingsCard title={t('everywhere.heading')} group="dangerous-mode">
        {everywhere.on
          ? <div className={css.row} data-dangerous-mode="on">
            <div className={css.details}>
              <div className={css.title}>{t('everywhere.on')}</div>
              {everywhere.grantedAt === undefined ? null : <div className={css.description}>{t('everywhere.since', { time: formatTime(t, Date.parse(everywhere.grantedAt)) })}</div>}
              <div className={css.description}>{t('everywhere.howBefore')} <code className={css.command}>{SETUP_PROMPTS_COMMAND}</code>{t('everywhere.howAfter')}</div>
            </div>
            <Button variant="outline" size="sm" disabled={busy} onClick={() => { void turnOff() }}>{t('everywhere.off')}</Button>
          </div>
          : <p className={css.boxFailed} role="alert">{t('everywhere.problem', { problem: everywhere.problem ?? '' })}</p>}
      </SettingsCard>
      : null}
    <SettingsCard title={t('access.heading')} description={t('access.description')} group="full-access">
      <FullAccessGroup t={t} listing={workspaces} busy={busy} allow={allowWorkspace} revoke={revokeWorkspace} />
    </SettingsCard>
    <SettingsCard title={t('mcp.heading')} description={t('mcp.description')} group="mcp">
      <McpAskChoice t={t} form={mcpConsent} mutation={mcpConsentMutation} set={setMcpAsk} />
      <ServersGroup t={t} listing={servers} busy={busy} review={reviewServer} decline={declineWaiting} revoke={revokeAccepted} />
    </SettingsCard>
  </div>
}

/**
 * The choice of which MCP servers ask first, written to the `ask` field of the MCP consent row. A reach device is refused
 * the write by the Host, so the failure line says so in place. The shown value is the one the Host accepted; absent, the
 * default `outside`.
 * @param props - the copy, the row's form and write state, and the writer.
 * @returns the choice, or nothing while the profile does not serve the row.
 */
function McpAskChoice({ t, form, mutation, set }: {
  readonly t: PermissionsSectionProps['t']
  readonly form: ConfigFormSnapshot<McpConsentSettings>
  readonly mutation: OptInMutation
  readonly set: PermissionsSectionInjected['setMcpAsk']
}): ReactNode {
  if (form.status === 'unavailable' || form.value === undefined) return null
  const chosen: McpAskMode = form.value.ask ?? 'outside'
  const disabled = mutation.busy || form.status !== 'ready' || !form.writable
  return <div className={css.askChoice} role="radiogroup" aria-label={t('mcp.ask.title')} data-mcp-ask={chosen}>
    <h4 className={css.label}>{t('mcp.ask.title')}</h4>
    {MCP_ASK_MODES.map(mode => <label key={mode} className={css.askOption}>
      <input type="radio" name="mcp-ask" value={mode} checked={chosen === mode} disabled={disabled}
        onChange={() => { if (chosen !== mode) void set(mode) }} />
      <span className={css.details}>
        <span className={css.title}>{t(`mcp.ask.${mode}.title`)}</span>
        <span className={css.description}>{t(`mcp.ask.${mode}.description`)}</span>
      </span>
    </label>)}
    {mutation.failed ? <p className={css.failed} role="alert">{t('mcp.ask.failed')}</p> : null}
  </div>
}

/**
 * The full-access group: the workspaces that hold a grant, then the others behind a disclosure.
 * @param props - the group's list and its answers.
 * @returns the group's content.
 */
function FullAccessGroup({ t, listing, busy, allow, revoke }: GroupProps<WorkspacesAnswer> & {
  readonly allow: (access: WorkspaceAccess) => Promise<void>
  readonly revoke: (access: WorkspaceAccess) => Promise<void>
}): ReactNode {
  if (listing.kind !== 'ready') return listLine(t, listing, 'access.unavailable')
  const granted = listing.value.workspaces.filter(access => access.grantedAt !== null)
  const others = listing.value.workspaces.filter(access => access.grantedAt === null)
  const row = (access: WorkspaceAccess, action: ReactNode): ReactNode => <li key={access.workspace} className={css.row} data-workspace={access.workspace}>
    <div className={css.details}>
      <div className={css.title}>{workspaceName(access)}</div>
      <div className={css.description}>{access.workspace}</div>
      {access.grantedAt === null ? null : <div className={css.description} data-full-access="on">{t('access.granted', { time: formatTime(t, access.grantedAt) })}</div>}
      {access.grantedAt !== null && access.preset === FULL_ACCESS_PRESET ? <div className={css.description}>{t('access.newChats')}</div> : null}
    </div>
    {action}
  </li>
  return <>
    {listing.value.storeProblem === undefined ? null : <p className={css.boxFailed} role="alert">{t('access.storeProblem', { problem: listing.value.storeProblem })}</p>}
    {granted.length === 0
      ? <p className={css.boxLine}>{t('access.none')}</p>
      : <ul className={css.list}>
        {granted.map(access => row(access, <Button variant="outline" size="sm" disabled={busy} onClick={() => { void revoke(access) }}>{t('access.revoke')}</Button>))}
      </ul>}
    {others.length === 0 ? null : <details className={css.others} data-others="">
      <summary>{t('access.others', { count: String(others.length) })}</summary>
      <ul className={css.list}>
        {others.map(access => row(access, <Button variant="outline" size="sm" disabled={busy} onClick={() => { void allow(access) }}>{t('access.allow')}</Button>))}
      </ul>
    </details>}
  </>
}

/**
 * The MCP servers group: the servers waiting for the person's OK, then the allowed starts.
 * @param props - the group's list and its answers.
 * @returns the group's content.
 */
function ServersGroup({ t, listing, busy, review, decline, revoke }: GroupProps<PendingServersAnswer> & {
  readonly review: (server: PendingServer) => Promise<void>
  readonly decline: (server: PendingServer) => Promise<void>
  readonly revoke: (accepted: AcceptedServer) => Promise<void>
}): ReactNode {
  if (listing.kind !== 'ready') return listLine(t, listing, 'mcp.unavailable')
  const { servers, accepted } = listing.value
  if (servers.length === 0 && accepted.length === 0) return <p className={css.boxLine}>{t('mcp.none')}</p>
  const waiting = servers.filter(server => server.state === 'waiting')
  const stopped = servers.filter(server => server.state !== 'waiting')
  return <>
    {waiting.length === 0 ? null : <>
      <h4 className={css.label}>{t('mcp.waiting')}</h4>
      <ul className={css.list}>
        {waiting.map(server => <li key={server.serverName} className={css.row} data-server={server.serverName}>
          <div className={css.details}>
            <div className={css.title}>{server.serverName}</div>
            <div className={css.description} data-change={server.change}>{serverChangeText(t, server)}</div>
          </div>
          <div className={css.buttons}>
            <Button variant="primary" size="sm" disabled={busy} onClick={() => { void review(server) }}>{t('mcp.review')}</Button>
            <Button variant="outline" size="sm" disabled={busy} onClick={() => { void decline(server) }}>{t('mcp.decline')}</Button>
          </div>
        </li>)}
      </ul>
    </>}
    {stopped.length === 0 ? null : <>
      <h4 className={css.label}>{t('mcp.stopped')}</h4>
      <ul className={css.list}>
        {stopped.map(server => <li key={server.serverName} className={css.row} data-server={server.serverName} data-state={server.state}>
          <div className={css.details}>
            <div className={css.title}>{server.serverName}</div>
            <div className={css.description}>{t(server.state === 'declined' ? 'mcp.state.declined' : 'mcp.state.revoked')}</div>
          </div>
          <Button variant="outline" size="sm" disabled={busy} onClick={() => { void review(server) }}>{t('mcp.allow')}</Button>
        </li>)}
      </ul>
    </>}
    {accepted.length === 0 ? null : <>
      <h4 className={css.label}>{t('mcp.allowed')}</h4>
      <ul className={css.list}>
        {accepted.map(start => <li key={start.acceptanceId} className={css.row} data-server={start.serverName}>
          <div className={css.details}>
            <div className={css.title}>{start.serverName}</div>
            <div className={css.description}>{t('mcp.allowedAt', { time: formatTime(t, start.acceptedAt) })}</div>
            {start.configured ? null : <div className={css.description}>{t('mcp.unused')}</div>}
            <details className={css.disclosure}>
              <summary>{t('mcp.details')}</summary>
              <ServerStart t={t} start={start} />
            </details>
          </div>
          <Button variant="outline" size="sm" disabled={busy} onClick={() => { void revoke(start) }}>{t('mcp.revoke')}</Button>
        </li>)}
      </ul>
    </>}
  </>
}
