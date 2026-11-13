/**
 * The footer below a page's text: one line per child, in the muted small type. It reads no content.
 *
 * @module @delo/site-design/footer
 */
import type { ReactNode } from 'react'

/**
 * The page footer.
 * @param props.children - the footer's lines.
 * @returns the footer.
 */
export function PageFooter({ children }: { children: ReactNode }) {
  return <footer className="mt-8 flex flex-col gap-1 text-sm text-fd-muted-foreground">{children}</footer>
}
