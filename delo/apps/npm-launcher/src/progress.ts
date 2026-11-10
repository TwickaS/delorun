/**
 * The lines the launcher prints while it installs a release: `@delo/install`'s, the one copy `delorun update` prints
 * too. `LauncherProgress` names the same events for the launcher's own options.
 *
 * @module @delo/npm-launcher/progress
 */
import type { InstallerProgress } from '@delo/install'

export { formatSize, progressLines, type InstallerProgress } from '@delo/install'

/** A step the launcher reports, `@delo/install`'s steps and the store's `installing`. */
export type LauncherProgress = InstallerProgress
