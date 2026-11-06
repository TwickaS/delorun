import { fileURLToPath } from 'node:url'
import type { UserConfig } from 'tsdown'
import { clientBundle } from '../../../packages/client/tsdown.client.ts'

// Upstream's preset for a plugin with a studio face: `lib/index.js` for the harness and `lib/client.js` for the browser.
const configs = clientBundle(import.meta.dirname, ['lib/types/index.js'])

// The page's module table does not provide Delo's contract packages, so the browser half inlines the one it reads from its source.
const INLINED = {
  '@delo/contract-setup-answers': fileURLToPath(new URL('../contract-setup-answers/src/index.ts', import.meta.url)),
}

export default (inlineConfig: Pick<UserConfig, 'env'>): UserConfig[] => configs(inlineConfig).map(config =>
  config.platform === 'browser' ? { ...config, alias: { ...config.alias, ...INLINED } } : config)
