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
      <dl className={css.fileList}>
        {data.scaffold[kind].map((path) => <div key={path} className={css.fileItem}><dt><code>{path}</code></dt><dd>{noteFor(path, words)}</dd></div>)}
      </dl>
    </>
  )
}

/**
 * Every plugin as a definition list, its title as the term and its sentence and needs as the descriptions, then every
 * kind's files. With scripts off the list takes the room it needs; while scripts run it holds the live browser's first
 * height until the live browser replaces it.
 * @param props - the page's words.
 * @returns the list.
 */
export function PluginBrowserStill({ words }: { readonly words: PluginBrowserWords }) {
  return (
    <div className={css.plain} role="region" aria-label={words.listLabel} data-plugin-browser="still">
      {STANDINGS.map((standing) => {
        const group = PLUGINS.filter((plugin) => plugin.standing === standing)
        return group.length === 0 ? null : (
          <section key={standing} className={css.plainSection}>
            <h3 className={css.plainHeading}>{words.groups[standing]}</h3>
            <dl className={css.plainList}>
              {group.map((plugin) => (
                <div key={plugin.name} className={css.plainItem}>
                  <dt className={css.plainTitle} data-plugin-term="">{plugin.title}</dt>
                  <dd className={css.plainSentence}>{plugin.sentence}</dd>
                  {plugin.requires.length === 0 ? null : <dd className={css.plainNeeds}><span className={css.plainNeedsLabel}>{words.requiresHeading}</span> {plugin.requires.join(', ')}</dd>}
                </div>
              ))}
            </dl>
          </section>
        )
      })}
      <section className={css.plainSection}>
        <h3 className={css.plainHeading}>{words.makeYourOwnTab}</h3>
        <p className={css.plainIntro}>{words.makeIntro}</p>
        {KINDS.map((each) => (
          <details key={each} className={css.plainKind}>
            <summary>{words.kinds[each].name}</summary>
            <KindFiles kind={each} words={words} />
          </details>
        ))}
        <p className={css.note}>{words.makeNote}</p>
      </section>
    </div>
  )
}
