import { fileURLToPath } from 'node:url'
import type { UserConfig } from 'tsdown'
import { clientBundle } from '../../../packages/client/tsdown.client.ts'

// Upstream's preset for a plugin with a studio face. The harness half runs from `src/index.ts` as the other Delorun
// plugins without a studio face do, so only the browser half, `lib/client.js`, is built.
const configs = clientBundle(import.meta.dirname, [])

// The page's module table does not provide Delorun's packages, so the browser half inlines the ones it reads from their source.
const INLINED = {
  '@delorun/brand': fileURLToPath(new URL('../brand/src/index.ts', import.meta.url)),
}

export default (inlineConfig: Pick<UserConfig, 'env'>): UserConfig[] => configs(inlineConfig).filter(config => config.platform === 'browser')
  .map(config => ({ ...config, alias: { ...config.alias, ...INLINED } }))
