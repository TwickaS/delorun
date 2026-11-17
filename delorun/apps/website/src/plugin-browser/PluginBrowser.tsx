/**
 * The plugin browser: what a Delorun install holds, from the repository at build time, and the files a new plugin
 * starts with. Without scripts it is the full list as text; with scripts it is a list on the left, the chosen plugin's
 * detail on the right (beneath the chosen row on a phone), and a second tab for making your own.
 *
 * @module @delorun/website/plugin-browser/PluginBrowser
 */
import { useEffect, useState, type KeyboardEvent } from 'react'
import { Card, Link, Pill, TabList, TabPanel } from '@brand'
import { GITHUB_URL, DOCS_URL } from '../site/config.ts'
import data from './plugins.generated.json'
import type { PluginEntry, Standing } from './list-plugins.ts'
import css from './PluginBrowser.module.css'
import type { FileNote, PluginBrowserWords } from './words.ts'

type Tab = 'plugins' | 'make'
type Kind = keyof typeof data.scaffold

/** The plugins in the data file. */
const PLUGINS: readonly PluginEntry[] = data.plugins as PluginEntry[]
const KINDS = Object.keys(data.scaffold) as Kind[]
const STANDINGS: readonly Standing[] = ['on', 'off', 'headless', 'pack']
const FIRST_PLUGIN_GUIDE = `${DOCS_URL}/guide/first-plugin`

/** The note for a file of a new plugin, by the file's name without its folder. */
function noteFor(path: string, words: PluginBrowserWords): string {
  const name = path.slice(path.lastIndexOf('/') + 1)
  return name in words.fileNotes ? words.fileNotes[name as FileNote] : ''
}

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

function KindFiles({ kind, words }: { readonly kind: Kind; readonly words: PluginBrowserWords }) {
  return (
    <>
      <p className={css.kindSummary}>{words.kinds[kind].summary}</p>
      <h4 className={css.fileHeading}>{words.filesWritten(words.kinds[kind].name)}</h4>
      <ul className={css.fileList}>
        {data.scaffold[kind].map((path) => <li key={path}><code>{path}</code><span>{noteFor(path, words)}</span></li>)}
      </ul>
    </>
  )
}

function Make({ words, all }: { readonly words: PluginBrowserWords; readonly all: boolean }) {
  const [kind, setKind] = useState<Kind>('tool')
  return (
    <div className={css.make}>
      <p>{words.makeIntro}</p>
      {all ? KINDS.map((each) => <section key={each}><h3 className={css.fileHeading}>{words.kinds[each].name}</h3><KindFiles kind={each} words={words} /></section>) : (
        <>
          <ul className={css.kinds}>
            {KINDS.map((each) => <li key={each}><Pill tone={each === kind ? 'accent' : 'neutral'} aria-pressed={each === kind} onClick={() => { setKind(each) }}>{words.kinds[each].name}</Pill></li>)}
          </ul>
          <div aria-live="polite"><KindFiles kind={kind} words={words} /></div>
        </>
      )}
      <p className={css.note}>{words.makeNote}</p>
      <a className={css.guide} href={FIRST_PLUGIN_GUIDE}>{words.guideLink}</a>
    </div>
  )
}

/** Every plugin as text: what a visitor with scripts off, and a search engine, reads. */
function Plain({ words }: { readonly words: PluginBrowserWords }) {
  return (
    <div className={css.plain} tabIndex={0} role="region" aria-label={words.listLabel}>
      {STANDINGS.map((standing) => {
        const group = PLUGINS.filter((plugin) => plugin.standing === standing)
        return group.length === 0 ? null : (
          <section key={standing}>
            <h3>{words.groups[standing]}</h3>
            <ul>
              {group.map((plugin) => (
                <li key={plugin.name}>
                  <strong>{plugin.title}</strong>
                  <span>{plugin.sentence}</span>
                  {plugin.requires.length === 0 ? null : <small>{words.requiresHeading}: {plugin.requires.join(', ')}</small>}
                </li>
              ))}
            </ul>
          </section>
        )
      })}
      <Make words={words} all />
    </div>
  )
}

function Plugins({ words }: { readonly words: PluginBrowserWords }) {
  const [selected, setSelected] = useState(PLUGINS[0]?.name)
  const choose = (event: KeyboardEvent<HTMLUListElement>) => {
    const at = PLUGINS.findIndex((plugin) => plugin.name === selected)
    const next = event.key === 'ArrowDown' ? Math.min(at + 1, PLUGINS.length - 1) : event.key === 'ArrowUp' ? Math.max(at - 1, 0) : event.key === 'Home' ? 0 : event.key === 'End' ? PLUGINS.length - 1 : undefined
    const plugin = next === undefined ? undefined : PLUGINS[next]
    if (plugin === undefined) return
    event.preventDefault()
    setSelected(plugin.name)
    document.getElementById(`plugin-row-${plugin.name}`)?.focus()
  }
  // On a phone the detail opens under the row; a list that scrolls inside its box shows it whole.
  useEffect(() => { document.querySelector(`.${css.inline}`)?.scrollIntoView?.({ block: 'nearest' }) }, [selected])
  const current = PLUGINS.find((plugin) => plugin.name === selected) ?? PLUGINS[0]
  return (
    <div className={css.split}>
      <ul className={css.list} aria-label={words.listLabel} onKeyDown={choose}>
        {STANDINGS.map((standing) => {
          const group = PLUGINS.filter((plugin) => plugin.standing === standing)
          return group.length === 0 ? null : (
            <li key={standing}>
              <h3 className={css.groupName}>{words.groups[standing]}</h3>
              <ul className={css.group}>
                {group.map((plugin) => {
                  const on = plugin.name === current?.name
                  return (
                    <li key={plugin.name}>
                      <button type="button" id={`plugin-row-${plugin.name}`} className={css.row} aria-current={on} data-selected={on} tabIndex={on ? 0 : -1} onClick={() => { setSelected(plugin.name) }}>{plugin.title}</button>
                      {on ? <div className={css.inline}><Detail plugin={plugin} words={words} /></div> : null}
                    </li>
                  )
                })}
              </ul>
            </li>
          )
        })}
      </ul>
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
  if (!ready) return <div className={css.root}><span /><Plain words={words} /></div>
  return (
    <div className={css.root}>
      <TabList label={words.tabsLabel} idBase="plugin-browser" selected={tab} onSelect={setTab} tabs={[{ id: 'plugins', label: words.pluginsTab }, { id: 'make', label: words.makeYourOwnTab }]} />
      <TabPanel idBase="plugin-browser" selected={tab} focusable={false} className={css.panel}>
        {tab === 'plugins' ? <Plugins words={words} /> : <Make words={words} all={false} />}
      </TabPanel>
    </div>
  )
}
