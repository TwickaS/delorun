import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

/**
 * Vitest for Delo's Docker specs: the `.docker.spec.ts` files under `delo/apps/*` and `delo/packages/*`, which run
 * against the Docker engine of the active context. Run it from the repository root with
 * `node_modules/.bin/vitest run --config delo/vitest.docker.config.ts`. The specs share one engine, so files run
 * one at a time. The check runner sets `DELO_DOCKER_SPECS=1` for the lane and declines it while no engine answers; with
 * that variable set a spec fails, naming what to do, where it would otherwise skip for want of an engine or a fixture image.
 * Run by hand without the variable, a spec skips, naming the reason, where no engine answers.
 */
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  test: {
    name: 'docker',
    include: ['apps/*/tests/**/*.docker.spec.ts', 'packages/*/tests/**/*.docker.spec.ts'],
    fileParallelism: false,
  },
})
