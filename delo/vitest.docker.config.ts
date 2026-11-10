import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

/**
 * Vitest for Delo's Docker specs: the `.docker.spec.ts` files under `delo/apps/*` and `delo/packages/*`, which run
 * against the Docker engine of the active context. Run it from the repository root with
 * `node_modules/.bin/vitest run --config delo/vitest.docker.config.ts`. The specs share one engine, so files run
 * one at a time. The check runner sets `DELO_DOCKER_SPECS=1` for the lane and declines it while no engine answers; with
 * that variable set a spec fails, naming what to do, where it would otherwise skip for want of an engine or a fixture image.
 * Run by hand without the variable, a spec skips, naming the reason, where no engine answers.
 *
 * The journey spec (`apps/release/tests/journey/`) is its own merge-only check, `journey`, which sets `DELO_JOURNEY=1`:
 * with that variable this configuration runs the journey alone, and without it the journey is left out of the lane.
 */
const JOURNEY = 'apps/release/tests/journey/**/*.docker.spec.ts'
const journey = process.env['DELO_JOURNEY'] === '1'

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  test: {
    name: 'docker',
    include: journey ? [JOURNEY] : ['apps/*/tests/**/*.docker.spec.ts', 'packages/*/tests/**/*.docker.spec.ts'],
    exclude: journey ? ['**/node_modules/**'] : ['**/node_modules/**', JOURNEY],
    fileParallelism: false,
  },
})
