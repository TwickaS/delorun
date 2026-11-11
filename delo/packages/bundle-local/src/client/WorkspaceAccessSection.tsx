/**
 * The Workspace access settings section: every workspace the home knows with its full access, where the person turns
 * full access on through the consent or off again. Every request goes to the home through the injected `fetch`; the
 * home answers only its own computer, and the section says so in place on a remote studio.
 */
import { useCallback, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { readWorkspaces, setFullAccess, type WorkspaceAccess, type WorkspacesAnswer } from './consents-api.ts'
import { consentFailureOf, consentFailureText, FULL_ACCESS_COMMAND, type FullAccessConsentSource } from './FullAccessConsent.tsx'
import type { HostFetch } from './host-api.ts'
import css from './ConsentSections.module.css'

/** What the plugin supplies the section. */
export interface WorkspaceAccessSectionInjected {
  /** Sends the section's same-origin requests: the browser's `fetch`, or a spec's fake. */
  fetch: HostFetch
  /** Shows the consent and waits for the person's answer. */
  ask: FullAccessConsentSource['ask']
}

/** Props the renderer binds for the section. */
export type WorkspaceAccessSectionProps = PropsRuntime<'settings.section'> & PropsLocale<'deloConsents'> & InjectFace<WorkspaceAccessSectionInjected>

type Translate = WorkspaceAccessSectionProps['t']

/** The list's state: not answered yet, answered, not mounted in this profile, or failed with the sentence to show. */
type Listing =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly value: WorkspacesAnswer }
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
 * The name a workspace row shows: its registered title, or its folder's last segment.
 * @param access - the workspace.
 * @returns the name.
 */
function nameOf(access: WorkspaceAccess): string {
  return access.title ?? access.workspace.split(/[\\/]/).filter(part => part !== '').at(-1) ?? access.workspace
}

/**
 * Render the section.
 * @param props - the copy, the request function and the consent.
 * @returns the section.
 */
export function WorkspaceAccessSection({ t, fetch, ask }: WorkspaceAccessSectionProps): ReactNode {
  const [listing, setListing] = useState<Listing>({ kind: 'loading' })
  const [outcome, setOutcome] = useState<{ readonly workspace: string; readonly text: string; readonly failed: boolean } | undefined>()
  const [busy, setBusy] = useState<string | undefined>()

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const value = await readWorkspaces(fetch)
      setListing(value === undefined ? { kind: 'unavailable' } : { kind: 'ready', value })
    } catch (error) {
      const failure = consentFailureOf(error)
      setListing(failure.kind === 'remote' ? { kind: 'remote' } : { kind: 'failed', text: consentFailureText(t, failure) })
    }
  }, [fetch, t])
  useEffect(() => { void refresh() }, [refresh])

  const turnOn = async (access: WorkspaceAccess): Promise<void> => {
    setOutcome(undefined)
    if (await ask(access)) await refresh()
  }

  const turnOff = async (access: WorkspaceAccess): Promise<void> => {
    setOutcome(undefined)
    setBusy(access.workspace)
    try {
      const change = await setFullAccess(fetch, access, false)
      setOutcome({ workspace: access.workspace, failed: false, text: t('access.turnedOff', { workspace: nameOf(access), count: String(change.chats) }) })
    } catch (error) {
      setOutcome({ workspace: access.workspace, failed: true, text: consentFailureText(t, consentFailureOf(error)) })
    } finally {
      setBusy(undefined)
    }
    await refresh()
  }

  return <div className={css.section}>
    <h2 className={css.heading}>{t('access.title')}</h2>
    {listing.kind === 'unavailable'
      ? <p className={css.line}>{t('access.unavailable')}</p>
      : <>
        <p className={css.intro}>{t('access.intro')}</p>
        {listing.kind === 'remote'
          ? <p className={css.line} role="status">{t('consent.remote')} <code className={css.command}>{FULL_ACCESS_COMMAND}</code></p>
          : null}
        {listing.kind === 'failed' ? <p className={css.failed} role="alert">{listing.text}</p> : null}
        {listing.kind === 'ready' && listing.value.storeProblem !== undefined
          ? <p className={css.failed} role="alert">{t('access.storeProblem', { problem: listing.value.storeProblem })}</p>
          : null}
        {listing.kind === 'ready' && listing.value.workspaces.length === 0 ? <p className={css.line}>{t('access.none')}</p> : null}
        {listing.kind === 'ready' && listing.value.workspaces.length > 0
          ? <ul className={css.list}>
            {listing.value.workspaces.map(access => <li key={access.workspace} className={css.row} data-workspace={access.workspace}>
              <div className={css.details}>
                <div className={css.title}>{nameOf(access)}</div>
                <div className={css.description}>{access.workspace}</div>
                <div className={css.description} data-full-access={access.grantedAt === null ? 'off' : 'on'}>
                  {access.grantedAt === null ? t('access.off') : t('access.on', { time: formatTime(t, access.grantedAt) })}
                </div>
                {outcome?.workspace === access.workspace
                  ? <div className={outcome.failed ? css.failed : css.description} role={outcome.failed ? 'alert' : 'status'}>{outcome.text}</div>
                  : null}
              </div>
              {access.grantedAt === null
                ? <Button variant="outline" size="sm" disabled={busy !== undefined} onClick={() => { void turnOn(access) }}>{t('access.turnOn')}</Button>
                : <Button variant="outline" size="sm" disabled={busy !== undefined} onClick={() => { void turnOff(access) }}>{t('access.turnOff')}</Button>}
            </li>)}
          </ul>
          : null}
      </>}
  </div>
}
