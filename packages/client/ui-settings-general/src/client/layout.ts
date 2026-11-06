/**
 * Settings layout: an optional arrangement of the Settings navigation into
 * labelled groups of pages, where a page stacks registered sections and cards
 * of General rows. A distribution registers one through `ctx.settingsLayout`;
 * without one the shell keeps its flat section list. The projection here is
 * pure: it drops what is not registered and collects what the layout does not
 * place into a trailing group, so a third-party section or row always shows.
 */
import type { ComponentType } from 'react'
import type { SettingsSectionRow } from './shell-contract.ts'

/** Localized text, resolved each time the navigation is projected. */
export type SettingsLayoutText = () => string

/** One General row placed on a page. */
export interface SettingsLayoutItem {
  /** The row's `settings.general.item` registration id. */
  readonly id: string
  /** The row's name in search results. */
  readonly label: SettingsLayoutText
  /** Further words search matches, space separated. */
  readonly keywords?: SettingsLayoutText
}

/** One block of a page: a registered section, or a card of General rows. */
export type SettingsLayoutBlock =
  | { readonly kind: 'section'; readonly id: string }
  | {
    readonly kind: 'items'
    /** Anchor id of the card, unique on its page. */
    readonly id: string
    /** The card's heading. */
    readonly heading?: SettingsLayoutText
    readonly items: readonly SettingsLayoutItem[]
  }

/** One navigation entry and the page it opens. */
export interface SettingsLayoutPage {
  /** Page id, unique across the layout; the shell's section selection names it. */
  readonly id: string
  readonly label: SettingsLayoutText
  /** The navigation glyph; without one the shell draws the `settings.section.icon` registered for the page id, or its default glyph. */
  readonly icon?: ComponentType<{ size?: number; className?: string | undefined }>
  /** Further words search matches, space separated. */
  readonly keywords?: SettingsLayoutText
  /** The page's first block is a section that draws its own title, so the shell draws none. */
  readonly sectionTitle?: boolean
  readonly blocks: readonly SettingsLayoutBlock[]
}

/** A labelled run of navigation entries. */
export interface SettingsLayoutGroup {
  readonly id: string
  readonly label: SettingsLayoutText
  readonly pages: readonly SettingsLayoutPage[]
}

/** A distribution's arrangement of Settings. */
export interface SettingsLayout {
  readonly groups: readonly SettingsLayoutGroup[]
  /** General rows that show nowhere. */
  readonly hiddenItems?: readonly string[]
  /** The trailing group of sections and General rows no page places. */
  readonly other: {
    readonly label: SettingsLayoutText
    /** The page holding unplaced General rows. */
    readonly itemsLabel: SettingsLayoutText
  }
  /** The search field's copy. */
  readonly search: {
    readonly placeholder: SettingsLayoutText
    readonly empty: SettingsLayoutText
  }
}

/** A projected block with its text resolved. */
export type SettingsNavBlock =
  | { readonly kind: 'section'; readonly id: string; readonly label: string }
  | { readonly kind: 'items'; readonly id: string; readonly heading?: string; readonly items: readonly { readonly id: string; readonly label: string; readonly keywords: string }[] }

/** A projected page. */
export interface SettingsNavPage {
  readonly id: string
  readonly label: string
  readonly icon?: ComponentType<{ size?: number; className?: string | undefined }>
  readonly keywords: string
  /** Whether the shell draws the page's title. */
  readonly titled: boolean
  readonly blocks: readonly SettingsNavBlock[]
}

/** A projected group. */
export interface SettingsNavGroup {
  readonly id: string
  readonly label: string
  readonly pages: readonly SettingsNavPage[]
}

/** The projected navigation and the copy the grouped panel draws. */
export interface SettingsNav {
  readonly groups: readonly SettingsNavGroup[]
  readonly searchPlaceholder: string
  readonly searchEmpty: string
}

/** The General section's entry, which owns every `settings.general.item` row and renders the cards. */
export const GENERAL_SECTION_ID = 'general'

/** The trailing page of unplaced General rows; it shares the General section's id, so opening that section selects it. */
export const UNPLACED_ITEMS_PAGE = GENERAL_SECTION_ID
const OTHER_GROUP = 'other'

/**
 * Project a layout over the registered sections and General rows.
 * @param layout - the registered layout.
 * @param sections - the `settings.section` rows, in order; `general` is the General section's own entry.
 * @param items - the registered `settings.general.item` ids, in order.
 * @returns the groups, pages and blocks that have something to show.
 */
