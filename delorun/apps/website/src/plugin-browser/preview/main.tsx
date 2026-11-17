/**
 * A page that holds only the plugin browser, for review pictures and the size check. `vite --config
 * src/plugin-browser/preview/vite.config.ts` serves it; the page itself places the browser in the product site.
 *
 * @module @delorun/website/plugin-browser/preview
 */
import { createRoot, hydrateRoot } from 'react-dom/client'
import '../../../../../packages/brand/src/tokens.css'
import '../../../../../packages/brand/src/fonts.css'
import { PluginBrowser } from '../PluginBrowser.tsx'
import { ENGLISH_WORDS } from '../words.ts'

const element = document.getElementById('root')!
const page = <div style={{ boxSizing: 'border-box', maxWidth: 1440, margin: '0 auto', padding: 'clamp(16px, 4vw, 48px)', background: 'var(--dl-surface)', minHeight: '100vh' }}><PluginBrowser words={ENGLISH_WORDS} /></div>
if (element.hasChildNodes()) hydrateRoot(element, page)
else createRoot(element).render(page)
