/**
 * The wording the on-demand rows state, as a custom property the theme layer's rules read. The rules are static CSS, so
 * the words arrive as `--delorun-on-demand-label` on the document's root, quoted for `content`, and follow the studio's
 * language: a change of language sets them again, and the stock look removes them with the rest of the sheet.
 * @module @delorun/plugin-theme/client/on-demand-label
 */

/** The custom property the rules read. */
export const ON_DEMAND_LABEL = '--delorun-on-demand-label'

/**
 * Set the wording, and keep it current as the studio's language changes.
 * @param doc - the studio's document.
 * @param label - the wording in the studio's current language.
 * @param subscribe - calls the listener when the language changes; returns the unsubscribe.
 * @returns the disposer, which removes the property.
 */
export function followOnDemandLabel(doc: Document, label: () => string, subscribe: (listener: () => void) => () => void): () => void {
  const root = doc.documentElement
  const apply = (): void => { root.style.setProperty(ON_DEMAND_LABEL, JSON.stringify(label())) }
  apply()
  const stop = subscribe(apply)
  return () => {
    stop()
    root.style.removeProperty(ON_DEMAND_LABEL)
  }
}
