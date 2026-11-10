/**
 * The studio's document title. Upstream's frame titles the page with the build's `DSH_CLIENT_TITLE`, or, in a build
 * that sets none, such as a source checkout's, with the common dictionary's {@link TITLE_KEY} text ("DSH Local Build").
 * This override replaces that text with the product name, so such a build titles the page "Delo" as well. A build with
 * `DSH_CLIENT_TITLE` set never reads the text.
 */
import type { Context } from '@deepseek-ai/cordis'
import { PRODUCT_NAME } from './brand.tsx'

/**
 * Upstream's common dictionary namespace (`COMMON_NS` of `@deepseek-ai/dsh-client-locale/client`), restated because a
 * client bundle may not import another plugin's values; a spec compares the two.
 */
export const TITLE_NS = 'common'

/** The common dictionary's key upstream's frame titles the page with when the build names no title. */
export const TITLE_KEY = 'brand.localBuild'

/**
 * Override {@link TITLE_KEY} with the product name in every language the locale service lists, including a language
 * added later. The product name is brand text, the same in every language.
 * @param locale - the locale service.
 * @returns the disposer, which removes every override this call made.
 */
export function overrideTitle(locale: Context['locale']): () => void {
  const covered = new Set<string>()
  const removers: Array<() => void> = []
  const cover = (): void => {
    for (const { id } of locale.getLocale().locales) {
      if (covered.has(id)) continue
      // Marked first: an override republishes the locale snapshot, which calls this listener again.
      covered.add(id)
      removers.push(locale.override(TITLE_NS, id, { [TITLE_KEY]: PRODUCT_NAME }))
    }
  }
  cover()
  const stop = locale.subscribe(cover)
  return () => {
    stop()
    for (const remove of removers) remove()
  }
}
