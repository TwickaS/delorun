/**
 * The options the product website's build and its component specs pass to the replica's build plugins. A production
 * build carries only real recordings made on the marketed release; stand-in sessions are accepted only when the
 * environment says so, with `SITE_ALLOW_STANDINS=1`. The variable is never set in a committed configuration or by a
 * deploy: local builds, the check runner's `website-site` check (`delorun/apps/tools/src/check-docs-site.ts`, the one
 * place that sets it) and the review builds do.
 *
 * @module @delorun/website/replica-options
 */
import { STUDIO_ALIASES } from './studio-aliases.ts'

/** The release the site markets, which a recorded session must have been made on. */
export const MARKETED_RELEASE = '0.1.0'

/** The environment variable that lets a build carry stand-in sessions. */
export const ALLOW_STANDINS_VARIABLE = 'SITE_ALLOW_STANDINS'

/**
 * The replica plugins' options for an environment.
 * @param env - the process environment.
 * @returns the aliases and the session policy; `preview` is true only when the variable is exactly `1`.
 */
export function replicaOptions(env: Readonly<Record<string, string | undefined>>) {
  return { aliases: STUDIO_ALIASES, sessions: { release: MARKETED_RELEASE, preview: env[ALLOW_STANDINS_VARIABLE] === '1' } } as const
}
