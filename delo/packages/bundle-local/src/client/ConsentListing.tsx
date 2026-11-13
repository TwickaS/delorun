/**
 * What the Permissions and External agents sections share: one list's load state, the line a list shows in place of its
 * rows, and the time format of its rows.
 * @module bundle-local/client/ConsentListing
 */
import type { ReactNode } from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { consentFailureOf, consentFailureText } from './FullAccessConsent.tsx'
import css from './ConsentSections.module.css'

/** The consents dictionary's lookup. */
export type Translate = PropsLocale<'deloConsents'>['t']

/** One list's state: not answered yet, answered, not mounted in this profile, remote, or failed with the sentence. */
export type Listing<T> =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly value: T }
  | { readonly kind: 'unavailable' }
  | { readonly kind: 'remote' }
  | { readonly kind: 'failed'; readonly text: string }

/** What a group renders from: the copy, its list, and whether an answer is being sent. */
export interface GroupProps<T> {
  readonly t: Translate
  readonly listing: Listing<T>
  readonly busy: boolean
}

/**
 * A moment as the sections show it, in the sections' locale.
 * @param t - the copy, whose `time.locale` names the locale.
 * @param at - milliseconds since the epoch.
 * @returns the date and time.
 */
export function formatTime(t: Translate, at: number): string {
  return new Intl.DateTimeFormat(t('time.locale'), { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(at))
}

/**
 * Read one list into its state.
 * @param t - the copy.
 * @param read - the request.
 * @returns the state the request answered.
 */
export async function readListing<T>(t: Translate, read: () => Promise<T | undefined>): Promise<Listing<T>> {
  try {
    const value = await read()
    return value === undefined ? { kind: 'unavailable' } : { kind: 'ready', value }
  } catch (error) {
    const failure = consentFailureOf(error)
    return failure.kind === 'remote' ? { kind: 'remote' } : { kind: 'failed', text: consentFailureText(t, failure) }
  }
}

/**
 * The lines a list shows before its rows: why it has none, or why it could not be read.
 * @param t - the copy.
 * @param state - the list.
 * @param unavailable - the line for a profile that mounts no list.
 * @returns the line, or nothing for a list that is remote or ready.
 */
export function listLine(t: Translate, state: Listing<unknown>, unavailable: 'access.unavailable' | 'mcp.unavailable' | 'agents.unavailable'): ReactNode {
  if (state.kind === 'loading') return <p className={css.boxLine} aria-busy="true">{t('permissions.loading')}</p>
  if (state.kind === 'unavailable') return <p className={css.boxLine}>{t(unavailable)}</p>
  if (state.kind === 'failed') return <p className={css.boxFailed} role="alert">{state.text}</p>
  return null
}
