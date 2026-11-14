/**
 * The notice that a stdio MCP server is waiting for the person's OK, so a server the add-time consent stopped is never
 * a silent dead end. At the home's own computer it names the waiting servers and offers "Review and allow this server",
 * which opens the review of the first one; once that review closes, the notice offers the next waiting server, so each
 * is reviewed in turn. On a remote studio, which reads only the servers' names, it says the answer
 * is given at the computer. The notice reads the waiting servers when it mounts and each time the window regains
 * focus, and shows again only for a server whose review changed since the person dismissed it. A server the person
 * declined or revoked is not waiting, so it raises no notice until its start changes.
 */
import { useCallback, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { IconWarningOutlineRegular, Toast } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { readServers, readWaitingServers, type PendingServer, type WaitingServer } from './consents-api.ts'
import { useDangerousMode } from './dangerous-mode.ts'
import { isRefused, LOOPBACK_REQUIRED, type HostFetch } from './host-api.ts'
import type { ConsentToastSource } from './ConsentToast.tsx'
import type { McpReviewSource } from './McpServerReview.tsx'

/** Full-opacity hold of the notice: a sentence and an action to read. */
const NOTICE_HOLD_MS = 12000

/** What the plugin supplies the notice. */
export interface McpWaitingNoticeInjected {
  /** Sends the notice's same-origin requests: the browser's `fetch`, or a spec's fake. */
  fetch: HostFetch
  /** Shows a waiting server's review and waits for the person's answer. */
  review: McpReviewSource['ask']
  /** Shows an answer's outcome as a toast. */
  notify: ConsentToastSource['show']
}

/** Props of the `shell.overlay` entry. */
export type McpWaitingNoticeProps = PropsLocale<'delorunConsents'> & InjectFace<McpWaitingNoticeInjected>

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
    // The notice is a pointer to the Permissions section, which names a failure in place; here no server shows.
    void error
    return { kind: 'remote', servers: [] }
  }
}

/**
 * The key one waiting server is dismissed under: a new review of its start shows the notice again.
 * @param server - the server.
 * @returns the key.
 */
function dismissKey(server: PendingServer | WaitingServer): string {
  return 'reviewId' in server ? `${server.serverName}\u0000${server.reviewId}` : `${server.serverName}\u0000${server.change}`
}

/**
 * Render the notice while a server waits.
 * @param props - the request function, the review and the copy.
 * @returns the banner, or nothing.
 */
export function McpWaitingNotice({ fetch, review, notify, t }: McpWaitingNoticeProps): ReactNode {
  const [waiting, setWaiting] = useState<Waiting>({ kind: 'computer', servers: [] })
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(new Set())
  const [reviewing, setReviewing] = useState(false)
  const dangerous = useDangerousMode(fetch)
  const refresh = useCallback(async (): Promise<void> => { setWaiting(await readWaiting(fetch)) }, [fetch])
  useEffect(() => {
    void refresh()
    const onFocus = (): void => { void refresh() }
    globalThis.addEventListener('focus', onFocus)
    return () => { globalThis.removeEventListener('focus', onFocus) }
  }, [refresh])
  const shown = waiting.servers.filter(server => !dismissed.has(dismissKey(server)))
  if (shown.length === 0 || reviewing) return null
  const names = shown.map(server => server.serverName).join(', ')
  const dismiss = (): void => { setDismissed(new Set([...dismissed, ...shown.map(dismissKey)])) }
  if (waiting.kind === 'remote') {
    return <Toast key={names} text={t(dangerous ? 'mcp.notice.phoneUnlock' : 'mcp.notice.phone', { servers: names })} icon={<IconWarningOutlineRegular />} holdMs={NOTICE_HOLD_MS}
      actions={[{ label: t('mcp.notice.dismiss'), prefix: ' ', onClick: dismiss }]} onDone={dismiss} />
  }
  const first = waiting.servers.find(server => !dismissed.has(dismissKey(server)))
  const open = (): void => {
    if (first === undefined) return
    setReviewing(true)
    // Only the reviewed server is set aside: the notice then offers the next one that waits.
    void review(first).then((started) => {
      if (started !== undefined) notify(t(started > 0 ? 'mcp.started' : 'mcp.acceptedLater', { server: first.serverName }), false)
    }).finally(() => {
      setDismissed(current => new Set([...current, dismissKey(first)]))
      setReviewing(false)
      void refresh()
    })
  }
  return <Toast key={names} text={t('mcp.notice.computer', { servers: names })} icon={<IconWarningOutlineRegular />} holdMs={NOTICE_HOLD_MS}
    actions={[{ label: t('mcp.notice.review'), prefix: ' ', onClick: open }, { label: t('mcp.notice.dismiss'), prefix: ' ', onClick: dismiss }]} onDone={dismiss} />
}
