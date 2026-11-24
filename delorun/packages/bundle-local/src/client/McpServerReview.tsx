/**
 * The review the studio shows before a waiting stdio MCP server starts: one sentence on what allowing it lets the
 * server do, one naming the file that runs and the folder it runs in, one naming the file the command links to when
 * that differs, one naming the paths of the start that chats can write when there are any, one on its risk, what changed since the person
 * last allowed it, and, behind Details, the command, its arguments, its folder, the file, command shell and folder they
 * resolve to, and the names of its environment variables, with a value only for a variable that changes what runs. The Permissions section and
 * the waiting-server notice both open it. One store behind one `shell.overlay` entry holds the open review, so it
 * outlives the surface that asked.
 */
import type { ReactNode } from 'react'
import { Button, Dialog } from '@delorun/brand'
import type { HostObservable, InjectFace, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { acceptServer, type AcceptedServer, type PendingServer, type ServerChange } from './consents-api.ts'
import { consentFailureOf, ConsentFailureLine, type ConsentFailure } from './FullAccessConsent.tsx'
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
export type McpServerReviewProps = PropsLocale<'delorunConsents'> & InjectFace<Omit<McpReviewSource, 'ask'>>

type Translate = McpServerReviewProps['t']

/**
 * The sentence that says what a waiting server's review asks about.
 * @param t - the consents copy.
 * @param server - what changed since the person last allowed the server, and which variables for an environment change.
 * @returns the sentence.
 */
export function serverChangeText(t: Translate, server: Pick<PendingServer, 'change' | 'changedVariables'>): string {
  const change: ServerChange = server.change
  switch (change) {
    case 'new': return t('mcp.change.new')
    case 'command': return t('mcp.change.command')
    case 'arguments': return t('mcp.change.arguments')
    case 'directory': return t('mcp.change.directory')
    case 'environment': return t('mcp.change.environment', { names: server.changedVariables.join(', ') })
    case 'resolved': return t('mcp.change.resolved')
    case 'contents': return t('mcp.change.contents')
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
    <dd>{start.args.length === 0 ? t('mcp.argsNone') : <>
      <code className={css.command}>{start.args.map(argument => JSON.stringify(argument)).join(' ')}</code>
      {start.args.some(argument => argument.includes('${credential:')) ? <div className={css.hint}>{t('mcp.argsTemplated')}</div> : null}
    </>}</dd>
    <dt>{t('mcp.cwd')}</dt>
    <dd>{start.cwd === '' ? t('mcp.cwdHost') : <code className={css.command}>{start.cwd}</code>}</dd>
    <dt>{t('mcp.resolvedCommand')}</dt>
    <dd><code className={css.command}>{start.resolvedCommand}</code></dd>
    {start.resolvedShell === undefined ? null : <>
      <dt>{t('mcp.resolvedShell')}</dt>
      <dd><code className={css.command}>{start.resolvedShell}</code></dd>
    </>}
    <dt>{t('mcp.resolvedCwd')}</dt>
    <dd><code className={css.command}>{start.resolvedCwd}</code></dd>
    {start.files.length === 0 ? null : <>
      <dt>{t('mcp.files')}</dt>
      <dd><code className={css.command}>{start.files.map(file => file.path).join('\n')}</code></dd>
    </>}
    <dt>{t('mcp.env')}</dt>
    <dd>{start.env.length === 0 ? t('mcp.envNone') : <>
      <code className={css.command}>{start.env.map(variable => variable.value === undefined ? variable.name : `${variable.name}=${variable.value}`).join('\n')}</code>
      <div className={css.hint}>{t('mcp.envHidden')}</div>
    </>}</dd>
  </dl>
}

/**
 * The file a waiting server's command links to, which is the file the server is started with.
 * @param server - the server as the home showed it.
 * @returns the pinned executable's path when it differs from the resolved command; otherwise undefined.
 */
function linkedFile(server: PendingServer): string | undefined {
  const executable = server.files[0]?.path
  return executable === server.resolvedCommand ? undefined : executable
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
  const linked = linkedFile(server)
  // While the answer is recorded the review stays open, so its outcome is the one the person sees.
  const close = (): void => { if (!review.busy) cancel() }
  return <Dialog open onClose={close} title={t('mcp.confirm.title', { server: server.serverName })} closeLabel={t('mcp.confirm.close')}
    actions={<>
      <Button variant="secondary" data-modal-autofocus disabled={review.busy} onClick={close}>{t('mcp.confirm.cancel')}</Button>
      <Button variant="primary" disabled={review.busy} onClick={confirm}>{t('mcp.confirm.accept')}</Button>
    </>}>
    <div className={css.consent}>
      <p className={css.text}>{t('mcp.confirm.allows', { server: server.serverName })}</p>
      <p className={css.text} data-runs>{server.resolvedShell === undefined
        ? t('mcp.confirm.runs', { command: server.resolvedCommand, folder: server.resolvedCwd })
        : t('mcp.confirm.runsShell', { command: server.resolvedCommand, shell: server.resolvedShell, folder: server.resolvedCwd })}</p>
      {linked === undefined ? null : <p className={css.text} data-links>{t('mcp.confirm.linksTo', { command: server.resolvedCommand, file: linked })}</p>}
      {server.writableByChats.length === 0 ? null : <p className={css.text} data-writable>{t('mcp.confirm.writable', { paths: server.writableByChats.join(', ') })}</p>}
      <p className={css.text}>{t('mcp.confirm.risk')}</p>
      {server.change === 'new' ? null : <p className={css.text} data-change={server.change}>{serverChangeText(t, server)}</p>}
      <details className={css.disclosure}>
        <summary>{t('mcp.details')}</summary>
        <ServerStart t={t} start={server} />
      </details>
      {review.failure === undefined ? null : <ConsentFailureLine t={t} failure={review.failure} action="action.answerServer" />}
    </div>
  </Dialog>
}
