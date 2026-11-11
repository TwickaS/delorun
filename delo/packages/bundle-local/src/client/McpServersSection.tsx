/**
 * The MCP servers settings section: each stdio MCP server whose start the add-time consent holds stopped, with what
 * the server would run — the command, its arguments, its working directory and the names of its configured environment
 * variables, never their values — and why it waits. The person accepts a server, after a confirmation that names what
 * acceptance allows, or declines it. Every request goes to the home through the injected `fetch`; the home answers only
 * its own computer, and the section says so in place on a remote studio.
 */
import { useCallback, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { acceptServer, declineServer, readPendingServers, type PendingServer } from './consents-api.ts'
import { consentFailureOf, consentFailureText } from './FullAccessConsent.tsx'
import type { HostFetch } from './host-api.ts'
import css from './ConsentSections.module.css'

/** The command the remote notice names for the home's own computer. */
export const MCP_COMMAND = 'delorun mcp list'

/** What the plugin supplies the section. */
export interface McpServersSectionInjected {
  /** Sends the section's same-origin requests: the browser's `fetch`, or a spec's fake. */
  fetch: HostFetch
}

/** Props the renderer binds for the section. */
export type McpServersSectionProps = PropsRuntime<'settings.section'> & PropsLocale<'deloConsents'> & InjectFace<McpServersSectionInjected>

type Translate = McpServersSectionProps['t']

/** The list's state: not answered yet, answered, not mounted in this profile, remote, or failed with the sentence. */
type Listing =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly servers: readonly PendingServer[] }
  | { readonly kind: 'unavailable' }
  | { readonly kind: 'remote' }
  | { readonly kind: 'failed'; readonly text: string }

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
 * Render the section.
 * @param props - the copy and the request function.
 * @returns the section.
 */
export function McpServersSection({ t, fetch }: McpServersSectionProps): ReactNode {
  const [listing, setListing] = useState<Listing>({ kind: 'loading' })
  const [confirming, setConfirming] = useState<PendingServer | undefined>()
  const [busy, setBusy] = useState(false)
  const [outcome, setOutcome] = useState<{ readonly text: string; readonly failed: boolean } | undefined>()

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const servers = await readPendingServers(fetch)
      setListing(servers === undefined ? { kind: 'unavailable' } : { kind: 'ready', servers })
    } catch (error) {
      const failure = consentFailureOf(error)
      setListing(failure.kind === 'remote' ? { kind: 'remote' } : { kind: 'failed', text: consentFailureText(t, failure) })
    }
  }, [fetch, t])
  useEffect(() => { void refresh() }, [refresh])

  const answer = async (action: () => Promise<string>): Promise<void> => {
    setConfirming(undefined)
    setOutcome(undefined)
    setBusy(true)
    try {
      setOutcome({ failed: false, text: await action() })
    } catch (error) {
      setOutcome({ failed: true, text: consentFailureText(t, consentFailureOf(error)) })
    } finally {
      setBusy(false)
    }
    await refresh()
  }

  const accept = (server: PendingServer): Promise<void> => answer(async () => {
    const { started } = await acceptServer(fetch, server)
    return t(started > 0 ? 'mcp.started' : 'mcp.acceptedLater', { server: server.serverName })
  })

  const decline = (server: PendingServer): Promise<void> => answer(async () => {
    await declineServer(fetch, server)
    return t('mcp.declined', { server: server.serverName })
  })

  return <div className={css.section}>
    <h2 className={css.heading}>{t('mcp.title')}</h2>
    {listing.kind === 'unavailable'
      ? <p className={css.line}>{t('mcp.unavailable')}</p>
      : <>
        <p className={css.intro}>{t('mcp.intro')}</p>
        {listing.kind === 'remote'
          ? <p className={css.line} role="status">{t('mcp.remote')} <code className={css.command}>{MCP_COMMAND}</code></p>
          : null}
        {listing.kind === 'failed' ? <p className={css.failed} role="alert">{listing.text}</p> : null}
        {outcome === undefined ? null : <p className={outcome.failed ? css.failed : css.line} role={outcome.failed ? 'alert' : 'status'}>{outcome.text}</p>}
        {listing.kind === 'ready' && listing.servers.length === 0 ? <p className={css.line}>{t('mcp.none')}</p> : null}
        {listing.kind === 'ready' && listing.servers.length > 0
          ? <ul className={css.list}>
            {listing.servers.map(server => <li key={server.serverName} className={css.row} data-server={server.serverName}>
              <div className={css.details}>
                <div className={css.title}>{server.serverName}</div>
                <div className={css.description}>{t('mcp.reviewed', { time: formatTime(t, server.reviewedAt) })}</div>
                <ServerStart t={t} server={server} />
              </div>
              <div className={css.buttons}>
                <Button variant="primary" size="sm" disabled={busy} onClick={() => { setConfirming(server) }}>{t('mcp.accept')}</Button>
                <Button variant="outline" size="sm" disabled={busy} onClick={() => { void decline(server) }}>{t('mcp.decline')}</Button>
              </div>
            </li>)}
          </ul>
          : null}
      </>}
    {confirming === undefined ? null : <Modal open onClose={() => { setConfirming(undefined) }}
      title={t('mcp.confirm.title', { server: confirming.serverName })} closeLabel={t('mcp.confirm.close')}
      footer={<>
        <Button variant="outline" data-modal-autofocus onClick={() => { setConfirming(undefined) }}>{t('mcp.confirm.cancel')}</Button>
        <Button variant="primary" disabled={busy} onClick={() => { void accept(confirming) }}>{t('mcp.confirm.accept')}</Button>
      </>}>
      <div className={css.consent}>
        <p className={css.text}>{t('mcp.confirm.body')}</p>
        <ServerStart t={t} server={confirming} />
      </div>
    </Modal>}
  </div>
}

/**
 * What a pending server would run, as a list of named values.
 * @param props - the copy and the server.
 * @returns the list.
 */
function ServerStart({ t, server }: { t: Translate; server: PendingServer }): ReactNode {
  return <dl className={css.start}>
    <dt>{t('mcp.command')}</dt>
    <dd><code className={css.command}>{server.command}</code></dd>
    <dt>{t('mcp.args')}</dt>
    <dd>{server.args.length === 0 ? t('mcp.argsNone') : <code className={css.command}>{server.args.map(argument => JSON.stringify(argument)).join(' ')}</code>}</dd>
    <dt>{t('mcp.cwd')}</dt>
    <dd>{server.cwd === '' ? t('mcp.cwdHost') : <code className={css.command}>{server.cwd}</code>}</dd>
    <dt>{t('mcp.env')}</dt>
    <dd>{server.envNames.length === 0 ? t('mcp.envNone') : <code className={css.command}>{server.envNames.join(', ')}</code>}</dd>
    <dt>{t('mcp.reason')}</dt>
    <dd>{server.reason}</dd>
  </dl>
}
