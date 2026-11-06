import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

/**
 * Vitest for Delo's own workspaces: the specs under `delo/apps/*` and `delo/packages/*`.
 * Run it from the repository root with `node_modules/.bin/vitest run --config delo/vitest.config.ts`.
 */
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  test: {
    include: ['apps/*/tests/**/*.spec.ts', 'packages/*/tests/**/*.spec.ts'],
  },
})
