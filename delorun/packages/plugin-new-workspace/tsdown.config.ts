import type { UserConfig } from 'tsdown'
import { clientBundle } from '../../../packages/client/tsdown.client.ts'

// Upstream's preset for a plugin with a studio face. The harness half runs from `src/index.ts` as the other Delorun
// plugins without a studio face do, so only the browser half, `lib/client.js`, is built. The client imports only upstream
// packages the page provides and this package's own browser-safe modules, so nothing needs inlining.
const configs = clientBundle(import.meta.dirname, [])

export default (inlineConfig: Pick<UserConfig, 'env'>): UserConfig[] => configs(inlineConfig).filter(config => config.platform === 'browser')
