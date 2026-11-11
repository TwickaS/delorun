/**
 * The Permissions settings section: every grant the person gave at the home's own computer, each with a one-click
 * revoke. Full access lists the workspaces that hold a grant, with the other workspaces behind a disclosure where full
 * access is allowed through the consent; revoking drops the workspace and its open full-access chats back to the safer
 * preset. MCP servers lists the servers waiting for the person's OK, each opening the review or declined in place, and
 * the allowed starts with the configured servers that use them; revoking one stops those servers until the person
 * allows the start again. Every request goes to the home through the injected `fetch`; the home answers only its own
 * computer, and the section says in place on a remote studio that the answer is given at the computer.
 */
import { useCallback, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import {
  declineServer, readServers, readWorkspaces, revokeServer, setFullAccess,
  type AcceptedServer, type PendingServer, type PendingServersAnswer, type WorkspaceAccess, type WorkspacesAnswer,
} from './consents-api.ts'
import { consentFailureOf, consentFailureText, FULL_ACCESS_COMMAND, workspaceName, type FullAccessConsentSource } from './FullAccessConsent.tsx'
import { serverChangeText, ServerStart, type McpReviewSource } from './McpServerReview.tsx'
import type { HostFetch } from './host-api.ts'
import css from './ConsentSections.module.css'

/** The command the remote line names for the home's own computer. */
export const MCP_COMMAND = 'delorun mcp list'

/** What the plugin supplies the section. */
export interface PermissionsSectionInjected {
  /** Sends the section's same-origin requests: the browser's `fetch`, or a spec's fake. */
  fetch: HostFetch
  /** Shows the full-access consent and waits for the person's answer. */
  ask: FullAccessConsentSource['ask']
  /** Shows a waiting MCP server's review and waits for the person's answer. */
  review: McpReviewSource['ask']
}

/** Props the renderer binds for the section. */
export type PermissionsSectionProps = PropsRuntime<'settings.section'> & PropsLocale<'deloConsents'> & InjectFace<PermissionsSectionInjected>

type Translate = PermissionsSectionProps['t']

/** One list's state: not answered yet, answered, not mounted in this profile, remote, or failed with the sentence. */
type Listing<T> =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly value: T }
  | { readonly kind: 'unavailable' }
  | { readonly kind: 'remote' }
  | { readonly kind: 'failed'; readonly text: string }

/** The last answer's sentence, under the row it belongs to. */
type Outcome = { readonly row: string; readonly text: string; readonly failed: boolean } | undefined

/**
 * A moment as the section shows it, in the section's locale.
 * @param t - the copy, whose `time.locale` names the locale.
 * @param at - milliseconds since the epoch.
 * @returns the date and time.
 */
