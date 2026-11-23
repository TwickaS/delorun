/**
 * The undo notice at the sidebar's foot, after T3 Code's `SidebarThreadUndoNotice`
 * (`apps/web/src/components/sidebar/SidebarThreadUndoNotice.tsx`, MIT,
 * © 2026 T3 Tools Inc.): what the last change was and Undo, in the free space
 * of the foot's row, so it never moves or covers the list. It is the studio's
 * alert card (`Alert`, banner row, success), a status that takes no focus.
 */
import type { InjectFace, OwnerOf, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: the 'sidebar.footer.action' SlotMap entry.
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import { Alert } from '@delorun/brand/alert'
import { useSyncExternalStore } from 'react'
import type { UndoLine } from './undo.ts'
import css from './Foot.module.css'

/** What the notice reads. */
export interface UndoNoticeInjected {
  readonly undoLine: UndoLine
}

/** The notice's props: the foot's width, the copy and the undo line. */
export type UndoNoticeProps = OwnerOf<'sidebar.footer.action'> & PropsLocale<'delorunSidebar'> & InjectFace<UndoNoticeInjected>

/**
 * Render the notice while a change can be taken back, in the wide sidebar.
 * @param props - the foot's width, the copy and the undo line.
 * @returns the notice, or nothing.
 */
export function UndoNotice({ wide, undoLine, t }: UndoNoticeProps) {
  const entry = useSyncExternalStore(listener => undoLine.subscribe(listener), () => undoLine.getSnapshot())
  if (!wide || entry === null) return null
  return (
    <Alert key={entry.key} kind="success" variant="banner" className={css.undo} title={t(`undo.${entry.kind}`)}
      primary={{ label: t('undo'), onClick: () => {
        undoLine.set(null)
        entry.undo()
      } }} />
  )
}
