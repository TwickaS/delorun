import { fileURLToPath } from 'node:url'
import type { UserConfig } from 'tsdown'
import { clientBundle } from '../../../packages/client/tsdown.client.ts'

// Upstream's preset for a plugin with a studio face: `lib/index.js` for the harness and `lib/client.js` for the browser.
const configs = clientBundle(import.meta.dirname, ['lib/types/index.js'])

// The page's module table does not provide Delorun's packages, so the browser half inlines the ones it reads from their source.
const INLINED = {
  '@delorun/contract-release-manifest': fileURLToPath(new URL('../contract-release-manifest/src/index.ts', import.meta.url)),
  '@delorun/contract-update-report': fileURLToPath(new URL('../contract-update-report/src/index.ts', import.meta.url)),
  '@delorun/settings-controls': fileURLToPath(new URL('../settings-controls/src/index.ts', import.meta.url)),
}

export default (inlineConfig: Pick<UserConfig, 'env'>): UserConfig[] => configs(inlineConfig).map(config =>
  config.platform === 'browser' ? { ...config, alias: { ...config.alias, ...INLINED } } : config)
