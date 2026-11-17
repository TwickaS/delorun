/**
 * The plugin browser as text, with no state: what a visitor with scripts off, a search engine and the page before the
 * live browser loads read. It imports only the data and the words, so the page can include it in its first script.
 *
 * @module @delorun/website/plugin-browser/PluginBrowserStill
 */
import data from './plugins.generated.json'
import type { PluginEntry, Standing } from './list-plugins.ts'
import css from './PluginBrowser.module.css'
import type { FileNote, PluginBrowserWords } from './words.ts'

/** The kinds of plugin `plugin new` writes. */
export type Kind = keyof typeof data.scaffold

/** The plugins in the data file. */
export const PLUGINS: readonly PluginEntry[] = data.plugins as PluginEntry[]
/** The kinds in the order the data lists them. */
export const KINDS = Object.keys(data.scaffold) as Kind[]
/** The groups in the order the browser shows them. */
export const STANDINGS: readonly Standing[] = ['on', 'off', 'headless', 'pack']

/** The note for a file of a new plugin, by the file's name without its folder. */
function noteFor(path: string, words: PluginBrowserWords): string {
  const name = path.slice(path.lastIndexOf('/') + 1)
  return name in words.fileNotes ? words.fileNotes[name as FileNote] : ''
}

/**
 * The files one kind of plugin starts with.
 * @param props - the kind and the page's words.
 * @returns the summary and the file list.
 */
export function KindFiles({ kind, words }: { readonly kind: Kind; readonly words: PluginBrowserWords }) {
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

/**
 * Every plugin and every kind's files as text.
 * @param props - the page's words.
 * @returns the scrolling region.
 */
export function PluginBrowserStill({ words }: { readonly words: PluginBrowserWords }) {
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
      <p>{words.makeIntro}</p>
      {KINDS.map((each) => <section key={each}><h3 className={css.fileHeading}>{words.kinds[each].name}</h3><KindFiles kind={each} words={words} /></section>)}
      <p className={css.note}>{words.makeNote}</p>
    </div>
  )
}
