import { fileURLToPath } from 'node:url'
import type { UserConfig } from 'tsdown'
import { clientBundle } from '../../../packages/client/tsdown.client.ts'

// Upstream's preset for a plugin with a studio face: `lib/index.js` for the harness and `lib/client.js` for the browser.
const configs = clientBundle(import.meta.dirname, ['lib/types/index.js'])

// The page's module table provides no Delorun package, so the browser half inlines the brand components, the downloads row and
// the new-workspace wire types from their packages' source.
const INLINED = {
  '@delorun/brand': fileURLToPath(new URL('../brand/src/index.ts', import.meta.url)),
  '@delorun/plugin-downloads/row': fileURLToPath(new URL('../plugin-downloads/src/client/row.ts', import.meta.url)),
  '@delorun/plugin-new-workspace/wire': fileURLToPath(new URL('../plugin-new-workspace/src/wire.ts', import.meta.url)),
}

export default (inlineConfig: Pick<UserConfig, 'env'>): UserConfig[] => configs(inlineConfig).map(config =>
  config.platform === 'browser' ? { ...config, alias: { ...config.alias, ...INLINED } } : config)
