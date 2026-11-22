/** The words for Delorun's own plugin packs, by the signed package name, with the signed name as the fallback. */
import type { DownloadsLocaleKey, Translate } from './locales.ts'

/** The key the browser download Browser needs (Chromium, through its installer) shows under in the panel. */
export const BROWSER_DOWNLOAD_KEY = 'delorun:browser-download'

/** Dictionary keys of the packs the release ships, by package name. */
export const PACK_TITLE_KEYS: Readonly<Record<string, DownloadsLocaleKey>> = {
  '@delorun/bundle-browser': 'pack.browser',
  '@delorun/bundle-real-browser': 'pack.realBrowser',
  '@delorun/bundle-code-intelligence': 'pack.codeIntelligence',
  '@delorun/bundle-agent-hooks': 'pack.agentHooks',
  '@delorun/bundle-webhooks': 'pack.webhooks',
  '@delorun/bundle-external-agents': 'pack.externalAgents',
  '@delorun/bundle-computer-use-driver': 'pack.computerUseDriver',
  '@deepseek-ai/dsh-subagent-claude-code': 'pack.claudeCode',
  '@deepseek-ai/dsh-subagent-codex': 'pack.codex',
  [BROWSER_DOWNLOAD_KEY]: 'pack.chromium',
}

/**
 * The name a row shows: the item's own title, else the pack's words, else the signed package name.
 * @param item - the item's package name and optional title.
 * @param t - the bound translate.
 * @returns the name.
 */
export function nameOf(item: { readonly key: string, readonly title?: string }, t: Translate): string {
  if (item.title !== undefined) return item.title
  const key = Object.hasOwn(PACK_TITLE_KEYS, item.key) ? PACK_TITLE_KEYS[item.key] : undefined
  return key === undefined ? item.key : t(key)
}
