// PluginEntry: the row a plugin list draws for one plugin, shared by the plugin market's Discover tab and any other
// list that offers plugins, so both read the same: framed artwork, the title with its badges, a summary, a quiet
// meta line and one action at the end.

import { useState, type LiHTMLAttributes, type ReactNode } from 'react'
import { PluginArtworkDefault } from './plugin-artwork.tsx'
import css from './PluginEntry.module.css'

/** Artwork size inside the 48px icon frame. */
const ARTWORK = 36

/** The element of each heading level a title may take. */
const HEADINGS = { 2: 'h2', 3: 'h3', 4: 'h4', 5: 'h5', 6: 'h6' } as const

/**
 * Render a plugin's artwork in the 48px icon frame. An absent address, or an image that fails to load, shows the
 * default plugin artwork.
 * @param props.src - the image address, if the plugin has artwork.
 * @param props.skeleton - draw the frame as a loading placeholder instead.
 * @returns the frame, hidden from assistive technology because the title names the plugin.
 */
export function PluginEntryIcon({ src, skeleton = false }: {
  src?: string | undefined
  skeleton?: boolean
}): ReactNode {
  const [failed, setFailed] = useState<string>()
  if (skeleton) return <span className={`${css.icon} ${css.fill}`} aria-hidden="true" />
  return (
    <span className={css.icon} aria-hidden="true">
      {src === undefined || src === failed
        ? <PluginArtworkDefault size={ARTWORK} />
        : (
          <img className={css.image} src={src} width={ARTWORK} height={ARTWORK} alt="" loading="lazy" referrerPolicy="no-referrer"
            onError={() => { setFailed(src) }} />
        )}
    </span>
  )
}

/** Props of {@link PluginEntryList}. */
export interface PluginEntryListProps {
  /** Whether the entries are being replaced, announced as `aria-busy`. */
  busy?: boolean | undefined
  /** The accessible name of the list, when the page has no heading for it. */
  label?: string | undefined
  /** The {@link PluginEntryCard}s. */
  children?: ReactNode
}

/**
 * Render the list that holds plugin entries.
 * @param props - see {@link PluginEntryListProps}.
 * @returns the list.
 */
export function PluginEntryList({ busy, label, children }: PluginEntryListProps): ReactNode {
  return <ul className={css.list} aria-busy={busy} aria-label={label}>{children}</ul>
}

/** Props of {@link PluginEntryCard}; other list-item attributes, such as `data-*` hooks, reach the `<li>`. */
export interface PluginEntryCardProps extends Omit<LiHTMLAttributes<HTMLLIElement>, 'title' | 'children'> {
  /** The plugin's title in the page's language. */
  title: string
  /** The artwork's address; the default plugin artwork shows when absent. */
  icon?: string | undefined
  /**
   * Open the plugin's page. When set, the title is a button that covers the whole card, and the action stays above it;
   * when absent, the card does not highlight on hover, since pressing it does nothing.
   */
  onOpen?: (() => void) | undefined
  /** The accessible name of the open button, such as "Open Browser"; the title when absent. */
  openLabel?: string | undefined
  /** The heading level of a title that opens nothing, so a screen reader can walk the list by headings; plain text when absent. */
  heading?: 2 | 3 | 4 | 5 | 6 | undefined
  /** Read-only badges after the title, usually `Tag`s. */
  badges?: ReactNode
  /** The summary under the title. */
  description?: ReactNode
  /**
   * Keep the title and summary to one line each (default). A list with no page to open passes false, so the full
   * description shows and the row's content aligns to its top.
   */
  clamp?: boolean
  /** The quiet line under the summary: version, author, date, or what the plugin fits. */
  meta?: ReactNode
  /** The one action at the end of the row: a button or a state mark. */
  action?: ReactNode
  /** Content under the meta line in the text column, such as a download's progress or a state line. */
  children?: ReactNode
}

/**
 * Render one plugin entry: framed artwork, the title with its badges, the summary, the meta line, the content under
 * them and the action at the end.
 * @param props - see {@link PluginEntryCardProps}.
 * @returns the list item.
 */
export function PluginEntryCard({
  title, icon, onOpen, openLabel, heading, badges, description, clamp = true, meta, action, children, className, ...item
}: PluginEntryCardProps): ReactNode {
  const Title = heading === undefined ? 'span' : HEADINGS[heading]
  return (
    <li {...item} className={className === undefined ? css.card : `${css.card} ${className}`}
      data-static={onOpen === undefined ? '' : undefined} data-clamp={clamp ? undefined : 'false'}>
      <PluginEntryIcon src={icon} />
      <div className={css.main}>
        <div className={css.titleRow}>
          {onOpen === undefined
            ? <Title className={css.title}>{title}</Title>
            : <button type="button" className={`${css.title} ${css.open}`} aria-label={openLabel} onClick={onOpen}>{title}</button>}
          {badges}
        </div>
        {description === undefined ? null : <div className={css.description}>{description}</div>}
        {meta === undefined ? null : <span className={css.meta}>{meta}</span>}
        {children}
      </div>
      {action === undefined ? null : <div className={css.end}>{action}</div>}
    </li>
  )
}

/**
 * Render one placeholder row that mirrors an entry's artwork, title and summary, for a list whose entries arrive one
 * by one.
 * @returns the list item, hidden from assistive technology; the list or the page announces the wait.
 */
export function PluginEntryPlaceholder(): ReactNode {
  return (
    <li className={css.card} aria-hidden="true">
      <PluginEntryIcon skeleton />
      <div className={css.main}>
        <span className={`${css.bar} ${css.barTitle} ${css.fill}`} />
        <span className={`${css.bar} ${css.barDescription} ${css.fill}`} />
      </div>
    </li>
  )
}

/**
 * Render placeholder entries while a plugin list loads: the list is one status region the label names.
 * @param props.label - the localized loading announcement.
 * @param props.count - how many placeholder rows to draw (default 4).
 * @returns the placeholder list.
 */
export function PluginEntrySkeleton({ label, count = 4 }: { label: string; count?: number }): ReactNode {
  return (
    <ul className={css.list} role="status" aria-label={label} aria-busy="true">
      {Array.from({ length: count }, (_, index) => <PluginEntryPlaceholder key={index} />)}
    </ul>
  )
}
