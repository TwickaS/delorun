/**
 * The Main chat row's glyph: a house, with the completed-chat dot while
 * reports wait in the main chat. The row leads the sidebar and selects the
 * panel that opens the main chat, which the sidebar's chat list leaves out.
 */
import { StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import type { HostObservable, OwnerOf, PropsHooks, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: the 'sidebar.panellist' SlotMap entry.
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import css from './MainChatEntry.module.css'

/** What the row's glyph reads: whether reports reached the main chat since the person last had it on screen. */
export interface MainChatIconInjected {
  readonly hooks: { readonly unread: HostObservable<boolean> }
}

/** The glyph's props: the sidebar's icon share, the unread hook and the dictionary. */
export type MainChatIconProps = OwnerOf<'sidebar.panellist'> & PropsHooks<MainChatIconInjected['hooks']> & PropsLocale<'deloMainChat'>

/**
 * Render the row's glyph at the size the sidebar asks for, with the sidebar's
 * completed-chat dot while a report is unread; the sidebar owns the row, its
 * label and its selected state.
 * @param props - the sidebar's icon share: the requested edge and whether the panel is selected; the unread hook; the dictionary.
 * @returns the glyph.
 */
export function MainChatIcon({ size, useUnread, t }: MainChatIconProps) {
  const unread = useUnread(value => value)
  return (
    <span className={css.icon}>
      <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <path d="M2.5 7.2 8 2.5l5.5 4.7V13a.5.5 0 0 1-.5.5H9.5V10h-3v3.5H3a.5.5 0 0 1-.5-.5Z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
      </svg>
      {unread && (
        <span className={css.unread} data-delo-main-chat-unread="" role="img" aria-label={t('row.unread')}>
          <StateDot state="done" />
        </span>
      )}
    </span>
  )
}
