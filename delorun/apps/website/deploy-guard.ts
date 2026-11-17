/**
 * The deploy's guard against stand-in sessions. A deploy builds the site with the shell's environment, so a
 * `SITE_ALLOW_STANDINS` left exported would publish hand-made sessions. The deploy refuses to load while the variable
 * exists at all, whatever it says: only a review build sets it, and it never reaches a deploy.
 *
 * @module @delorun/website/deploy-guard
 */
import { ALLOW_STANDINS } from './src/replica/build/release.ts'

/**
 * Refuses an environment that carries the stand-in variable.
 * @param env - the environment the deploy would build with.
 * @throws Error when the variable is set, even to an empty string, `0` or `false`.
 */
export function refuseStandIns(env: Readonly<Record<string, string | undefined>>): void {
  if (ALLOW_STANDINS in env) throw new Error(`${ALLOW_STANDINS} is set in the environment. Unset it: a deploy never publishes stand-in sessions, and only a review build sets this variable.`)
}
