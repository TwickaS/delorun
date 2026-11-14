/**
 * The lines the launcher prints while it installs a release: `@delorun/install`'s, the one copy `delorun update` prints
 * too. `LauncherProgress` names the same events for the launcher's own options.
 *
 * @module @delorun/npm-launcher/progress
 */
import type { InstallerProgress } from '@delorun/install'

export { formatSize, progressLines, type InstallerProgress } from '@delorun/install'

/** A step the launcher reports, `@delorun/install`'s steps and the store's `installing`. */
export type LauncherProgress = InstallerProgress
