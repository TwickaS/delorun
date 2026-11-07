import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

/**
 * Vitest for Delo's Docker specs: the `.docker.spec.ts` files under `delo/apps/*` and `delo/packages/*`, which run
 * against the Docker engine of the active context. Run it from the repository root with
 * `node_modules/.bin/vitest run --config delo/vitest.docker.config.ts`. The specs share one engine, so files run
 * one at a time; a spec skips, naming the reason, where no engine answers.
 */
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  test: {
    name: 'docker',
    include: ['apps/*/tests/**/*.docker.spec.ts', 'packages/*/tests/**/*.docker.spec.ts'],
    fileParallelism: false,
  },
})
