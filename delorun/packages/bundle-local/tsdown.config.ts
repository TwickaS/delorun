import { fileURLToPath } from 'node:url'
import type { UserConfig } from 'tsdown'
import { clientBundle } from '../../../packages/client/tsdown.client.ts'

// Upstream's preset for a plugin with a studio face: `lib/index.js` for the harness and `lib/client.js` for the browser.
const configs = clientBundle(import.meta.dirname, ['lib/types/index.js'])

// The page's module table does not provide Delorun's own packages, so the browser half inlines the import-free modules it
// reads from their source: the shared settings controls, the setup contract and the consent plugins' route messages.
const INLINED = {
  '@delorun/brand/mark': fileURLToPath(new URL('../brand/src/mark.tsx', import.meta.url)),
  '@delorun/brand': fileURLToPath(new URL('../brand/src/index.ts', import.meta.url)),
  '@delorun/settings-controls': fileURLToPath(new URL('../settings-controls/src/index.ts', import.meta.url)),
  '@delorun/contract-setup-answers': fileURLToPath(new URL('../contract-setup-answers/src/index.ts', import.meta.url)),
  '@delorun/plugin-mcp-consent/wire': fileURLToPath(new URL('../plugin-mcp-consent/src/wire.ts', import.meta.url)),
  '@delorun/plugin-permission-defaults/wire': fileURLToPath(new URL('../plugin-permission-defaults/src/wire.ts', import.meta.url)),
}

export default (inlineConfig: Pick<UserConfig, 'env'>): UserConfig[] => configs(inlineConfig).map(config =>
  config.platform === 'browser' ? { ...config, alias: { ...config.alias, ...INLINED } } : config)
