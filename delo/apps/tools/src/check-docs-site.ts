/**
 * A static website's check: it refuses to run without the site's installed dependencies, and otherwise runs the
 * site's build, which prerenders every page, typechecks the site and runs its dead-link check
 * (`delo/apps/docs/scripts/check-links.mjs`). The site has its own lockfile, so the install is the site's own command.
 * Without an argument it checks the documentation site; `website` checks the product site.
 *
 * @module @delo/tools/check-docs-site
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { repositoryRoot } from './git.ts'

const NAME = process.argv[2] ?? 'docs'
const SITE = `delo/apps/${NAME}`
const INSTALL = `(cd delo/apps && pnpm --dir ${NAME} install --frozen-lockfile)`

const root = repositoryRoot(process.cwd())
// The site's build tool; its manifest is present once the site's own install has run.
if (!existsSync(join(root, SITE, 'node_modules', 'vite', 'package.json'))) {
  console.error(`${NAME}-site: ${SITE} has no installed dependencies; run ${INSTALL}`)
  process.exit(1)
}
const build = spawnSync('pnpm', ['--dir', SITE, 'run', 'build'], { cwd: root, stdio: 'inherit' })
if (build.error !== undefined) {
  console.error(`${NAME}-site: the build did not start: ${build.error.message}`)
  process.exit(1)
}
process.exit(build.status ?? 1)
