/**
 * Parts the Changes section's groups share: a titled group, a read that a dialog or group waits for with its loading
 * line, the review dialogs' classes, plural keys, and what a control's button says about who may use it.
 */
import { useEffect, useState, type ReactNode } from 'react'
import { StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { ChangesControl, ChangesStateView, MayView } from '../wire.ts'
import css from './ChangesSection.module.css'

/** The dictionary the section's parts read. */
export type T = TranslateNS<'delorunChanges'>

/** The review dialogs' classes: wider than a confirmation, with the detail scrolling inside. The module defines both. */
export const WIDE_DIALOG = { className: String(css.wideDialog), contentClassName: String(css.wideContent) }

/** How many hex digits of a version the person reads, as the terminal prints it. */
export const SHORT_VERSION = 7

/**
 * The key of the singular or the plural copy for a count.
 * @param base - the key without its `.one` or `.other` suffix.
 * @param count - the count the copy states.
 * @returns the key to translate.
 */
export function pluralKey<B extends string>(base: B, count: number) {
  return `${base}.${count === 1 ? 'one' : 'other'}` as const
}

/**
 * One titled list of the section.
 * @param props - the heading, an optional line under it, and the rows.
 * @returns the group.
 */
export function Group({ heading, lead, children }: { readonly heading: string, readonly lead?: ReactNode, readonly children: ReactNode }) {
  return <section className={css.group} aria-label={heading}>
    <h3 className={css.groupHeading}>{heading}</h3>
    {lead}
    <ul className={css.rows}>{children}</ul>
  </section>
}

/** A read the dialogs and the groups wait for: loading, failed, or the answer. */
export type Loaded<V> = { readonly status: 'loading' } | { readonly status: 'error' } | { readonly status: 'ready', readonly value: V }

/**
 * Read once when a dialog or group mounts, and again each time `key` changes.
 * @param read - the read.
 * @param key - a value whose change reads again; a dialog keyed by its change reads once.
 * @returns the read's progress; a read again keeps the last answer until the new one arrives.
 */
export function useLoaded<V>(read: () => Promise<V>, key = ''): Loaded<V> {
  const [loaded, setLoaded] = useState<Loaded<V>>({ status: 'loading' })
  useEffect(() => {
    let live = true
    read().then(
      (value) => { if (live) setLoaded({ status: 'ready', value }) },
      (error: unknown) => {
        console.warn('delorun-changes: the change was not read:', error)
        if (live) setLoaded({ status: 'error' })
      },
    )
    return () => { live = false }
    // `read` is a new function on each render; `key` names what it reads.
  }, [key])
  return loaded
}

/**
 * The loading line or the failure of a dialog's read.
 * @param props - the progress and its copy.
 * @returns the line, or nothing once read.
 */
export function LoadLine({ loaded, t }: { readonly loaded: Loaded<unknown>, readonly t: T }) {
  if (loaded.status === 'loading') return <p className={css.meta} role="status">{t('review.loading')}</p>
  if (loaded.status === 'error') return <p className={css.failureText} role="alert"><StateDot state="error" />{t('review.failed')}</p>
  return null
}

/** Whether a control's button is offered, and the hover text of one that is not. */
export interface ControlUse {
  /** The button is disabled: the control needs the computer. A control that needs an unlock stays enabled and asks for it. */
  readonly disabled: boolean
  readonly title: string | undefined
}

/**
 * What the state says about one control for this page.
 * @param state - the state.
 * @param control - the control.
 * @returns what the control needs, `ok` when this page may use it now.
 */
export function mayOf(state: ChangesStateView, control: ChangesControl): MayView {
  return state.access.may[control]
}

/**
 * Whether a control's button is offered: one the level keeps at the computer is disabled with a hover text; one that
 * needs an unlock stays enabled, so pressing it opens the unlock dialog the route asks for.
 * @param state - the state.
 * @param control - the control.
 * @param t - the dictionary.
 * @returns the button's state.
 */
export function controlUse(state: ChangesStateView, control: ChangesControl, t: T): ControlUse {
  const may = mayOf(state, control)
  if (may.ok) return { disabled: false, title: undefined }
  if (may.needs === 'computer') return { disabled: true, title: t('access.needsComputer') }
  return { disabled: false, title: t(may.needs === 'face' ? 'access.needsFace' : 'access.needsUnlock') }
}
