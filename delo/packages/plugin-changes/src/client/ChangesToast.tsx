/** The outcome toast of a Changes action: one frame-wide overlay entry that outlives the Settings dialog that raised it. */
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { IconWarningOutlineRegular, Toast } from '@deepseek-ai/dsh-client-ui-primitives'
import type { HostObservable, InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ChangesNotice } from './controller.ts'

/** The notice on display; `seq` keys the banner so a repeated outcome restarts its hold. */
export type ChangesToastState = ChangesNotice & { readonly seq: number }

/** The store the controller reports into and the overlay entry reads. */
export interface ChangesToastSource {
  /** The notice on display, or null while none shows. */
  readonly hooks: { readonly toast: HostObservable<ChangesToastState | null> }
  /**
   * Show an outcome in place of the one on display.
   * @param notice - the outcome.
   */
  readonly report: (notice: ChangesNotice) => void
  /** Clear the notice on display. */
  readonly dismiss: () => void
}

/**
 * Create the store the overlay entry reads.
 * @returns the observable notice with its report and dismiss actions.
 */
export function createChangesToastSource(): ChangesToastSource {
  const store = createSnapshotStore<ChangesToastState | null>(null)
  let seq = 0
  return {
    hooks: { toast: store },
    report: (notice) => {
      seq += 1
      store.set({ ...notice, seq })
    },
    dismiss: () => { store.set(null) },
  }
}

/** Props of the `shell.overlay` entry: the notice hook, its dismissal and the dictionary. */
export type ChangesToastProps = PropsRuntime<'shell.overlay'>
  & PropsLocale<'deloChanges'>
  & InjectFace<Omit<ChangesToastSource, 'report'>>

/** How long a failure stays, in milliseconds: it may carry an error to read. */
const FAILURE_HOLD_MS = 8000

/**
 * Render the outcome on display: a success with the check, a failure with the warning glyph.
 * @param props - the notice hook, its dismissal and the dictionary.
 * @returns the banner, or nothing.
 */
export function ChangesToast({ useToast, dismiss, t }: ChangesToastProps) {
  const notice = useToast(current => current)
  if (notice === null) return null
  const key = `delo-changes-${String(notice.seq)}`
  const text = t(notice.key, notice.values)
  return notice.ok
    ? <Toast key={key} text={text} tone="success" onDone={dismiss} />
    : <Toast key={key} text={text} icon={<IconWarningOutlineRegular />} holdMs={FAILURE_HOLD_MS} onDone={dismiss} />
}
