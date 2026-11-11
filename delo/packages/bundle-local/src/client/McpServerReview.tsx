/**
 * The review the studio shows before a waiting stdio MCP server starts: one sentence on what allowing it lets the
 * server do, one on its risk, what changed since the person last allowed it, and, behind Details, the command, its
 * arguments, its folder and the names of its environment variables, never their values. The Permissions section and
 * the waiting-server notice both open it. One store behind one `shell.overlay` entry holds the open review, so it
 * outlives the surface that asked.
 */
import type { ReactNode } from 'react'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { HostObservable, InjectFace, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { acceptServer, type AcceptedServer, type PendingServer, type ServerChange } from './consents-api.ts'
import { consentFailureOf, consentFailureText, type ConsentFailure } from './FullAccessConsent.tsx'
import type { HostFetch } from './host-api.ts'
import css from './ConsentSections.module.css'

/** The open review, keyed by its sequence so a second ask replaces the first; null while none is open. */
export type McpReviewState = {
  readonly seq: number
  /** The waiting server as the home showed it. */
  readonly server: PendingServer
  /** Whether the person's answer is being recorded. */
  readonly busy: boolean
  /** Why the last answer was not recorded. */
  readonly failure?: ConsentFailure
} | null

/** The store the overlay entry reads, and the question surfaces ask through it. */
export interface McpReviewSource {
  /** The open review, for the overlay entry. */
  readonly hooks: { readonly review: HostObservable<McpReviewState> }
  /**
   * Show the review of one waiting server and wait for the person's answer.
   * @param server - the server as the home showed it.
   * @returns how many stopped server rows started once the start is allowed; undefined when the person cancelled.
   */
  readonly ask: (server: PendingServer) => Promise<number | undefined>
  /** Allow the open review's start; a refusal keeps the review open with its failure. */
  readonly confirm: () => void
  /** Close the open review without recording anything. */
  readonly cancel: () => void
}

/**
 * Create the review's store.
 * @param fetch - the request function the answer is recorded through.
 * @returns the store.
 */
export function createMcpReviewSource(fetch: HostFetch): McpReviewSource {
  let state: McpReviewState = null
  let seq = 0
  let settle: ((started: number | undefined) => void) | undefined
  const listeners = new Set<() => void>()
  const publish = (next: McpReviewState): void => {
    state = next
    for (const listener of listeners) listener()
  }
  const close = (started: number | undefined): void => {
    const done = settle
    settle = undefined
    publish(null)
    done?.(started)
  }
  return {
    hooks: {
      review: {
        getSnapshot: () => state,
        subscribe(listener) {
          listeners.add(listener)
          return () => { listeners.delete(listener) }
        },
      },
    },
    ask(server) {
      // A second ask answers the first as cancelled: one review is open at a time.
      close(undefined)
      publish({ seq: ++seq, server, busy: false })
      return new Promise<number | undefined>((resolve) => { settle = resolve })
    },
    confirm() {
      const open = state
      if (open === null || open.busy) return
      publish({ ...open, busy: true })
      acceptServer(fetch, open.server).then(
        ({ started }) => { if (state?.seq === open.seq) close(started) },
        (error: unknown) => { if (state?.seq === open.seq) publish({ ...open, busy: false, failure: consentFailureOf(error) }) },
      )
    },
    cancel() {
      close(undefined)
    },
  }
}

/** Props of the `shell.overlay` entry: the review's store and the consents copy. */
export type McpServerReviewProps = PropsLocale<'deloConsents'> & InjectFace<Omit<McpReviewSource, 'ask'>>

type Translate = McpServerReviewProps['t']

/**
 * The sentence that says what a waiting server's review asks about.
 * @param t - the consents copy.
 * @param change - what changed since the person last allowed the server.
 * @returns the sentence.
 */
export function serverChangeText(t: Translate, change: ServerChange): string {
  switch (change) {
    case 'new': return t('mcp.change.new')
    case 'arguments': return t('mcp.change.arguments')
    case 'directory': return t('mcp.change.directory')
    case 'environment': return t('mcp.change.environment')
    case 'unreadable': return t('mcp.change.unreadable')
    /* v8 ignore next 2 -- ServerChange is a closed union. */
    default:
      return change satisfies never
  }
}

/**
 * What a server start runs, as a list of named values.
 * @param props - the copy and the start.
 * @returns the list.
 */
export function ServerStart({ t, start }: { t: Translate; start: PendingServer | AcceptedServer }): ReactNode {
  return <dl className={css.start}>
    <dt>{t('mcp.command')}</dt>
    <dd><code className={css.command}>{start.command}</code></dd>
    <dt>{t('mcp.args')}</dt>
    <dd>{start.args.length === 0 ? t('mcp.argsNone') : <code className={css.command}>{start.args.map(argument => JSON.stringify(argument)).join(' ')}</code>}</dd>
    <dt>{t('mcp.cwd')}</dt>
    <dd>{start.cwd === '' ? t('mcp.cwdHost') : <code className={css.command}>{start.cwd}</code>}</dd>
    <dt>{t('mcp.env')}</dt>
    <dd>{start.envNames.length === 0 ? t('mcp.envNone') : <code className={css.command}>{start.envNames.join(', ')}</code>}</dd>
  </dl>
}

/**
 * Render the open review.
 * @param props - the review hook, its answers and the copy.
 * @returns the dialog, or nothing while no review is open.
 */
export function McpServerReview({ useReview, confirm, cancel, t }: McpServerReviewProps): ReactNode {
  const review = useReview(current => current)
  if (review === null) return null
  const { server } = review
  return <Modal open onClose={cancel} title={t('mcp.confirm.title', { server: server.serverName })} closeLabel={t('mcp.confirm.close')}
    footer={<>
      <Button variant="outline" data-modal-autofocus onClick={cancel}>{t('mcp.confirm.cancel')}</Button>
      <Button variant="primary" disabled={review.busy} onClick={confirm}>{t('mcp.confirm.accept')}</Button>
    </>}>
    <div className={css.consent}>
      <p className={css.text}>{t('mcp.confirm.allows', { server: server.serverName })}</p>
      <p className={css.text}>{t('mcp.confirm.risk')}</p>
      {server.change === 'new' ? null : <p className={css.text} data-change={server.change}>{serverChangeText(t, server.change)}</p>}
      <details className={css.disclosure}>
        <summary>{t('mcp.details')}</summary>
        <ServerStart t={t} start={server} />
      </details>
      {review.failure === undefined ? null : <p className={css.failed} role="alert">{consentFailureText(t, review.failure, 'action.answerServer')}</p>}
    </div>
  </Modal>
}
