/**
 * The plugin browser as the page's HTML holds it before any script runs, for the scripts-off picture.
 *
 * @module @delorun/website/plugin-browser/preview/ssr-entry
 */
import { renderToString } from 'react-dom/server'
import { PluginBrowser } from '../PluginBrowser.tsx'
import { ENGLISH_WORDS } from '../words.ts'

/** @returns the browser's server-rendered markup. */
export function render(): string {
  return renderToString(<PluginBrowser words={ENGLISH_WORDS} />)
}
