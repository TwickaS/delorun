import { fileURLToPath } from 'node:url'
import tsconfigPaths from 'vite-tsconfig-paths'
import { defineConfig } from 'vitest/config'

/**
 * Vitest for Delo's own workspaces: the specs under `delo/apps/*` and `delo/packages/*`.
 * Run it from the repository root with `node_modules/.bin/vitest run --config delo/vitest.config.ts`.
 * `.spec.ts` specs import upstream packages through their published entry points. Client component specs
 * (`.spec.tsx`, jsdom by per-file pragma) resolve upstream packages to their sources through `tsconfig.base.json`'s
 * paths, as upstream's own client specs do, because the built client modules load React's CommonJS shims that the
 * jsdom lane cannot import.
 */
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  test: {
    projects: [
      { test: { name: 'fork', include: ['apps/*/tests/**/*.spec.ts', 'packages/*/tests/**/*.spec.ts'] } },
      {
        plugins: [tsconfigPaths({ projects: [fileURLToPath(new URL('../tsconfig.base.json', import.meta.url))] })],
        test: {
          name: 'fork-client',
          include: ['apps/*/tests/**/*.spec.tsx', 'packages/*/tests/**/*.spec.tsx'],
          setupFiles: [fileURLToPath(new URL('../scripts/test-dom-environment.ts', import.meta.url))],
        },
      },
    ],
  },
})
