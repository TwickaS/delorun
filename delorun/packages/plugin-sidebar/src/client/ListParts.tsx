/**
 * The chat list's smaller parts: the divider under Pinned, a shelf's header, a Workspace folder's header and the
 * scroll fade. Ported from T3 Code's sidebar (`apps/web/src/components/Sidebar.tsx`, MIT, © 2026 T3 Tools Inc.).
 * @module @delorun/plugin-sidebar/client/ListParts
 */
import { IconChevronDownOutlineRegular, IconChevronRightOutlineRegular, IconNewChatOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import { cx } from './cx.ts'
import { useEffect, useRef } from 'react'
import type { badgeColor } from './sections.ts'
import { folderDot, sidebarItemId, type SidebarFolder } from './sections.ts'
import { WorkspaceBadge } from './WorkspaceBadge.tsx'
import type { SidebarLocaleKey } from './locales.ts'
import css from './Sidebar.module.css'

/** The translate function the parts take. */
export type Translate = (key: SidebarLocaleKey, params?: Record<string, string | number>) => string

/** The shelves that fold. */
export type Shelf = 'working' | 'snoozed' | 'settled'

/**
 * The marker under the pinned chats, T3 Code's drag boundary: nothing while idle; while a chat is dragged, Pinned above
 * a rule, in the accent where the drop pins.
 * @param props - whether a drag is on, whether the drop pins, and the label.
 * @returns the marker.
 */
export function PinnedDivider({ dragging, target, label }: { readonly dragging: boolean; readonly target: boolean; readonly label: string }) {
  return (
    <li data-drag-id={sidebarItemId({ kind: 'marker', marker: 'pinned-divider' })} className={css.divider} data-dragging={dragging} data-target={target} aria-hidden={!dragging}>
      {dragging && (
        <span className={css.boundary}>
          <span className={css.boundaryLabel}>{label}</span>
          <span className={css.boundaryRule} />
        </span>
      )}
    </li>
  )
}

/**
 * Keep a scroll box's `--overflow-start` and `--overflow-end`, how far its content runs past each end, for T3 Code's
 * scroll fade.
 * @returns the ref for the scroll box.
 */
export function useScrollFade() {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const box = ref.current as HTMLDivElement
    const measure = (): void => {
      const end = Math.max(0, box.scrollHeight - box.clientHeight - box.scrollTop)
      box.style.setProperty('--overflow-start', `${String(box.scrollTop)}px`)
      box.style.setProperty('--overflow-end', `${String(end)}px`)
    }
    measure()
    box.addEventListener('scroll', measure, { passive: true })
    const observer = new ResizeObserver(measure)
    observer.observe(box)
    for (const child of box.children) observer.observe(child)
    return () => {
      box.removeEventListener('scroll', measure)
      observer.disconnect()
    }
  }, [])
  return ref
}

/**
 * A shelf's header: its name, a rule, its count and a chevron; pressing it folds the shelf.
 * @param props - the shelf, its count, whether it is open, what pressing does, whether it is first and whether a drag is over it.
 * @returns the header.
 */
export function ShelfHeader({ shelf, label, count, expanded, onToggle, first, over }: {
  readonly shelf: Shelf
  readonly label: string
  readonly count: number
  readonly expanded: boolean
  /** What pressing does; a shelf that only shows where a drop lands has none. */
  readonly onToggle: (() => void) | undefined
  /** Whether this is the first shelf, which the free space above pushes to the bottom. */
  readonly first: boolean
  /** Whether the dragged chat is over this header. */
  readonly over: boolean
}) {
  return (
    <li data-drag-id={sidebarItemId({ kind: 'marker', marker: `${shelf}-header` })} data-over={over} className={cx(css.shelfItem, first && css.firstShelf)}>
      <button type="button" className={css.shelfHeader} aria-expanded={expanded} disabled={onToggle === undefined} onClick={onToggle}>
        <span className={css.shelfLabel}>{label}</span>
        <span className={css.shelfRule} aria-hidden="true" />
        <span className={css.shelfCount}>{count}</span>
        <IconChevronDownOutlineRegular size={12} className={cx(css.chevron, !expanded && css.chevronFolded)} />
      </button>
    </li>
  )
}

/**
 * A Workspace folder's header, after T3 Code's project row: a chevron, the badge and name, a dot for what waits inside
 * while it is folded, its count, and New chat on hover.
 * @param props - the folder, its badge colour, whether it is open, what pressing and New chat do, and the dictionary.
 * @returns the header.
 */
export function FolderHeader({ folder, color, expanded, onToggle, onNewChat, t }: {
  readonly folder: SidebarFolder
  readonly color: ReturnType<typeof badgeColor>
  readonly expanded: boolean
  readonly onToggle: () => void
  readonly onNewChat: (() => void) | undefined
  readonly t: Translate
}) {
  const name = folder.workspace?.title ?? t('folder.loose')
  const dot = expanded ? null : folderDot(folder.chats)
  return (
    <li className={css.folderItem}>
      <div className={css.folder}>
        <button type="button" className={css.folderHeader} aria-expanded={expanded} onClick={onToggle}>
          <IconChevronRightOutlineRegular size={14} className={cx(css.folderChevron, expanded && css.folderChevronOpen)} />
          {folder.workspace !== null && <WorkspaceBadge title={folder.workspace.title} workspaceId={folder.workspace.workspaceId} color={color} />}
          <span className={css.folderName}>{name}</span>
          {dot !== null && <span className={css.folderDot} data-dot={dot} role="img" aria-label={t(`folder.${dot}`)} />}
          <span className={css.folderCount}>{folder.chats.length}</span>
        </button>
        {onNewChat !== undefined && (
          <button type="button" className={css.folderNew} aria-label={t('chat.newIn', { name })} title={t('chat.newIn', { name })} onClick={onNewChat}>
            <IconNewChatOutlineRegular size={16} className={css.icon} />
          </button>
        )}
      </div>
    </li>
  )
}
