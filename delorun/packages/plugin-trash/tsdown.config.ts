import { fileURLToPath } from 'node:url'
import type { UserConfig } from 'tsdown'
import { clientBundle } from '../../../packages/client/tsdown.client.ts'

// Upstream's preset for a plugin with a studio face: `lib/index.js` for the harness and `lib/client.js` for the browser.
const configs = clientBundle(import.meta.dirname, ['lib/types/index.js'])

// The page's module table does not provide Delorun's packages, so the browser half inlines the browser-safe modules it reads from their source.
const INLINED = {
  '@delorun/trash/drafts': fileURLToPath(new URL('../trash/src/drafts.ts', import.meta.url)),
  '@delorun/contract-host-qualified-keys': fileURLToPath(new URL('../contract-host-qualified-keys/src/index.ts', import.meta.url)),
}

export default (inlineConfig: Pick<UserConfig, 'env'>): UserConfig[] => configs(inlineConfig).map(config =>
  config.platform === 'browser' ? { ...config, alias: { ...config.alias, ...INLINED } } : config)
