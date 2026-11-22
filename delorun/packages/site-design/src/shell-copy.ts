/**
 * The text the shared header, footer and theme control show. The caller passes it in its own language; this package holds
 * no wording of its own, so the Chinese pages of the documentation and the English pages of the product site use the same
 * components.
 *
 * @module @delorun/site-design/shell-copy
 */
import type { LookId } from './looks.ts'

/** The text of the theme control. */
export interface ThemeCopy {
  /** The control's accessible name, for the button that opens the menu. */
  readonly open: string
  /** The menu's heading. */
  readonly title: string
  /** The name of the theme group. */
  readonly themes: string
  /** The name of the light or dark group. */
  readonly scheme: string
  /** The choice that follows the device's setting. */
  readonly device: string
  readonly light: string
  readonly dark: string
  /** The button that returns the page to how it started. */
  readonly back: string
  /** The line that names the look the page is in, shown beside the button while a look is chosen; `scheme` is the light or dark word, when one was chosen. */
  readonly current: (name: string, scheme: string | undefined) => string
  /** The row variant's accessible name and tooltip, which name the theme and the scheme the page is in; `scheme` is the light or dark word. Without it the title, the theme's name and the scheme are joined. */
  readonly trigger?: (name: string, scheme: string) => string
  /** The name of each preset theme. */
  readonly names: Readonly<Record<LookId, string>>
  /** The toast that follows a change from the control. */
  readonly toast: ToastCopy
}

/** The text of the toast that says what a change did and names the way back. */
export interface ToastCopy {
  /** The name of the toast region, for assistive technology. */
  readonly region: string
  /** The sentence for a new theme; `name` is the theme's name. */
  readonly theme: (name: string) => string
  /** The sentence for a switch between light and dark; `name` is the scheme's word. */
  readonly scheme: (name: string) => string
  /** The action that undoes the change; `name` is the earlier theme's or scheme's word. */
  readonly undo: (name: string) => string
  /** The sentence after "Back to how it started". */
  readonly reset: string
}

/** A link in the header or the footer. */
export interface ShellLink {
  readonly label: string
  readonly href: string
  /** Whether the link leaves this site for the other one or for another address; a link to the other Delorun site carries the look. */
  readonly site?: 'other'
}

/** The text of the header. */
export interface HeaderCopy {
  /** The product name beside the mark. */
  readonly title: string
  /** The accessible name of the main navigation. */
  readonly navLabel: string
  readonly theme: ThemeCopy
}

/** The text of the footer. */
export interface FooterCopy {
  /** The accessible name of the footer navigation. */
  readonly navLabel: string
  /** The line naming the owner. */
  readonly owner: string
  /** The link to the licence. */
  readonly licence: ShellLink
  /** The credit to the upstream project. */
  readonly upstream: ShellLink
  /** The theme control's text, whose button and toast the footer's "Back to how it started" shares. */
  readonly theme: ThemeCopy
}
