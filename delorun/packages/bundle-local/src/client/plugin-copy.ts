/**
 * Delorun's wording for two lines of upstream's Add plugin dialog that name DeepSeek Harness. The dialog reads them from
 * upstream's `pluginManager` dictionary; this override replaces them in English and Chinese, the languages Delorun
 * writes copy in, and a language upstream translated itself keeps its text.
 */
import type { Context } from '@deepseek-ai/cordis'

import { PLUGIN_COPY, PLUGIN_MANAGER_NS } from './plugin-copy-text.ts'

export { PLUGIN_COPY, PLUGIN_MANAGER_NS }

/**
 * Override the two lines in English and Chinese.
 * @param locale - the locale service.
 * @returns the disposer, which removes both overrides.
 */
export function overridePluginCopy(locale: Context['locale']): () => void {
  const removers = Object.entries(PLUGIN_COPY).map(([id, copy]) => locale.override(PLUGIN_MANAGER_NS, id, copy))
  return () => { for (const remove of removers) remove() }
}
