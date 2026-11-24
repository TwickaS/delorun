/**
 * The consent the studio shows before a workspace's full access is turned on: one sentence on what it allows, one on
 * its risk, and, behind Details, the folder it covers and what commands under full access can reach. The same consent
 * serves the composer's permission control, through upstream's `permissionSwitchConsent` service, the approval card's
 * action and the Permissions section. One store behind one `shell.overlay` entry holds the open consent, so it outlives
 * the surface that asked. On a remote studio the home refuses the review, and the consent says the answer is given at
 * the home's own computer and offers no way to grant.
 */
import { useState, type ReactNode } from 'react'
import { Checkbox } from '@deepseek-ai/dsh-client-ui-primitives'
import { Button, Dialog } from '@delorun/brand'
import type { HostObservable, InjectFace, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { FULL_ACCESS_PRESET, readEverywhere, reviewChat, setFullAccess, type WorkspaceAccess } from './consents-api.ts'
import { ELEVATION_REQUIRED } from './gate.ts'
import { hostFailureOf, isRefused, LOOPBACK_REQUIRED, type HostFetch } from './host-api.ts'
import css from './ConsentSections.module.css'

/** The command the remote consent names for the home's own computer. */
export const FULL_ACCESS_COMMAND = 'delorun workspace full-access <folder> on'

/** The open consent, keyed by its sequence so a second ask replaces the first; null while none is open. */
export type FullAccessConsentState = {
  readonly seq: number
  /**
   * What the consent asks: `grant` records the workspace's grant and then switches; `switch` only confirms the switch,
   * for a workspace that already holds a grant or a chat with none; `remote` names the command for the home's own
   * computer.
   */
  readonly form: 'grant' | 'switch' | 'remote'
  /** The workspace as the home showed it; absent in the `switch` and `remote` forms. */
  readonly access?: WorkspaceAccess
  /** Whether the person must tick the risk acknowledgement before confirming: the composer's switch asks, the approval card does not. */
  readonly acknowledge: boolean
  /** The open chat the consent was asked from, which the grant also switches to full access. */
  readonly chat?: string
  /** Whether the person's answer is being recorded. */
  readonly busy: boolean
  /** Why the last answer was not recorded, as a refusal code or the home's sentence. */
  readonly failure?: ConsentFailure
} | null

/** Why an answer was not recorded: a code the consent words itself, or the home's own sentence. */
export type ConsentFailure =
  | { readonly kind: 'stale' | 'remote' | 'face' | 'unreachable' | 'unreadable' }
  | { readonly kind: 'refused'; readonly message: string }

/**
 * How a switch to full access was answered: `cancelled` leaves the chat's preset unchanged; `submit` leaves the switch
 * to the surface; `switched` means recording the workspace's grant already switched the chat, so the surface submits
 * nothing more (on a device, submitting it would ask for Face ID or the PIN a second time).
 */
export type SwitchAnswer = 'cancelled' | 'submit' | 'switched'

/** The store the overlay entry reads, and the questions surfaces ask through it. */
export interface FullAccessConsentSource {
  /** The open consent, for the overlay entry. */
  readonly hooks: { readonly consent: HostObservable<FullAccessConsentState> }
  /**
   * Show the consent for one workspace and wait for the person's answer.
   * @param access - the workspace as the home showed it, or undefined on a remote studio.
   * @param chat - the open chat the consent is asked from, which the grant also switches to full access.
   * @param wanted - whether the asker still wants the grant, read when the person confirms: false closes the consent
   *   without recording anything, as an approval card that can no longer be answered does.
   * @returns true once the grant is recorded; false when the person cancelled, the asker no longer wants it, or the
   *   studio is remote.
   */
  readonly ask: (access: WorkspaceAccess | undefined, chat?: string, wanted?: () => boolean) => Promise<boolean>
  /**
   * Show the consent the composer's permission control asks for a switch to full access, with a risk acknowledgement.
   * @param access - the workspace as the home showed it, whose missing grant the consent records; undefined, or a
   *   workspace that holds a grant, asks only to switch this chat.
   * @param wanted - whether the asker still wants the switch, read when the person confirms: false closes the consent
   *   without recording anything, as an approval card that can no longer be answered does.
   * @param chat - the chat the switch belongs to: recording a missing grant also switches it, in the same call, so a
   *   device confirms the tap once.
   * @returns `switched` once a missing grant is recorded and the chat switched with it; `submit` once the person
   *   confirmed and nothing switched the chat; `cancelled` when cancelled or the asker no longer wants the switch.
   */
  readonly askSwitch: (access: WorkspaceAccess | undefined, wanted?: () => boolean, chat?: string) => Promise<SwitchAnswer>
  /** Record the grant for the open consent, or accept the switch of the `switch` form; a refusal keeps the consent open with its failure. */
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
      // A cancelled Face ID confirmation: trying again asks again; no unlock admits it.
      if (failure.code === ELEVATION_REQUIRED) return { kind: 'face' }
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
  let settle: ((answer: SwitchAnswer) => void) | undefined
  let stillWanted: (() => boolean) | undefined
  const listeners = new Set<() => void>()
  const publish = (next: FullAccessConsentState): void => {
    state = next
    for (const listener of listeners) listener()
  }
  const close = (answer: SwitchAnswer): void => {
    const done = settle
    settle = undefined
    stillWanted = undefined
    publish(null)
    done?.(answer)
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
    ask(access, chat, wanted) {
      // A second ask answers the first as cancelled: one consent is open at a time.
      close('cancelled')
      stillWanted = wanted
      publish({ seq: ++seq, form: access === undefined ? 'remote' : 'grant', ...access === undefined ? {} : { access }, acknowledge: false, ...chat === undefined ? {} : { chat }, busy: false })
      return new Promise<SwitchAnswer>((resolve) => { settle = resolve }).then(answer => answer !== 'cancelled')
    },
    askSwitch(access, wanted, chat) {
      close('cancelled')
      stillWanted = wanted
      const grant = access !== undefined && access.grantedAt === null
      publish({ seq: ++seq, form: grant ? 'grant' : 'switch', ...grant ? { access, ...chat === undefined ? {} : { chat } } : {}, acknowledge: true, busy: false })
      return new Promise<SwitchAnswer>((resolve) => { settle = resolve })
    },
    confirm() {
      const open = state
      if (open === null || open.form === 'remote' || open.busy) return
      if (stillWanted?.() === false) {
        close('cancelled')
        return
      }
      if (open.form === 'switch') {
        close('submit')
        return
      }
      if (open.access === undefined) return
      publish({ ...open, busy: true })
      setFullAccess(fetch, open.access, true, open.chat).then(
        ({ chats }) => { if (state?.seq === open.seq) close(chats > 0 ? 'switched' : 'submit') },
        (error: unknown) => { if (state?.seq === open.seq) publish({ ...open, busy: false, failure: consentFailureOf(error) }) },
      )
    },
    cancel() {
      close('cancelled')
    },
  }
}

/**
 * The `permissionSwitchConsent` question of the composer's permission control: a switch to full access in a chat whose
 * workspace holds no grant shows the consent first, whose recorded grant switches the chat itself, in the same call, so the
 * surface submits nothing more and a device confirms once. Every other
 * switch, every switch in a profile that does not ask for full access per workspace, and every switch to full access
 * while dangerous mode is on, is submitted at once.
 * @param fetch - the request function.
 * @param consent - the consent's store.
 * @param sessionId - the chat the switch belongs to.
 * @param preset - the preset the person picked.
 * @param wanted - whether the asker still wants the switch, read when the person confirms.
 * @returns `submit` when the surface submits the switch, `switched` when the recorded grant already switched the chat,
 *   `cancelled` when nothing is to change.
 * @throws {HostRequestError} when the home cannot answer the review; the control then submits nothing.
 */
export async function confirmPermissionSwitch(fetch: HostFetch, consent: Pick<FullAccessConsentSource, 'ask' | 'askSwitch'>, sessionId: string, preset: string, wanted?: () => boolean): Promise<SwitchAnswer> {
  if (preset !== FULL_ACCESS_PRESET) return 'submit'
  // Dangerous mode (chosen in `delorun setup`) makes full access available everywhere without a dialog, on a remote studio too.
  if ((await readEverywhere(fetch)).on) return 'submit'
  let access: WorkspaceAccess | undefined
  try {
    access = await reviewChat(fetch, sessionId)
  } catch (error) {
    // The remote form offers no way to grant, so it only ever answers cancelled.
    if (isRefused(error, LOOPBACK_REQUIRED)) return await consent.ask(undefined) ? 'submit' : 'cancelled'
    // A chat with no folder has no per-workspace permission: it still asks, in the short form, and the home's guard answers the switch with its own reason.
    if (isRefused(error, 'NO_WORKSPACE')) return wanted === undefined ? consent.askSwitch(undefined) : consent.askSwitch(undefined, wanted)
    throw error
  }
  // A profile without the per-workspace consent answers no review: the short form is then the only question the person sees.
  // The grant names the chat, so the home switches it in the same call and the surface submits nothing more.
  return consent.askSwitch(access, wanted, sessionId)
}

/**
 * Whether {@link confirmPermissionSwitch} asks its own question for a preset, so upstream's built-in confirmation does
 * not show a second dialog.
 * @param preset - the preset the person picked.
 * @returns true for full access.
 */
export function ownsPermissionConfirmation(preset: string): boolean {
  return preset === FULL_ACCESS_PRESET
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
export type FullAccessConsentProps = PropsLocale<'delorunConsents'> & InjectFace<Omit<FullAccessConsentSource, 'ask' | 'askSwitch'>>

/**
 * The sentence a failure shows.
 * @param t - the consents copy.
 * @param failure - the failure.
 * @param action - the phrase a remote refusal names: changing full access, or allowing an MCP server.
 * @returns the sentence.
 */
export function consentFailureText(t: FullAccessConsentProps['t'], failure: ConsentFailure, action: 'action.changeAccess' | 'action.answerServer' | 'action.changeAgent' = 'action.changeAccess'): string {
  switch (failure.kind) {
    case 'stale': return t('failed.stale')
    case 'remote': return t('loopback', { action: t(action) })
    case 'face': return t('gate.face')
    case 'unreachable': return t('failed.unreachable')
    case 'unreadable': return t('failed.unreadable')
    case 'refused': return failure.message
    /* v8 ignore next 2 -- ConsentFailure is a closed union. */
    default:
      return failure satisfies never
  }
}

/**
 * A failure's line.
 * @param props - the consents copy, the failure and the phrase a remote refusal names.
 * @returns the alert line.
 */
export function ConsentFailureLine({ t, failure, action }: { readonly t: FullAccessConsentProps['t']; readonly failure: ConsentFailure; readonly action?: Parameters<typeof consentFailureText>[2] }): ReactNode {
  return <div className={css.failed} role="alert">
    <p>{consentFailureText(t, failure, action)}</p>
  </div>
}

/**
 * Render the open consent.
 * @param props - the consent hook, its answers and the copy.
 * @returns the dialog, or nothing while no consent is open.
 */
export function FullAccessConsent({ useConsent, confirm, cancel, t }: FullAccessConsentProps): ReactNode {
  const consent = useConsent(current => current)
  if (consent === null) return null
  // Keyed by the consent's sequence so a second ask starts with the acknowledgement unticked.
  return <OpenConsent key={consent.seq} consent={consent} confirm={confirm} cancel={cancel} t={t} />
}

/** Props of {@link OpenConsent}. */
interface OpenConsentProps {
  readonly consent: NonNullable<FullAccessConsentState>
  readonly confirm: () => void
  readonly cancel: () => void
  readonly t: FullAccessConsentProps['t']
}

/**
 * The dialog of one open consent, which holds the risk acknowledgement.
 * @param props - the open consent, its answers and the copy.
 * @returns the dialog.
 */
function OpenConsent({ consent, confirm, cancel, t }: OpenConsentProps): ReactNode {
  const [acknowledged, setAcknowledged] = useState(false)
  const access = consent.access
  const short = consent.form === 'switch'
  // While the grant is recorded the consent stays open, so its outcome is the one the person sees.
  const close = (): void => { if (!consent.busy) cancel() }
  const acknowledge = consent.acknowledge
    ? <Checkbox checked={acknowledged} onChange={setAcknowledged} label={t('consent.acknowledge')} disabled={consent.busy} className={css.text} />
    : null
  return <Dialog open onClose={close} title={t(short ? 'switch.title' : 'consent.title')} closeLabel={t('consent.close')}
    actions={<>
      <Button variant="secondary" data-modal-autofocus disabled={consent.busy} onClick={close}>{t('consent.cancel')}</Button>
      {consent.form === 'remote' ? null
        : <Button variant="primary" disabled={consent.busy || (consent.acknowledge && !acknowledged)} onClick={confirm}>{t(short ? 'switch.confirm' : 'consent.confirm')}</Button>}
    </>}>
    {short
      ? <div className={css.consent}>
        <p className={css.text}>{t('switch.risk')}</p>
        {acknowledge}
        {consent.failure === undefined ? null : <ConsentFailureLine t={t} failure={consent.failure} />}
      </div>
      : access === undefined
      ? <p className={css.text}>{t('consent.remote')} <code className={css.command}>{FULL_ACCESS_COMMAND}</code></p>
      : <div className={css.consent}>
        <p className={css.text}>{t('consent.allows', { workspace: workspaceName(access) })}</p>
        <p className={css.text}>{t('consent.risk')}</p>
        {acknowledge}
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
        {consent.failure === undefined ? null : <ConsentFailureLine t={t} failure={consent.failure} />}
      </div>}
  </Dialog>
}
