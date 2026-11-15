/**
 * The document title and favicon under the person's own branding.
 * @module @delorun/plugin-theme/client/branding-dom
 */
import { DEFAULT_BRAND_NAME, STUDIO_ICON_PATH } from '@delorun/brand/branding'
import { currentBranding, subscribeBranding } from './branding-store.ts'

const FAVICON_ATTRIBUTE = 'data-delorun-branding'

/**
 * Apply the branding to the title and favicon now and after each change.
 * @param doc - the studio's document.
 * @returns the disposer, which puts the title's name and the favicons back.
 */
export function followBrandingInDocument(doc: Document): () => void {
  let applied = DEFAULT_BRAND_NAME
  const applyTitle = (): void => {
    const { name } = currentBranding()
    let title = doc.title
    if (applied !== DEFAULT_BRAND_NAME && applied !== name) title = title.split(applied).join(DEFAULT_BRAND_NAME)
    if (name !== DEFAULT_BRAND_NAME) title = title.split(DEFAULT_BRAND_NAME).join(name)
    applied = name
    if (title !== doc.title) doc.title = title
  }
  const applyIcon = (): void => {
    for (const link of doc.head.querySelectorAll(`link[${FAVICON_ATTRIBUTE}]`)) link.remove()
    const branding = currentBranding()
    if (branding.icon !== 'upload' || !branding.showMark) return
    const link = doc.createElement('link')
    link.rel = 'icon'
    link.href = `${STUDIO_ICON_PATH}?v=${String(branding.revision)}`
    link.setAttribute(FAVICON_ATTRIBUTE, '')
    doc.head.append(link)
  }
  const apply = (): void => { applyTitle(); applyIcon() }
  const observer = new MutationObserver(applyTitle)
  const titleElement = doc.querySelector('title')
  if (titleElement) observer.observe(titleElement, { childList: true, characterData: true, subtree: true })
  const stop = subscribeBranding(apply)
  apply()
  return () => {
    stop()
    observer.disconnect()
    for (const link of doc.head.querySelectorAll(`link[${FAVICON_ATTRIBUTE}]`)) link.remove()
    if (applied !== DEFAULT_BRAND_NAME) doc.title = doc.title.split(applied).join(DEFAULT_BRAND_NAME)
  }
}