export function projectLayout(layout: SettingsLayout, sections: readonly SettingsSectionRow[], items: readonly string[]): SettingsNav {
  const sectionLabels = new Map(sections.map(row => [row.id, row.label]))
  const registered = new Set(items)
  const hidden = new Set(layout.hiddenItems)
  const placedSections = new Set<string>([GENERAL_SECTION_ID])
  const placedItems = new Set<string>()
  const groups: SettingsNavGroup[] = []
  for (const group of layout.groups) {
    const pages: SettingsNavPage[] = []
    for (const page of group.pages) {
      const blocks: SettingsNavBlock[] = []
      for (const block of page.blocks) {
        if (block.kind === 'section') {
          placedSections.add(block.id)
          const label = sectionLabels.get(block.id)
          if (label !== undefined) blocks.push({ kind: 'section', id: block.id, label })
          continue
        }
        for (const item of block.items) placedItems.add(item.id)
        const shown = block.items
          .filter(item => registered.has(item.id) && !hidden.has(item.id))
          .map(item => ({ id: item.id, label: item.label(), keywords: item.keywords?.() ?? '' }))
        if (shown.length > 0) blocks.push({ kind: 'items', id: block.id, ...(block.heading === undefined ? {} : { heading: block.heading() }), items: shown })
      }
      if (blocks.length > 0) {
        const titled = !(page.sectionTitle === true && blocks[0]?.kind === 'section')
        pages.push({ id: page.id, label: page.label(), ...(page.icon === undefined ? {} : { icon: page.icon }), keywords: page.keywords?.() ?? '', titled, blocks })
      }
    }
    if (pages.length > 0) groups.push({ id: group.id, label: group.label(), pages })
  }
  const other: SettingsNavPage[] = []
  const unplacedItems = items.filter(id => !placedItems.has(id) && !hidden.has(id))
  if (unplacedItems.length > 0) {
    const label = layout.other.itemsLabel()
    other.push({ id: UNPLACED_ITEMS_PAGE, label, keywords: '', titled: true, blocks: [{ kind: 'items', id: UNPLACED_ITEMS_PAGE, items: unplacedItems.map(id => ({ id, label: '', keywords: '' })) }] })
  }
  for (const row of sections) {
    if (placedSections.has(row.id)) continue
    // A section on a page of its own draws its own title, as in the flat list.
    other.push({ id: row.id, label: row.label, keywords: '', titled: false, blocks: [{ kind: 'section', id: row.id, label: row.label }] })
  }
  if (other.length > 0) groups.push({ id: OTHER_GROUP, label: layout.other.label(), pages: other })
  return { groups, searchPlaceholder: layout.search.placeholder(), searchEmpty: layout.search.empty() }
}

/** One search result: the page to open and, for a card or a row, its anchor. */
export interface SettingsSearchResult {
  readonly pageId: string
  /** The `data-settings-anchor` value to scroll to; absent for a whole page. */
  readonly anchor?: string
  /** Page, card and row names, outermost first. */
  readonly path: readonly string[]
}

/**
 * Find pages, cards and rows whose names or keywords contain every word of a query.
 * @param nav - the projected navigation.
 * @param query - the person's search text.
 * @returns matches in navigation order; empty for a blank query.
 */
export function searchNav(nav: SettingsNav, query: string): SettingsSearchResult[] {
  const words = query.toLocaleLowerCase().split(/\s+/).filter(word => word !== '')
  if (words.length === 0) return []
  const matches = (...texts: string[]): boolean => {
    const haystack = texts.join(' ').toLocaleLowerCase()
    return words.every(word => haystack.includes(word))
  }
  const results: SettingsSearchResult[] = []
  for (const group of nav.groups) {
    for (const page of group.pages) {
      const sectionLabels = page.blocks.flatMap(block => (block.kind === 'section' ? [block.label] : []))
      if (matches(page.label, page.keywords, ...sectionLabels)) results.push({ pageId: page.id, path: [page.label] })
      for (const block of page.blocks) {
        if (block.kind !== 'items') continue
        const cardPath = block.heading === undefined ? [page.label] : [page.label, block.heading]
        if (block.heading !== undefined && matches(block.heading)) results.push({ pageId: page.id, anchor: block.id, path: cardPath })
        for (const item of block.items) {
          if (item.label === '' || !matches(item.label, item.keywords)) continue
          results.push({ pageId: page.id, anchor: item.id, path: [...cardPath, item.label] })
        }
      }
    }
  }
  return results
}

/**
 * The registered layout: the latest registration wins, and disposing it
 * restores the one before.
 */
export class SettingsLayoutRegistry {
  private readonly layouts: SettingsLayout[] = []
  private readonly listeners = new Set<() => void>()

  /**
   * Register a layout.
   * @param layout - the arrangement.
   * @returns the disposer.
   */
  register(layout: SettingsLayout): () => void {
    this.layouts.push(layout)
    this.emit()
    return () => {
      const index = this.layouts.lastIndexOf(layout)
      if (index < 0) return
      this.layouts.splice(index, 1)
      this.emit()
    }
  }

  /**
   * Read the layout in force.
   * @returns the layout in force, or `undefined` for the flat list.
   */
  getSnapshot(): SettingsLayout | undefined {
    return this.layouts.at(-1)
  }

  /**
   * Follow registrations.
   * @param listener - called after each change.
   * @returns the unsubscriber.
   */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  private emit(): void {
    for (const listener of [...this.listeners]) listener()
  }
}
