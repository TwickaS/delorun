import type { UserConfig } from 'tsdown'
import { clientBundle } from '../../../packages/client/tsdown.client.ts'

// Upstream's preset for a plugin with a studio face: `lib/index.js` for the harness and `lib/client.js` for the browser.
// `lib/executor/index.js` is the executor row module that the seat presets name (`SEAT_EXECUTOR_MODULE`).
export default clientBundle(import.meta.dirname, ['lib/types/index.js', 'lib/types/executor/index.js']) satisfies (inlineConfig: Pick<UserConfig, 'env'>) => UserConfig[]
