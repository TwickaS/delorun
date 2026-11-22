/**
 * The plugin browser: what a Delorun install holds, from the repository at build time, and the files a new plugin
 * starts with. Without scripts it is the full list as a definition list; with scripts it is a list on the left that shows
 * its first rows and a control for the rest, the chosen plugin's detail on the right (beneath the chosen row on a phone),
 * and a second tab for making your own.
 *
 * @module @delorun/website/plugin-browser/PluginBrowser
 */
import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { Button, Card, Link, Pill, TabList, TabPanel } from '@brand'
import { GITHUB_URL, DOCS_URL } from '../site/config.ts'
import type { PluginEntry } from './list-plugins.ts'
import css from './PluginBrowser.module.css'
import { KINDS, KindFiles, PLUGINS, PluginBrowserStill, STANDINGS, type Kind } from './PluginBrowserStill.tsx'
import type { PluginBrowserWords } from './words.ts'

type Tab = 'plugins' | 'make'

const FIRST_PLUGIN_GUIDE = `${DOCS_URL}/guide/plugin-guides/first-plugin`

function Detail({ plugin, words }: { readonly plugin: PluginEntry; readonly words: PluginBrowserWords }) {
  return (
    <Card className={css.card}>
      <h3 className={css.title}>{plugin.title}</h3>
      <p className={css.sentence}>{plugin.sentence}</p>
      {plugin.state === 'experimental' ? <ul className={css.facts}><li><Pill tone="warning">{words.experimental}</Pill></li></ul> : null}
      <p className={css.standing}>{words.standings[plugin.standing]}</p>
      {plugin.standing === 'pack' ? (
        <>
          <h4 className={css.needsHeading}>{words.requiresHeading}</h4>
          {plugin.requires.length === 0 ? <p className={css.nothing}>{words.requiresNothing}</p> : <ul className={css.needs}>{plugin.requires.map((need) => <li key={need}>{need}</li>)}</ul>}
        </>
      ) : null}
      <details className={css.files}>
        <summary>{words.filesSummary}</summary>
        <p>{words.filesCount(plugin.files)}</p>
        <p><Link href={`${GITHUB_URL}/tree/main/${plugin.folder}`}>{words.folderLink}</Link></p>
      </details>
    </Card>
  )
}

function Make({ words }: { readonly words: PluginBrowserWords }) {
  const [kind, setKind] = useState<Kind>('tool')
  return (
    <div className={css.make}>
      <p>{words.makeIntro}</p>
      <ul className={css.kinds}>
        {KINDS.map((each) => <li key={each}><Pill tone={each === kind ? 'accent' : 'neutral'} aria-pressed={each === kind} onClick={() => { setKind(each) }}>{words.kinds[each].name}</Pill></li>)}
      </ul>
      <div aria-live="polite"><KindFiles kind={kind} words={words} /></div>
      <p className={css.note}>{words.makeNote}</p>
      <a className={css.guide} href={FIRST_PLUGIN_GUIDE}>{words.guideLink}</a>
    </div>
  )
}

/** How many rows the list shows before "Show all plugins". */
const FIRST_ROWS = 8

/**
 * The list and the chosen plugin's detail. The list shows its first rows and a control for the rest; it never scrolls
 * inside a box, so no row is cut. On a wide screen the detail stands beside the list from the start; on a phone it
 * opens beneath a row once the row is chosen.
 */
