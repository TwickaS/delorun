/**
 * The undo notice at the sidebar's foot, T3 Code's `SidebarThreadUndoNotice`
 * (`apps/web/src/components/sidebar/SidebarThreadUndoNotice.tsx`, MIT,
 * © 2026 T3 Tools Inc.): what the last change was and Undo, in the free space
 * of the foot's row, so it never moves or covers the list. It is a small
 * status row, not a dialog, and takes no focus.
 */
import type { InjectFace, OwnerOf, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: the 'sidebar.footer.action' SlotMap entry.
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import { useSyncExternalStore } from 'react'
import type { UndoLine } from './undo.ts'
import css from './Foot.module.css'

/** What the notice reads. */
export interface UndoNoticeInjected {
  readonly undoLine: UndoLine
}

/** The notice's props: the foot's width, the copy and the undo line. */
export type UndoNoticeProps = OwnerOf<'sidebar.footer.action'> & PropsLocale<'deloSidebar'> & InjectFace<UndoNoticeInjected>

/**
 * Render the notice while a change can be taken back, in the wide sidebar.
 * @param props - the foot's width, the copy and the undo line.
 * @returns the notice, or nothing.
 */
export function UndoNotice({ wide, undoLine, t }: UndoNoticeProps) {
  const entry = useSyncExternalStore(listener => undoLine.subscribe(listener), () => undoLine.getSnapshot())
  if (!wide || entry === null) return null
  return (
    <div key={entry.key} className={css.undo} role="status">
      <button type="button" className={css.undoButton} onClick={() => {
        undoLine.set(null)
        entry.undo()
      }}>
        {t('undo')}
      </button>
      <span className={css.undoText}>{`${t(`undo.${entry.kind}`)},`}</span>
    </div>
  )
}
