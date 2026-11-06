/**
 * The documentation website's check: it refuses to run without the site's installed dependencies, and otherwise runs
 * the site's build, which includes its dead-link check (`delo/apps/docs/scripts/check-links.mjs`). The site has its own
 * lockfile, so the install is the site's own command.
 *
 * @module @delo/tools/check-docs-site
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { repositoryRoot } from './git.ts'

const SITE = 'delo/apps/docs'
const INSTALL = '(cd delo/apps && pnpm --dir docs install --frozen-lockfile)'

const root = repositoryRoot(process.cwd())
if (!existsSync(join(root, SITE, 'node_modules', 'next', 'package.json'))) {
  console.error(`docs-site: ${SITE} has no installed dependencies; run ${INSTALL}`)
  process.exit(1)
}
const build = spawnSync('pnpm', ['--dir', SITE, 'run', 'build'], {
  cwd: root,
  stdio: 'inherit',
  env: { ...process.env, NEXT_TELEMETRY_DISABLED: '1' },
})
if (build.error !== undefined) {
  console.error(`docs-site: the build did not start: ${build.error.message}`)
  process.exit(1)
}
process.exit(build.status ?? 1)