function Plugins({ words }: { readonly words: PluginBrowserWords }) {
  const [selected, setSelected] = useState(PLUGINS[0]?.name)
  // A wide screen (960 px, as the stylesheet's split) shows the chosen plugin's detail from the start; a phone opens it under a row once chosen.
  const [opened, setOpened] = useState(() => typeof matchMedia === 'function' && matchMedia('(min-width: 960px)').matches)
  const [all, setAll] = useState(false)
  const shown = all ? PLUGINS : PLUGINS.slice(0, FIRST_ROWS)
  const focusRow = useRef<string | undefined>(undefined)
  const select = (name: string, focus: boolean): void => {
    setSelected(name)
    setOpened(true)
    if (PLUGINS.findIndex((plugin) => plugin.name === name) >= FIRST_ROWS) setAll(true)
    focusRow.current = focus ? name : undefined
  }
  // The keys move from the focused row, which after "Show all plugins" is not the chosen one.
  const choose = (event: KeyboardEvent<HTMLUListElement>) => {
    const target = event.target
    const focused = target instanceof HTMLElement ? PLUGINS.findIndex((plugin) => `plugin-row-${plugin.name}` === target.id) : -1
    const at = focused === -1 ? PLUGINS.findIndex((plugin) => plugin.name === selected) : focused
    const next = event.key === 'ArrowDown' ? Math.min(at + 1, PLUGINS.length - 1) : event.key === 'ArrowUp' ? Math.max(at - 1, 0) : event.key === 'Home' ? 0 : event.key === 'End' ? PLUGINS.length - 1 : undefined
    const plugin = next === undefined ? undefined : PLUGINS[next]
    if (plugin === undefined) return
    event.preventDefault()
    select(plugin.name, true)
  }
  const showAll = (): void => {
    setAll(true)
    focusRow.current = PLUGINS[FIRST_ROWS]?.name
  }
  // A row chosen by key, or the first row "Show all plugins" revealed, takes the focus once it is drawn.
  useEffect(() => {
    const name = focusRow.current
    if (name === undefined) return
    focusRow.current = undefined
    document.getElementById(`plugin-row-${name}`)?.focus()
  })
  // On a phone the detail opens under the row; the page scrolls just enough to show it whole. Arriving scrolls nothing.
  const arrived = useRef(false)
  useEffect(() => {
    if (!arrived.current) { arrived.current = true; return }
    if (opened) document.querySelector(`.${css.inline}`)?.scrollIntoView?.({ block: 'nearest' })
  }, [selected, opened])
  const current = PLUGINS.find((plugin) => plugin.name === selected) ?? PLUGINS[0]
  return (
    <div className={css.split}>
      <div className={css.side}>
        <ul className={css.list} aria-label={words.listLabel} onKeyDown={choose}>
          {STANDINGS.map((standing) => {
            const group = shown.filter((plugin) => plugin.standing === standing)
            return group.length === 0 ? null : (
              <li key={standing}>
                <h3 className={css.groupName}>{words.groups[standing]}</h3>
                <ul className={css.group}>
                  {group.map((plugin) => {
                    const on = plugin.name === current?.name
                    return (
                      <li key={plugin.name}>
                        <button type="button" id={`plugin-row-${plugin.name}`} className={css.row} aria-current={on && opened} tabIndex={on ? 0 : -1} title={plugin.title}
                          onClick={() => { select(plugin.name, false) }}>
                          <span className={css.rowTitle}>{plugin.title}</span>
                        </button>
                        {on && opened ? <div className={css.inline}><Detail plugin={plugin} words={words} /></div> : null}
                      </li>
                    )
                  })}
                </ul>
              </li>
            )
          })}
        </ul>
        {all ? null : <Button variant="secondary" size="sm" className={css.showAll} onClick={showAll}>{words.showAll(PLUGINS.length)}</Button>}
      </div>
      <div className={`${css.detail} ${css.aside}`} aria-live="polite">{current === undefined ? null : <Detail plugin={current} words={words} />}</div>
    </div>
  )
}

/**
 * Render the plugin browser.
 * @param props - the page's words for this language.
 * @returns the browser; the plain list until the page's scripts run.
 */
export function PluginBrowser({ words }: { readonly words: PluginBrowserWords }) {
  const [ready, setReady] = useState(false)
  const [tab, setTab] = useState<Tab>('plugins')
  useEffect(() => { setReady(true) }, [])
  if (!ready) return <div className={css.root}><span /><PluginBrowserStill words={words} /></div>
  return (
    <div className={css.root} data-plugin-browser="live">
      <TabList label={words.tabsLabel} idBase="plugin-browser" selected={tab} onSelect={setTab} tabs={[{ id: 'plugins', label: words.pluginsTab }, { id: 'make', label: words.makeYourOwnTab }]} />
      <TabPanel idBase="plugin-browser" selected={tab} focusable={false} className={css.panel}>
        {tab === 'plugins' ? <Plugins words={words} /> : <Make words={words} />}
      </TabPanel>
    </div>
  )
}
