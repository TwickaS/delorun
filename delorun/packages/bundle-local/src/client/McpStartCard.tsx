/**
 * The card that says a stdio MCP server wants to start (A631), in `conversation.input.dock` above the composer. Only a
 * server from another plugin, an editor's session or an unknown place waits for the person by default; "Always ask" also
 * brings the person's own servers and Delorun's packs. The card names the first waiting server and where it comes from,
 * and offers Allow, which accepts that server's review at the computer, Not now, and Details, which opens the full
 * review. Not now hides the card for that review for the rest of the studio session; the server stays waiting in
 * Settings → Permissions. A remote studio reads only the servers' names, so its card says the answer is given at the
 * computer and offers no Allow. The card reads the waiting servers when it mounts, each time the window regains focus
 * and every few seconds, and never takes focus.
 */
import { useCallback, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { IconWarningOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { HostObservable, InjectFace, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { acceptServer, readServers, readWaitingServers, type PendingServer, type ServerOrigin, type WaitingServer } from './consents-api.ts'
import { consentFailureOf, consentFailureText } from './FullAccessConsent.tsx'
import { isRefused, LOOPBACK_REQUIRED, type HostFetch } from './host-api.ts'
import type { ConsentToastSource } from './ConsentToast.tsx'
import type { McpReviewSource } from './McpServerReview.tsx'
import css from './McpStartCard.module.css'
import { useDangerousMode } from './dangerous-mode.ts'

/** How often the card reads the waiting servers while it shows, in milliseconds. */
const REFRESH_MS = 10_000

/** The cards the person set aside with "Not now", which every chat's card shares for the studio session. */
export interface McpStartCardMemory {
  /** The keys of the set-aside reviews, for the card. */
  readonly hooks: { readonly hidden: HostObservable<readonly string[]> }
  /**
   * Set one review's card aside.
   * @param key - the review's key.
   */
  readonly hide: (key: string) => void
}

/**
 * Create the memory of the cards set aside.
 * @returns the observable keys with the action that adds one.
 */
export function createMcpStartCardMemory(): McpStartCardMemory {
  const store = createSnapshotStore<readonly string[]>([])
  return {
    hooks: { hidden: { getSnapshot: () => store.getSnapshot(), subscribe: listener => store.subscribe(listener) } },
    hide: (key) => { store.set([...store.getSnapshot(), key]) },
  }
}

/** What the plugin supplies the card. */
export interface McpStartCardInjected {
  /** Sends the card's same-origin requests: the browser's `fetch`, or a spec's fake. */
  fetch: HostFetch
  /** Shows a waiting server's full review and waits for the person's answer. */
  review: McpReviewSource['ask']
  /** Shows an answer's outcome as a toast. */
  notify: ConsentToastSource['show']
  /** The cards set aside; the same memory for every chat. */
  hooks: McpStartCardMemory['hooks']
  /** Sets one review's card aside. */
  hide: McpStartCardMemory['hide']
}

/** Props of the `conversation.input.dock` entry. */
export type McpStartCardProps = PropsLocale<'delorunConsents'> & InjectFace<McpStartCardInjected>

/** The waiting servers as this studio may read them: in full at the computer, by name on a remote studio. */
type Waiting =
  | { readonly kind: 'computer'; readonly servers: readonly PendingServer[] }
  | { readonly kind: 'remote'; readonly servers: readonly WaitingServer[] }

/**
 * Read the waiting servers this studio may read.
 * @param fetch - the request function.
 * @returns the waiting servers; none when the profile mounts no MCP add-time consent or the home cannot answer.
 */
export async function readWaiting(fetch: HostFetch): Promise<Waiting> {
  try {
    return { kind: 'computer', servers: (await readServers(fetch))?.servers.filter(server => server.state === 'waiting') ?? [] }
  } catch (error) {
    if (!isRefused(error, LOOPBACK_REQUIRED)) return { kind: 'computer', servers: [] }
  }
  try {
    return { kind: 'remote', servers: await readWaitingServers(fetch) ?? [] }
  } catch (error) {
    // The card is a pointer to the Permissions section, which names a failure in place; here no server shows.
    void error
    return { kind: 'remote', servers: [] }
  }
}

/**
 * The key one waiting server's card is set aside under: a new review of its start shows the card again.
 * @param server - the server.
 * @returns the key.
 */
export function cardKey(server: PendingServer | WaitingServer): string {
  return 'reviewId' in server ? `${server.serverName}\u0000${server.reviewId}` : `${server.serverName}\u0000${server.change}`
}

type Translate = McpStartCardProps['t']

/**
 * The line that names where a server comes from.
 * @param t - the consents copy.
 * @param origin - the server's origin.
 * @returns the sentence.
 */
export function originText(t: Translate, origin: ServerOrigin): string {
  switch (origin.kind) {
    case 'plugin': return t('mcp.card.origin.plugin', { plugin: origin.plugin })
    case 'chat': return t('mcp.card.origin.chat')
    case 'unknown': return t('mcp.card.origin.unknown')
    case 'profile': return t('mcp.card.origin.profile')
    case 'settings': return t('mcp.card.origin.settings')
    case 'pack': return t('mcp.card.origin.pack', { pack: origin.pack })
    /* v8 ignore next 2 -- ServerOrigin is a closed union. */
    default:
      return origin satisfies never
  }
}

/** What the card shows of the first waiting server. */
interface CardView {
  readonly server: string
  readonly line: string
  readonly total: number
  readonly actions: ReactNode
}

/**
 * Draw the card.
 * @param props - the copy and what the card shows.
 * @returns the card.
 */
function Card({ t, view }: { readonly t: Translate; readonly view: CardView }): ReactNode {
  return <div className={`${css.card} delorun-glass`} role="status" data-mcp-start-card={view.server}>
    <span className={css.icon} aria-hidden="true"><IconWarningOutlineRegular /></span>
    <div className={css.text}>
      <p className={`${css.title} delorun-alert-title`}>{t('mcp.card.title', { server: view.server })}</p>
      <p className={`${css.line} delorun-alert-line`}>
        {view.line}
        {view.total > 1 ? <span className={css.count}>{' · '}{t('mcp.card.count', { position: '1', total: String(view.total) })}</span> : null}
      </p>
      <div className={css.actions}>{view.actions}</div>
    </div>
  </div>
}

/**
 * Render the card while a server waits.
 * @param props - the request function, the review, the toast, the memory of set-aside cards and the copy.
 * @returns the card, or nothing.
 */
export function McpStartCard({ fetch, review, notify, useHidden, hide, t }: McpStartCardProps): ReactNode {
  const [waiting, setWaiting] = useState<Waiting>({ kind: 'computer', servers: [] })
  const [busy, setBusy] = useState(false)
  const dangerous = useDangerousMode(fetch)
  const hidden = useHidden(current => current)
  const refresh = useCallback(async (): Promise<void> => { setWaiting(await readWaiting(fetch)) }, [fetch])
  useEffect(() => {
    void refresh()
    const onFocus = (): void => { void refresh() }
    globalThis.addEventListener('focus', onFocus)
    const timer = setInterval(onFocus, REFRESH_MS)
    return () => {
      globalThis.removeEventListener('focus', onFocus)
      clearInterval(timer)
    }
  }, [refresh])
  const settled = (): void => {
    setBusy(false)
    void refresh()
  }
  const tell = (server: PendingServer, started: number | undefined): void => {
    if (started !== undefined) notify(t(started > 0 ? 'mcp.started' : 'mcp.acceptedLater', { server: server.serverName }), false)
  }
  const button = (label: string, onClick: () => void, extra = ''): ReactNode =>
    <button type="button" className={`${css.action} ${extra}`} disabled={busy} onClick={onClick}>{label}</button>
  const later = (key: string): ReactNode => button(t('mcp.card.later'), () => { hide(key) }, 'delorun-alert-secondary')
  if (waiting.kind === 'remote') {
    const shown = waiting.servers.filter(server => !hidden.includes(cardKey(server)))
    const first = shown[0]
    if (first === undefined) return null
    return <Card t={t} view={{ server: first.serverName, line: t(dangerous ? 'mcp.card.remoteConfirm' : 'mcp.card.remote'), total: shown.length, actions: later(cardKey(first)) }} />
  }
  const shown = waiting.servers.filter(server => !hidden.includes(cardKey(server)))
  const first = shown[0]
  if (first === undefined) return null
  const allow = (): void => {
    setBusy(true)
    acceptServer(fetch, first).then(
      ({ started }) => { tell(first, started) },
      (error: unknown) => { notify(consentFailureText(t, consentFailureOf(error), 'action.answerServer'), true) },
    ).finally(settled)
  }
  // The review answers for itself; the card only shows the outcome and reads the list again.
  const details = (): void => {
    setBusy(true)
    void review(first).then((started) => { tell(first, started) }).finally(settled)
  }
  return <Card t={t} view={{
    server: first.serverName, line: originText(t, first.origin), total: shown.length,
    actions: <>
      {button(t('mcp.card.allow'), allow, `${css.primary} delorun-alert-primary`)}
      {later(cardKey(first))}
      {button(t('mcp.card.details'), details)}
    </>,
  }} />
}
