/** The trash's outcome toast: one frame-wide overlay entry that outlives the menu or the Settings row that raised it. */
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { IconWarningOutlineRegular, Toast } from '@deepseek-ai/dsh-client-ui-primitives'
import type { HostObservable, InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { TrashNotice } from './controller.ts'

/** The notice on display; `seq` keys the banner so a repeated outcome restarts its hold. */
export type TrashToastState = TrashNotice & { readonly seq: number }

/** The store the controller reports into and the overlay entry reads. */
export interface TrashToastSource {
  /** The notice on display, or null while none shows. */
  readonly hooks: { readonly toast: HostObservable<TrashToastState | null> }
  /**
   * Show an outcome in place of the one on display.
   * @param notice - the outcome.
   */
  readonly report: (notice: TrashNotice) => void
  /** Clear the notice on display. */
  readonly dismiss: () => void
}

/**
 * Create the store the overlay entry reads.
 * @returns the observable notice with its report and dismiss actions.
 */
export function createTrashToastSource(): TrashToastSource {
  const store = createSnapshotStore<TrashToastState | null>(null)
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
export type TrashToastProps = PropsRuntime<'shell.overlay'>
  & PropsLocale<'delorunTrash'>
  & InjectFace<Omit<TrashToastSource, 'report'>>

/**
 * Render the outcome on display: a success with the check, a failure with the warning glyph.
 * @param props - the notice hook, its dismissal and the dictionary.
 * @returns the banner, or nothing.
 */
export function TrashToast({ useToast, dismiss, t }: TrashToastProps) {
  const notice = useToast(current => current)
  if (notice === null) return null
  const key = `delorun-trash-${String(notice.seq)}`
  return notice.ok
    ? <Toast key={key} text={t(notice.key)} tone="success" onDone={dismiss} />
    : <Toast key={key} text={t(notice.key)} icon={<IconWarningOutlineRegular />} holdMs={6000} onDone={dismiss} />
}