function formatTime(t: Translate, at: number): string {
  return new Intl.DateTimeFormat(t('time.locale'), { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(at))
}

/**
 * Read one list into its state.
 * @param t - the copy.
 * @param read - the request.
 * @returns the state the request answered.
 */
async function listing<T>(t: Translate, read: () => Promise<T | undefined>): Promise<Listing<T>> {
  try {
    const value = await read()
    return value === undefined ? { kind: 'unavailable' } : { kind: 'ready', value }
  } catch (error) {
    const failure = consentFailureOf(error)
    return failure.kind === 'remote' ? { kind: 'remote' } : { kind: 'failed', text: consentFailureText(t, failure) }
  }
}

/**
 * Render the section.
 * @param props - the copy, the request function, the consent and the review.
 * @returns the section.
 */
export function PermissionsSection({ t, fetch, ask, review }: PermissionsSectionProps): ReactNode {
  const [workspaces, setWorkspaces] = useState<Listing<WorkspacesAnswer>>({ kind: 'loading' })
  const [servers, setServers] = useState<Listing<PendingServersAnswer>>({ kind: 'loading' })
  const [outcome, setOutcome] = useState<Outcome>()
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(async (): Promise<void> => {
    const [nextWorkspaces, nextServers] = await Promise.all([listing(t, () => readWorkspaces(fetch)), listing(t, () => readServers(fetch))])
    setWorkspaces(nextWorkspaces)
    setServers(nextServers)
  }, [fetch, t])
  useEffect(() => { void refresh() }, [refresh])

  const answer = async (row: string, action: () => Promise<string | undefined>, failureAction: 'action.changeAccess' | 'action.answerServer'): Promise<void> => {
    setOutcome(undefined)
    setBusy(true)
    try {
      const text = await action()
      if (text !== undefined) setOutcome({ row, failed: false, text })
    } catch (error) {
      setOutcome({ row, failed: true, text: consentFailureText(t, consentFailureOf(error), failureAction) })
    } finally {
      setBusy(false)
    }
    await refresh()
  }

  const allowWorkspace = (access: WorkspaceAccess): Promise<void> =>
    answer(access.workspace, async () => { await ask(access); return undefined }, 'action.changeAccess')
  const revokeWorkspace = (access: WorkspaceAccess): Promise<void> => answer(access.workspace, async () => {
    const change = await setFullAccess(fetch, access, false)
    return t('access.revoked', { workspace: workspaceName(access), count: String(change.chats) })
  }, 'action.changeAccess')
  const reviewServer = (server: PendingServer): Promise<void> => answer(server.serverName, async () => {
    const started = await review(server)
    if (started === undefined) return undefined
    return t(started > 0 ? 'mcp.started' : 'mcp.acceptedLater', { server: server.serverName })
  }, 'action.answerServer')
  const declineWaiting = (server: PendingServer): Promise<void> => answer(server.serverName, async () => {
    await declineServer(fetch, server)
    return t('mcp.declined', { server: server.serverName })
  }, 'action.answerServer')
  const revokeAccepted = (accepted: AcceptedServer): Promise<void> => answer(accepted.command, async () => {
    const { stopped } = await revokeServer(fetch, accepted)
    return t('mcp.revoked', { count: String(stopped) })
  }, 'action.answerServer')

  const remote = workspaces.kind === 'remote' || servers.kind === 'remote'
  const said = (row: string): ReactNode => outcome?.row === row
    ? <div className={outcome.failed ? css.failed : css.description} role={outcome.failed ? 'alert' : 'status'}>{outcome.text}</div>
    : null

  return <div className={css.section}>
    <h2 className={css.heading}>{t('permissions.title')}</h2>
    <p className={css.intro}>{t('permissions.intro')}</p>
    {remote
      ? <p className={css.line} role="status">{t('permissions.remote')} <code className={css.command}>{FULL_ACCESS_COMMAND}</code> <code className={css.command}>{MCP_COMMAND}</code></p>
      : null}
    <section className={css.group} aria-label={t('access.heading')} data-group="full-access">
      <h3 className={css.subheading}>{t('access.heading')}</h3>
      <FullAccessGroup t={t} listing={workspaces} busy={busy} said={said} allow={allowWorkspace} revoke={revokeWorkspace} />
    </section>
    <section className={css.group} aria-label={t('mcp.heading')} data-group="mcp">
      <h3 className={css.subheading}>{t('mcp.heading')}</h3>
      <ServersGroup t={t} listing={servers} busy={busy} said={said} review={reviewServer} decline={declineWaiting} revoke={revokeAccepted} />
    </section>
  </div>
}

/** What a group renders from: the copy, its list, whether an answer is being sent, and the answer's sentence. */
interface GroupProps<T> {
  readonly t: Translate
  readonly listing: Listing<T>
  readonly busy: boolean
  readonly said: (row: string) => ReactNode
}

/**
 * The lines a list shows before its rows: why it has none, or why it could not be read.
 * @param t - the copy.
 * @param listing - the list.
 * @param unavailable - the line for a profile that mounts no list.
 * @returns the line, or nothing for a list that is loading, remote or ready.
 */
function listLine(t: Translate, listing: Listing<unknown>, unavailable: 'access.unavailable' | 'mcp.unavailable'): ReactNode {
  if (listing.kind === 'unavailable') return <p className={css.line}>{t(unavailable)}</p>
  if (listing.kind === 'failed') return <p className={css.failed} role="alert">{listing.text}</p>
  return null
}

/**
 * The full-access group: the workspaces that hold a grant, then the others behind a disclosure.
 * @param props - the group's list and its answers.
 * @returns the group's content.
 */
function FullAccessGroup({ t, listing, busy, said, allow, revoke }: GroupProps<WorkspacesAnswer> & {
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
      {said(access.workspace)}
    </div>
    {action}
  </li>
  return <>
    {listing.value.storeProblem === undefined ? null : <p className={css.failed} role="alert">{t('access.storeProblem', { problem: listing.value.storeProblem })}</p>}
    {granted.length === 0
      ? <p className={css.line}>{t('access.none')}</p>
      : <ul className={css.list}>
        {granted.map(access => row(access, <Button variant="outline" size="sm" disabled={busy} onClick={() => { void revoke(access) }}>{t('access.revoke')}</Button>))}
      </ul>}
    {others.length === 0 ? null : <details className={css.disclosure} data-others="">
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
function ServersGroup({ t, listing, busy, said, review, decline, revoke }: GroupProps<PendingServersAnswer> & {
  readonly review: (server: PendingServer) => Promise<void>
  readonly decline: (server: PendingServer) => Promise<void>
  readonly revoke: (accepted: AcceptedServer) => Promise<void>
}): ReactNode {
  if (listing.kind !== 'ready') return listLine(t, listing, 'mcp.unavailable')
  const { servers, accepted } = listing.value
  if (servers.length === 0 && accepted.length === 0) return <p className={css.line}>{t('mcp.none')}</p>
  return <>
    {servers.length === 0 ? null : <>
      <h4 className={css.label}>{t('mcp.waiting')}</h4>
      <ul className={css.list}>
        {servers.map(server => <li key={server.serverName} className={css.row} data-server={server.serverName}>
          <div className={css.details}>
            <div className={css.title}>{server.serverName}</div>
            <div className={css.description} data-change={server.change}>{serverChangeText(t, server.change)}</div>
            {said(server.serverName)}
          </div>
          <div className={css.buttons}>
            <Button variant="primary" size="sm" disabled={busy} onClick={() => { void review(server) }}>{t('mcp.review')}</Button>
            <Button variant="outline" size="sm" disabled={busy} onClick={() => { void decline(server) }}>{t('mcp.decline')}</Button>
          </div>
        </li>)}
      </ul>
    </>}
    {accepted.length === 0 ? null : <>
      <h4 className={css.label}>{t('mcp.allowed')}</h4>
      <ul className={css.list}>
        {accepted.map(start => <li key={start.command} className={css.row} data-command={start.command}>
          <div className={css.details}>
            <div className={css.title}>{start.servers.length === 0 ? start.command : start.servers.join(', ')}</div>
            <div className={css.description}>{t('mcp.allowedAt', { time: formatTime(t, start.acceptedAt) })}</div>
            {start.servers.length === 0 ? <div className={css.description}>{t('mcp.unused')}</div> : null}
            <details className={css.disclosure}>
              <summary>{t('mcp.details')}</summary>
              <ServerStart t={t} start={start} />
            </details>
            {said(start.command)}
          </div>
          <Button variant="outline" size="sm" disabled={busy} onClick={() => { void revoke(start) }}>{t('mcp.revoke')}</Button>
        </li>)}
      </ul>
    </>}
  </>
}
