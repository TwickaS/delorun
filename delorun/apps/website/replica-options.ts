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
import { loadView } from '../../packages/site-design/src/changelog.ts'
import { STUDIO_ALIASES } from './studio-aliases.ts'

/**
 * The release the site markets: the newest version in the changelog record, which is also the version the home page
 * names. There is no literal to keep in step with it.
 * @param root - the repository root.
 * @returns the version, such as `0.1.0-preview.2`.
 * @throws Error when the record has no version, since a build then has no release to market.
 */
export function marketedRelease(root: string): string {
  const version = loadView(root)?.versions[0]?.version
  if (version === undefined) throw new Error('replica: the changelog record has no version, so there is no release to market')
  return version
}

export { ALLOW_STANDINS as ALLOW_STANDINS_VARIABLE } from './src/replica/build/release.ts'

/**
 * The replica plugins' options.
 * @param root - the repository root, where the changelog record is.
 * @returns the aliases and the marketed release. Nothing here names or sets the stand-in variable.
 */
export function replicaOptions(root: string) {
  return { aliases: STUDIO_ALIASES, release: marketedRelease(root) } as const
}
