import { clientBundle } from '../../../packages/client/tsdown.client.ts'

// Upstream's preset for a plugin with a studio face: `lib/index.js` for the harness and `lib/client.js` for the browser.
// The page's module table does not provide Delo's packages, so the browser half imports none of them at run time.
export default clientBundle(import.meta.dirname, ['lib/types/index.js'])
