/**
 * The options the product website's build and its component specs pass to the replica's build plugins: the aliases and
 * the release the site markets. The plugin itself reads `SITE_ALLOW_STANDINS`: a production build carries only real
 * recordings made on the marketed release, and accepts stand-in sessions only when the environment says exactly
 * `SITE_ALLOW_STANDINS=1`. That variable is never set in a committed configuration or by a deploy; local builds, the
 * check runner's `website-site` check (`delorun/apps/tools/src/check-docs-site.ts`, the one place that sets it) and the
 * review builds do.
 *
 * @module @delorun/website/replica-options
 */
import { STUDIO_ALIASES } from './studio-aliases.ts'

/** The release the site markets, which a recorded session must have been made on. */
export const MARKETED_RELEASE = '0.1.0'

export { ALLOW_STANDINS as ALLOW_STANDINS_VARIABLE } from './src/replica/build/release.ts'

/**
 * The replica plugins' options.
 * @returns the aliases and the marketed release. Nothing here names or sets the stand-in variable.
 */
export function replicaOptions() {
  return { aliases: STUDIO_ALIASES, release: MARKETED_RELEASE } as const
}
