/**
 * Builds the web studio's client with Delorun's product name. `DSH_CLIENT_TITLE` names the page title, the iOS
 * home-screen title and the web manifest's name, and the studio's document title also comes from it inside
 * `@deepseek-ai/dsh-client-ui-layout`'s client bundle. This script runs upstream's `build:web`, then rebuilds that
 * bundle, with the variable set to `Delorun` unless the caller set it. The release closure (WP3.1) must set the same
 * variable and rebuild the same bundle.
 *
 * Run: `node_modules/.bin/tsx delorun/apps/tools/src/build-web.ts`.
 *
 * @module @delorun/tools/build-web
 */
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

/** The product name every Delorun client build presents. */
export const DELORUN_CLIENT_TITLE = 'Delorun'

/**
 * The environment for upstream's client build: the caller's environment, with the Delorun title when none is set.
 * @param environment - the environment to extend; this process's by default.
 * @returns a copy with `DSH_CLIENT_TITLE` set.
 */
export function delorunBuildEnvironment(environment: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return { ...environment, DSH_CLIENT_TITLE: environment['DSH_CLIENT_TITLE'] ?? DELORUN_CLIENT_TITLE }
}

const root = fileURLToPath(new URL('../../../../', import.meta.url))
const environment = delorunBuildEnvironment()
const steps: readonly { cwd: string, command: string, args: readonly string[] }[] = [
  { cwd: root, command: 'pnpm', args: ['run', 'build:web'] },
  { cwd: `${root}packages/client/ui-layout`, command: `${root}node_modules/.bin/tsdown`, args: ['--config-loader', 'native', '--env.DSH_BUILD_FACE', 'client'] },
]
for (const step of steps) {
  const result = spawnSync(step.command, [...step.args], { cwd: step.cwd, env: environment, stdio: 'inherit', shell: process.platform === 'win32' })
  if (result.status !== 0) {
    process.exitCode = result.status ?? 1
    break
  }
}
