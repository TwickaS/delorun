/**
 * A row of tabs and the panel they control, after the WAI-ARIA tabs pattern: one tab stop, the arrow keys, Home and
 * End move the selection, and the panel is named by its selected tab. The panel is a separate component so a page may
 * place it above or beside the row, as the replays' chapter rail does.
 * @module @delorun/brand/components/TabList
 */
import { useRef, type KeyboardEvent, type ReactNode } from 'react'
import css from './TabList.module.css'

/** One tab: a stable id and its localised label. */
export interface Tab<T extends string> {
  readonly id: T
  readonly label: ReactNode
}

/** The props of {@link TabList}. */
export interface TabListProps<T extends string> {
  /** The localised name of the row, read before its tabs. */
  readonly label: string
  readonly tabs: readonly Tab<T>[]
  readonly selected: T
  /** Called with the tab a press or an arrow key chose. */
  readonly onSelect: (id: T) => void
  /** The prefix of the tabs' and the panel's element ids; the same value goes to {@link TabPanel}. */
  readonly idBase: string
  readonly className?: string | undefined
}

/** The props of {@link TabPanel}. */
export interface TabPanelProps<T extends string> {
  /** The {@link TabListProps.idBase} of the row that controls the panel. */
  readonly idBase: string
  readonly selected: T
  readonly className?: string | undefined
  readonly children: ReactNode
}

const tabId = (idBase: string, id: string): string => `${idBase}-tab-${id}`
const panelId = (idBase: string): string => `${idBase}-panel`

/** The index a navigation key moves to in a row of `count` tabs, or undefined for any other key. */
function target(key: string, at: number, count: number): number | undefined {
  switch (key) {
    case 'ArrowRight': return (at + 1) % count
    case 'ArrowLeft': return (at - 1 + count) % count
    case 'Home': return 0
    case 'End': return count - 1
    default: return undefined
  }
}

/**
 * Render the row of tabs. Selection follows focus: an arrow key selects the tab it moves to.
 * @param props - see {@link TabListProps}.
 * @returns the tab list.
 */
export function TabList<T extends string>({ label, tabs, selected, onSelect, idBase, className }: TabListProps<T>) {
  const buttons = useRef(new Map<T, HTMLButtonElement>())
  const move = (event: KeyboardEvent<HTMLDivElement>) => {
    const next = target(event.key, tabs.findIndex(tab => tab.id === selected), tabs.length)
    const tab = next === undefined ? undefined : tabs[next]
    if (tab === undefined) return
    event.preventDefault()
    onSelect(tab.id)
    buttons.current.get(tab.id)?.focus()
  }
  return (
    <div role="tablist" aria-label={label} aria-orientation="horizontal" className={`${css.list} ${className ?? ''}`.trim()} onKeyDown={move}>
      {tabs.map(tab => {
        const on = tab.id === selected
        return (
          <button
            key={tab.id}
            ref={(element) => { if (element === null) buttons.current.delete(tab.id); else buttons.current.set(tab.id, element) }}
            id={tabId(idBase, tab.id)}
            type="button"
            role="tab"
            aria-selected={on}
            aria-controls={panelId(idBase)}
            tabIndex={on ? 0 : -1}
            className={css.tab}
            onClick={() => { onSelect(tab.id) }}
          >
            {tab.label}
          </button>
        )
      })}
    </div>
  )
}

/**
 * Render the panel the selected tab names. It is focusable, so a keyboard user can reach content that holds no
 * control of its own.
 * @param props - see {@link TabPanelProps}.
 * @returns the panel.
 */
export function TabPanel<T extends string>({ idBase, selected, className, children }: TabPanelProps<T>) {
  return <div id={panelId(idBase)} role="tabpanel" aria-labelledby={tabId(idBase, selected)} tabIndex={0} className={`${css.panel} ${className ?? ''}`.trim()}>{children}</div>
}
