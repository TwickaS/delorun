import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import tsconfigPaths from 'vite-tsconfig-paths'
import { defineConfig } from 'vitest/config'
import { standardDecoratorPlugin } from '../vitest.shared.ts'
import { replicaPlugins } from './apps/website/src/replica/build/plugins.ts'
import { replicaOptions } from './apps/website/replica-options.ts'
import { STUDIO_ALIASES } from './apps/website/studio-aliases.ts'

/**
 * Vitest for Delorun's own workspaces: the specs under `delorun/apps/*` and `delorun/packages/*`, in three projects.
 *
 * - `fork`: the unit specs, `*.spec.ts`. A unit spec starts no process, so a test that runs past {@link UNIT_TIMEOUT_MS}
 *   is hung, not slow, and fails while the run is still short.
 * - `fork-integration`: `*.integration.spec.ts`, the specs that run git, Node or `tsx` children, compose real
 *   profiles, build real release trees, or make many durable writes to real file trees (installs, the trash, update
 *   copies, release records), whose fsync latency follows the disk's load. Their tests take the
 *   {@link INTEGRATION_TIMEOUT_MS} budget and their hooks {@link INTEGRATION_HOOK_TIMEOUT_MS}, which a contended machine needs for process start-up. The check runner runs
 *   this project in its own phase with a bounded worker count (`--maxWorkers`), so the children of many workers do not
 *   compete for the CPUs at once.
 * - `fork-client-website`: the product website's component specs, with the replica's build plugins and the website's React.
 * - `fork-client`: the client component specs, `*.spec.tsx`, at {@link CLIENT_TIMEOUT_MS}. They resolve upstream packages to
 *   their sources through `tsconfig.base.json`'s paths, as upstream's own client specs do, because the built client
 *   modules load React's CommonJS shims that the jsdom lane cannot import.
 *
 * The `.spec.ts` specs import upstream packages through their published entry points, so they need upstream's built
 * `lib/`. Docker specs (`.docker.spec.ts`) need a Docker engine and run in their own lane
 * (`delorun/vitest.docker.config.ts`). The `gates:spec-lanes` gate refuses a unit spec that starts a process.
 *
 * Run it from the repository root with `node_modules/.bin/vitest run --config delorun/vitest.config.ts`, and one project
 * with `--project <name>`.
 */

/**
 * The unit project's test budget. Twice Vitest's default of 5 s, which unit tests that read and write a few temporary
 * files exceeded on a busy machine; a hung test still fails ten seconds in instead of a minute in.
 */
const UNIT_TIMEOUT_MS = 10_000
/** The unit project's hook budget: twice the test budget, since setup and teardown pay the same contention. */
const UNIT_HOOK_TIMEOUT_MS = 20_000
/**
 * The client component project's test budget. Rendering in jsdom and querying by role is CPU work: a test that took
 * under a second alone took over 10 s with every CPU busy. Testing Library's waits stop at 5 s
 * (`vitest.dom-setup.ts`), so a missing element still fails on its own message long before this.
 */
const CLIENT_TIMEOUT_MS = 30_000
/** The integration project's test budget: a test that starts several `tsx` children under full CPU contention. */
const INTEGRATION_TIMEOUT_MS = 60_000
/** The integration project's hook budget: a hook that builds a fixture repository or tree before its tests. */
const INTEGRATION_HOOK_TIMEOUT_MS = 120_000

const SPEC_DIRS = ['apps/*/tests/**', 'packages/*/tests/**']

/** The website's own dependencies; the website is outside the pnpm workspace, so a checkout that never installed it has none. */
const WEBSITE_MODULES = fileURLToPath(new URL('./apps/website/node_modules', import.meta.url))

