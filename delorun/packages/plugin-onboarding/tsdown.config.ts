import { fileURLToPath } from 'node:url'
import type { UserConfig } from 'tsdown'
import { clientBundle } from '../../../packages/client/tsdown.client.ts'

// Upstream's preset for a plugin with a studio face: `lib/index.js` for the harness and `lib/client.js` for the browser.
const configs = clientBundle(import.meta.dirname, ['lib/types/index.js'])

// The page's module table does not provide the brand components, so the browser half inlines them from the package's source.
const INLINED = {
  '@delorun/brand': fileURLToPath(new URL('../brand/src/index.ts', import.meta.url)),
  '@delorun/plugin-downloads/row': fileURLToPath(new URL('../plugin-downloads/src/client/row.ts', import.meta.url)),
}

export default (inlineConfig: Pick<UserConfig, 'env'>): UserConfig[] => configs(inlineConfig).map(config =>
  config.platform === 'browser' ? { ...config, alias: { ...config.alias, ...INLINED } } : config)
