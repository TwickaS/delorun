/**
 * The site's text in the language it is built for, and the install commands. The words live in the per-language
 * dictionaries under `words/`; this module picks the one the site serves.
 *
 * @module @delorun/website/copy
 */
import { DICTIONARIES } from './words/index.ts'

/** The package managers the install command is shown for. */
export const PACKAGE_MANAGERS = ['pnpm', 'npm', 'bun'] as const

/** One of {@link PACKAGE_MANAGERS}. */
export type PackageManager = typeof PACKAGE_MANAGERS[number]

/** The manager shown before a visitor chooses, and on the server. */
export const DEFAULT_PACKAGE_MANAGER: PackageManager = 'pnpm'

/**
 * The install command for each package manager. `bunx` starts the launcher with Node, as its `#!/usr/bin/env node`
 * line asks, unless `--bun` is passed, so no flag is needed.
 */
export const INSTALL_COMMANDS: Readonly<Record<PackageManager, string>> = {
  pnpm: 'pnpm dlx delorun',
  npm: 'npx delorun',
  bun: 'bunx delorun',
}

/** Every string the site shows, in the language it is built for (English). */
export const COPY = DICTIONARIES.en
