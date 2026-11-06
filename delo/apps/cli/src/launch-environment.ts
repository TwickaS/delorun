/**
 * The variables every runtime process `delorun` starts receives (contract C1,
 * "The home directory" and "Launcher and store compatibility"): `DSH_HOME` and
 * `DELO_HOME` set to the resolved home and `DELO_PROFILE` to the CLI profile.
 * They are set on this process's environment before any upstream module runs,
 * so upstream's home resolution, its `.env` layers, which never replace an
 * inherited variable, and every child process see the same home.
 *
 * @module @delo/cli/launch-environment
 */
import { DELO_HOME_ENV, DELO_PROFILE_ENV, DSH_HOME_ENV } from '@delo/contract-home-layout'

/**
 * Set the launch variables, replacing any inherited `DSH_HOME`.
 * @param home - the resolved Delo home.
 * @param profile - the CLI profile.
 * @param env - the environment to change; this process's by default.
 */
export function applyLaunchEnvironment(home: string, profile: string, env: Record<string, string | undefined> = process.env): void {
  env[DSH_HOME_ENV] = home
  env[DELO_HOME_ENV] = home
  env[DELO_PROFILE_ENV] = profile
}
