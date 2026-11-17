/**
 * The product website's alias for upstream client source. The studio replica imports upstream's components from source
 * through it (`#studio/ui-approval/src/client/ApprovalCard.tsx` is `packages/client/ui-approval/src/client/ApprovalCard.tsx`),
 * and it is used by the site's Vite config, by the replica's build plugin and by the client component specs in
 * `delorun/vitest.config.ts`. Only code under `src/replica/` may import `#studio/`; `gates:upstream-src-imports` refuses it
 * elsewhere, since that code never runs under Node.
 *
 * @module @delorun/website/studio-aliases
 */
import { fileURLToPath } from 'node:url'

/** The alias entries, in the form Vite and Vitest take. */
export const STUDIO_ALIASES: ReadonlyArray<{ readonly find: RegExp; readonly replacement: string }> = [
  { find: /^#studio\//, replacement: fileURLToPath(new URL('../../../packages/client/', import.meta.url)) },
]
