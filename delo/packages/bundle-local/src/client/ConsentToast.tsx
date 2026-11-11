/**
 * The outcome of an answer given in the Permissions section, such as a revoke, shown as one toast in `shell.overlay`.
 * The toast lives outside the section, so a list that changes after the answer, or a section that closes, does not
 * take the outcome with it.
 */
import type { ReactNode } from 'react'
import { IconWarningOutlineRegular, Toast } from '@deepseek-ai/dsh-client-ui-primitives'
import type { HostObservable, InjectFace, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'

/** The shown outcome, keyed by its sequence so a second outcome restarts the toast; null while none shows. */
export type ConsentToastState = { readonly seq: number; readonly text: string; readonly failed: boolean } | null

/** The store surfaces report into and the overlay entry reads. */
export interface ConsentToastSource {
  /** The outcome for the overlay entry. */
  readonly hooks: { readonly toast: HostObservable<ConsentToastState> }
  /**
   * Show one outcome.
   * @param text - the outcome's sentence.
   * @param failed - whether the answer was not recorded.
   */
  readonly show: (text: string, failed: boolean) => void
  /** Clear the shown outcome. */
  readonly dismiss: () => void
}

/**
 * Create the toast's store.
 * @returns the observable outcome with its show and dismiss actions.
 */
export function createConsentToastSource(): ConsentToastSource {
  let state: ConsentToastState = null
  let seq = 0
  const listeners = new Set<() => void>()
  const publish = (next: ConsentToastState): void => {
    state = next
    for (const listener of listeners) listener()
  }
  return {
    hooks: {
      toast: {
        getSnapshot: () => state,
        subscribe(listener) {
          listeners.add(listener)
          return () => { listeners.delete(listener) }
        },
      },
    },
    show: (text, failed) => { publish({ seq: ++seq, text, failed }) },
    dismiss: () => { publish(null) },
  }
}

/** Props of the `shell.overlay` entry: the toast's store and the consents copy. */
export type ConsentToastProps = PropsLocale<'deloConsents'> & InjectFace<Omit<ConsentToastSource, 'show'>>

/**
 * Render the outcome while it shows.
 * @param props - the toast hook and its dismissal.
 * @returns the toast, or nothing.
 */
export function ConsentToast({ useToast, dismiss }: ConsentToastProps): ReactNode {
  const toast = useToast(current => current)
  if (toast === null) return null
  return toast.failed
    ? <Toast key={toast.seq} text={toast.text} icon={<IconWarningOutlineRegular />} onDone={dismiss} />
    : <Toast key={toast.seq} text={toast.text} tone="success" onDone={dismiss} />
}
