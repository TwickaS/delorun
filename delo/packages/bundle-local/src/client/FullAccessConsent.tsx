/**
 * The consent the studio shows before a workspace's full access is turned on: one sentence on what it allows, one on
 * its risk, and, behind Details, the folder it covers and what commands under full access can reach. The same consent
 * serves the composer's permission control, through upstream's `permissionSwitchConsent` service, the approval card's
 * action and the Permissions section. One store behind one `shell.overlay` entry holds the open consent, so it outlives
 * the surface that asked. On a remote studio the home refuses the review, and the consent says the answer is given at
 * the home's own computer and offers no way to grant.
 */
import type { ReactNode } from 'react'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { HostObservable, InjectFace, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { FULL_ACCESS_PRESET, reviewChat, setFullAccess, type WorkspaceAccess } from './consents-api.ts'
import { hostFailureOf, isRefused, LOOPBACK_REQUIRED, type HostFetch } from './host-api.ts'
import css from './ConsentSections.module.css'

/** The command the remote consent names for the home's own computer. */
export const FULL_ACCESS_COMMAND = 'delorun workspace full-access <folder> on'

/** The open consent, keyed by its sequence so a second ask replaces the first; null while none is open. */
export type FullAccessConsentState = {
  readonly seq: number
  /** The workspace as the home showed it; absent on a remote studio, which the home refused the review. */
  readonly access?: WorkspaceAccess
  /** The open chat the consent was asked from, which the grant also switches to full access. */
  readonly chat?: string
  /** Whether the person's answer is being recorded. */
  readonly busy: boolean
  /** Why the last answer was not recorded, as a refusal code or the home's sentence. */
  readonly failure?: ConsentFailure
} | null

/** Why an answer was not recorded: a code the consent words itself, or the home's own sentence. */
export type ConsentFailure =
  | { readonly kind: 'stale' | 'remote' | 'unreachable' | 'unreadable' }
  | { readonly kind: 'refused'; readonly message: string }

/** The store the overlay entry reads, and the questions surfaces ask through it. */
export interface FullAccessConsentSource {
  /** The open consent, for the overlay entry. */
  readonly hooks: { readonly consent: HostObservable<FullAccessConsentState> }
  /**
   * Show the consent for one workspace and wait for the person's answer.
   * @param access - the workspace as the home showed it, or undefined on a remote studio.
   * @param chat - the open chat the consent is asked from, which the grant also switches to full access.
   * @returns true once the grant is recorded; false when the person cancelled or the studio is remote.
   */
  readonly ask: (access: WorkspaceAccess | undefined, chat?: string) => Promise<boolean>
  /** Record the grant for the open consent; a refusal keeps the consent open with its failure. */
  readonly confirm: () => void
  /** Close the open consent without recording anything. */
  readonly cancel: () => void
}

/**
 * The failure a caught error stands for.
 * @param error - the caught error.
 * @returns the failure the consent shows.
 */
export function consentFailureOf(error: unknown): ConsentFailure {
  const failure = hostFailureOf(error)
  switch (failure.kind) {
    case 'refused':
      if (failure.code === 'STALE_REVIEW') return { kind: 'stale' }
      if (failure.code === LOOPBACK_REQUIRED) return { kind: 'remote' }
      return { kind: 'refused', message: failure.message }
    case 'unreachable':
    case 'unreadable':
      return { kind: failure.kind }
    /* v8 ignore next 2 -- HostFailure is a closed union, so the default holds no reachable statement. */
    default:
      return failure satisfies never
  }
}

/**
 * Create the consent's store.
 * @param fetch - the request function the grant is recorded through.
 * @returns the store.
 */
export function createFullAccessConsentSource(fetch: HostFetch): FullAccessConsentSource {
  let state: FullAccessConsentState = null
  let seq = 0
  let settle: ((granted: boolean) => void) | undefined
  const listeners = new Set<() => void>()
  const publish = (next: FullAccessConsentState): void => {
    state = next
    for (const listener of listeners) listener()
  }
  const close = (granted: boolean): void => {
    const done = settle
    settle = undefined
    publish(null)
    done?.(granted)
  }
  return {
    hooks: {
      consent: {
        getSnapshot: () => state,
        subscribe(listener) {
          listeners.add(listener)
          return () => { listeners.delete(listener) }
        },
      },
    },
    ask(access, chat) {
      // A second ask answers the first as cancelled: one consent is open at a time.
      close(false)
      publish({ seq: ++seq, ...access === undefined ? {} : { access }, ...chat === undefined ? {} : { chat }, busy: false })
      return new Promise<boolean>((resolve) => { settle = resolve })
    },
    confirm() {
      const open = state
      if (open?.access === undefined || open.busy) return
      publish({ ...open, busy: true })
      setFullAccess(fetch, open.access, true, open.chat).then(
        () => { if (state?.seq === open.seq) close(true) },
        (error: unknown) => { if (state?.seq === open.seq) publish({ ...open, busy: false, failure: consentFailureOf(error) }) },
      )
    },
    cancel() {
      close(false)
    },
  }
}

/**
 * The `permissionSwitchConsent` question of the composer's permission control: a switch to full access in a chat whose
 * workspace holds no grant shows the consent first, and is submitted only once the grant is recorded. Every other
 * switch, and every switch in a profile that does not ask for full access per workspace, is submitted at once.
 * @param fetch - the request function.
 * @param consent - the consent's store.
 * @param sessionId - the chat the switch belongs to.
 * @param preset - the preset the person picked.
 * @returns whether the control submits the switch.
 * @throws {HostRequestError} when the home cannot answer the review; the control then submits nothing.
 */
export async function confirmPermissionSwitch(fetch: HostFetch, consent: Pick<FullAccessConsentSource, 'ask'>, sessionId: string, preset: string): Promise<boolean> {
  if (preset !== FULL_ACCESS_PRESET) return true
  let access: WorkspaceAccess | undefined
  try {
    access = await reviewChat(fetch, sessionId)
  } catch (error) {
    if (isRefused(error, LOOPBACK_REQUIRED)) return consent.ask(undefined)
    // A chat with no folder has no per-workspace permission: the home's guard answers the switch with its own reason.
    if (isRefused(error, 'NO_WORKSPACE')) return true
    throw error
  }
  if (access === undefined || access.grantedAt !== null) return true
  return consent.ask(access)
}

/**
 * The name a workspace shows: its registered title, or its folder's last segment.
 * @param access - the workspace.
 * @returns the name.
 */
export function workspaceName(access: WorkspaceAccess): string {
  return access.title ?? access.workspace.split(/[\\/]/).filter(part => part !== '').at(-1) ?? access.workspace
}

/** Props of the `shell.overlay` entry: the consent's store and the consents copy. */
export type FullAccessConsentProps = PropsLocale<'deloConsents'> & InjectFace<Omit<FullAccessConsentSource, 'ask'>>

/**
 * The sentence a failure shows.
 * @param t - the consents copy.
 * @param failure - the failure.
 * @param action - the phrase a remote refusal names: changing full access, or allowing an MCP server.
 * @returns the sentence.
 */
export function consentFailureText(t: FullAccessConsentProps['t'], failure: ConsentFailure, action: 'action.changeAccess' | 'action.answerServer' = 'action.changeAccess'): string {
  switch (failure.kind) {
    case 'stale': return t('failed.stale')
    case 'remote': return t('loopback', { action: t(action) })
    case 'unreachable': return t('failed.unreachable')
    case 'unreadable': return t('failed.unreadable')
    case 'refused': return failure.message
    /* v8 ignore next 2 -- ConsentFailure is a closed union. */
    default:
      return failure satisfies never
  }
}

/**
 * Render the open consent.
 * @param props - the consent hook, its answers and the copy.
 * @returns the dialog, or nothing while no consent is open.
 */
export function FullAccessConsent({ useConsent, confirm, cancel, t }: FullAccessConsentProps): ReactNode {
  const consent = useConsent(current => current)
  if (consent === null) return null
  const access = consent.access
  return <Modal open onClose={cancel} title={t('consent.title')} closeLabel={t('consent.close')}
    footer={<>
      <Button variant="outline" data-modal-autofocus onClick={cancel}>{t('consent.cancel')}</Button>
      {access === undefined ? null
        : <Button variant="primary" disabled={consent.busy} onClick={confirm}>{t('consent.confirm')}</Button>}
    </>}>
    {access === undefined
      ? <p className={css.text}>{t('consent.remote')} <code className={css.command}>{FULL_ACCESS_COMMAND}</code></p>
      : <div className={css.consent}>
        <p className={css.text}>{t('consent.allows', { workspace: workspaceName(access) })}</p>
        <p className={css.text}>{t('consent.risk')}</p>
        <details className={css.disclosure}>
          <summary>{t('consent.details')}</summary>
          <dl className={css.start}>
            <dt>{t('consent.folder')}</dt>
            <dd><code className={css.command}>{access.workspace}</code></dd>
          </dl>
          <p className={css.text}>{t('consent.reachIntro')}</p>
          <ul className={css.reach}>
            <li>{t('consent.reach.files')}</li>
            <li>{t('consent.reach.keys')}</li>
            <li>{t('consent.reach.channels')}</li>
          </ul>
          <p className={css.text}>{t('consent.scope')}</p>
        </details>
        {consent.failure === undefined ? null : <p className={css.failed} role="alert">{consentFailureText(t, consent.failure)}</p>}
      </div>}
  </Modal>
}