/** The unit project: `*.spec.ts` specs that start no process; `@design` is the sites' shared design package, and `@brand` is the brand package, as in the docs and website tsconfigs. */
export const forkUnitProject = {
  // A Host remote's source has decorators, which the plugin rewrites before Vite parses the file.
  plugins: [standardDecoratorPlugin()],
  resolve: {
    alias: [
      { find: '@design', replacement: fileURLToPath(new URL('./packages/site-design/src', import.meta.url)) },
      { find: '#upstream', replacement: fileURLToPath(new URL('./packages/brand/src/upstream.web.tsx', import.meta.url)) },
      { find: /^@brand\//, replacement: fileURLToPath(new URL('./packages/brand/src/', import.meta.url)) },
      { find: '@brand', replacement: fileURLToPath(new URL('./packages/brand/src/index.ts', import.meta.url)) },
      // The brand package resolves its own React; the website's spec renders it, so both use the website's copy. Without
      // an installed website, each package resolves its own React.
      ...existsSync(WEBSITE_MODULES) ? [{ find: /^(react|react-dom)(\/.*)?$/, replacement: `${WEBSITE_MODULES}/$1$2` }] : [],
    ],
  },
  test: {
    name: 'fork',
    include: SPEC_DIRS.map(dir => `${dir}/*.spec.ts`),
    exclude: ['**/node_modules/**', '**/*.docker.spec.ts', '**/*.integration.spec.ts'],
    testTimeout: UNIT_TIMEOUT_MS,
    hookTimeout: UNIT_HOOK_TIMEOUT_MS,
  },
}

/** The client component project: `*.spec.tsx` specs in jsdom, upstream packages resolved to their sources. */
export const forkClientProject = {
  resolve: { alias: [...STUDIO_ALIASES] },
  plugins: [tsconfigPaths({ projects: [fileURLToPath(new URL('../tsconfig.base.json', import.meta.url))] })],
  test: {
    name: 'fork-client',
    include: SPEC_DIRS.map(dir => `${dir}/*.spec.tsx`),
    exclude: ['**/node_modules/**', 'apps/website/tests/*.spec.tsx'],
    setupFiles: [fileURLToPath(new URL('../scripts/test-dom-environment.ts', import.meta.url)), fileURLToPath(new URL('./vitest.dom-setup.ts', import.meta.url))],
    testTimeout: CLIENT_TIMEOUT_MS,
    hookTimeout: CLIENT_TIMEOUT_MS,
  },
}

/**
 * The product website's component specs, `apps/website/tests/*.spec.tsx`: the studio replica renders upstream's and
 * Delorun's real components, so this project has the replica's build plugins. It resolves `react` and `react-dom` to the website's copy, the aliases the
 * unit project has, and `#upstream`, `@design` and `@brand` as the site does.
 */
export const forkClientWebsiteProject = {
  plugins: [replicaPlugins(replicaOptions(fileURLToPath(new URL('..', import.meta.url)))), tsconfigPaths({ projects: [fileURLToPath(new URL('../tsconfig.base.json', import.meta.url))] })],
  resolve: {
    alias: [
      ...STUDIO_ALIASES,
      { find: '#upstream', replacement: fileURLToPath(new URL('./packages/brand/src/upstream.web.tsx', import.meta.url)) },
      { find: '@design', replacement: fileURLToPath(new URL('./packages/site-design/src', import.meta.url)) },
      { find: /^@brand\//, replacement: fileURLToPath(new URL('./packages/brand/src/', import.meta.url)) },
      { find: '@brand', replacement: fileURLToPath(new URL('./packages/brand/src/index.ts', import.meta.url)) },
      // The site's own React 19 for every import, as in the unit project: the replica's JSX and the components it renders share it.
      ...existsSync(WEBSITE_MODULES) ? [{ find: /^(react|react-dom)(\/.*)?$/, replacement: `${WEBSITE_MODULES}/$1$2` }] : [],
    ],
  },
  test: {
    name: 'fork-client-website',
    include: ['apps/website/tests/*.spec.tsx'],
    setupFiles: forkClientProject.test.setupFiles,
    testTimeout: CLIENT_TIMEOUT_MS,
    hookTimeout: CLIENT_TIMEOUT_MS,
  },
}

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  test: {
    projects: [
      forkUnitProject,
      {
        plugins: [standardDecoratorPlugin()],
        test: {
          name: 'fork-integration',
          include: SPEC_DIRS.map(dir => `${dir}/*.integration.spec.ts`),
          exclude: ['**/node_modules/**'],
          testTimeout: INTEGRATION_TIMEOUT_MS,
          hookTimeout: INTEGRATION_HOOK_TIMEOUT_MS,
        },
      },
      forkClientProject,
      forkClientWebsiteProject,
    ],
  },
})
