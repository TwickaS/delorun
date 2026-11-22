/**
 * What the launcher shows while it installs a release: `@delorun/install`'s one renderer, the one `delorun update` and
 * the plugin pack downloads use too. `LauncherProgress` names the same events for the launcher's own options.
 *
 * @module @delorun/npm-launcher/progress
 */
import type { InstallerProgress } from '@delorun/install'

export { createRenderer, formatSize, InstallRenderer, type InstallerProgress, type RenderStream } from '@delorun/install'

/** A step the launcher reports: `@delorun/install`'s steps, the store's `installing` and `installed`, and `starting`. */
export type LauncherProgress = InstallerProgress
