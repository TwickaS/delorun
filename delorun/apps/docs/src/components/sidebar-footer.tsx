/**
 * The bottom of the docs sidebar and of its phone drawer: one row of normal control height, with the language picker
 * taking the width and the theme control beside it.
 *
 * @module @delorun/docs/sidebar-footer
 */
import { LanguageSelect, LanguageSelectText } from 'fumadocs-ui/layouts/shared/slots/language-select'
import { ThemeControl } from '@design/theme-control.tsx'
import type { ThemeCopy } from '@design/shell-copy.ts'

/** The language picker's button: as high as the theme control beside it, left-aligned, taking the row's width. */
const LANGUAGE = 'h-9 min-w-0 flex-1 justify-start gap-2 px-2.5 text-start text-fd-muted-foreground' // us-spelling: quoted output (Tailwind class names)

/**
 * The footer row.
 * @param props.theme - the theme control's text in the page's locale.
 * @returns the row.
 */
export function SidebarFooter({ theme }: { theme: ThemeCopy }) {
  return (
    <div className="flex items-center gap-2" data-sidebar-footer="">
      <LanguageSelect variant="secondary" className={LANGUAGE}>
        <svg aria-hidden="true" viewBox="0 0 24 24" className="size-4 shrink-0" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3z" />
        </svg>
        <LanguageSelectText className="truncate" />
      </LanguageSelect>
      <ThemeControl copy={theme} variant="row" />
    </div>
  )
}
