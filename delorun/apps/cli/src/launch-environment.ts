/**
 * The variables every runtime process `delorun` starts receives (contract C1,
 * "The home directory" and "Launcher and store compatibility"): `DSH_HOME` and
 * `DELORUN_HOME` set to the resolved home and `DELORUN_PROFILE` to the CLI profile.
 * They are set on this process's environment before any upstream module runs,
 * so upstream's home resolution, its `.env` layers, which never replace an
 * inherited variable, and every child process see the same home.
 *
 * @module @delorun/cli/launch-environment
 */
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parseEnv } from 'node:util'
import { loadLayeredEnv } from '@deepseek-ai/dsh-app-boot'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import type { LaunchEnvironmentSnapshot } from '@deepseek-ai/dsh-launch-environment'
import { DELORUN_HOME_ENV, DELORUN_PROFILE_ENV, DSH_HOME_ENV } from '@delorun/contract-home-layout'
import { CliError, EXIT } from './exit.ts'

/** The prefix of the names only the environment `delorun` was started with may set, never a `.env` file. */
export const DELORUN_ENV_PREFIX = 'DELORUN_'

/**
 * Set the launch variables, replacing any inherited `DSH_HOME`.
 * @param home - the resolved Delorun home.
 * @param profile - the CLI profile.
 * @param env - the environment to change; this process's by default.
 */
export function applyLaunchEnvironment(home: string, profile: string, env: Record<string, string | undefined> = process.env): void {
  env[DSH_HOME_ENV] = home
  env[DELORUN_HOME_ENV] = home
  env[DELORUN_PROFILE_ENV] = profile
}

/**
 * Load upstream's `.env` layers, the working directory's and the harness home's, as a Host's launch environment, after
 * refusing a layer that sets a `DELORUN_` name. Upstream applies a layer's names that the process did not inherit, so
 * without the refusal a `.env` in the working directory could supply `DELORUN_LAUNCHER_ROOTS` to a process its launcher
 * did not start, and every child, an update's successor included, would inherit it.
 * @param cwd - the working directory; this process's by default.
 * @param warn - where upstream's loader reports a layer it could not read; standard error by default.
 * @returns upstream's launch environment snapshot.
 * @throws {CliError} naming the file and the names when a layer sets a `DELORUN_` name; nothing is applied then.
 * @throws {Error} upstream's refusal of a layer.
 */
export function loadDelorunEnvironment(cwd: string = process.cwd(), warn: (line: string) => void = line => void process.stderr.write(line)): LaunchEnvironmentSnapshot {
  for (const directory of new Set([resolve(cwd), resolve(resolveDshHome())])) refuseDelorunNames(join(directory, '.env'))
  return loadLayeredEnv('delorun', cwd, warn)
}

/**
 * Refuse a `.env` file that sets a `DELORUN_` name.
 * @param path - the file.
 * @throws {CliError} naming the file and the names.
 */
function refuseDelorunNames(path: string): void {
  let content: string
  try {
    content = readFileSync(path, 'utf8')
  } catch (_unreadable) {
    // A missing file sets nothing; upstream's loader reports any other read failure when it reads the same file.
    return
  }
  const names = Object.keys(parseEnv(content)).filter(name => name.toUpperCase().startsWith(DELORUN_ENV_PREFIX))
  if (names.length === 0) return
  throw new CliError(EXIT.failed, `delorun: ${path} sets ${names.join(', ')}, which only the environment delorun was started with may set, because each decides which home, profile, release roots or runtime this process trusts; remove ${names.length === 1 ? 'it' : 'them'} from the file, and export ${names.length === 1 ? 'it' : 'them'} in the environment instead if you need ${names.length === 1 ? 'it' : 'them'}`)
}
