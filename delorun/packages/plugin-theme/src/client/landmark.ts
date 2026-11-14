/**
 * The page's `main` landmark. Upstream's frame renders the main pane as a plain `div` (`data-slot="main"`), so a screen
 * reader's landmark list has no main region to jump to. While the Delorun look is on, this marks that pane `role="main"`,
 * again whenever the frame renders the pane anew, and takes the role off when the Delorun look goes.
 * @module @delorun/plugin-theme/client/landmark
 */

/** The attribute selector of the main pane that upstream's frame renders. */
export const MAIN_PANE = '[data-slot="main"]'

/**
 * Mark the main pane as the page's `main` landmark. A pane that already carries a role is left as it is.
 * @param doc - the page.
 * @returns the disposer, which stops watching and removes the role this call set.
 */
export function markMainLandmark(doc: Document): () => void {
  let marked: Element | undefined
  const apply = (): void => {
    if (marked?.isConnected === true) return
    const pane = doc.querySelector(MAIN_PANE)
    if (pane === null || pane.hasAttribute('role')) return
    pane.setAttribute('role', 'main')
    marked = pane
  }
  const observer = new MutationObserver(apply)
  observer.observe(doc.body, { childList: true, subtree: true })
  apply()
  return () => {
    observer.disconnect()
    marked?.removeAttribute('role')
  }
}
