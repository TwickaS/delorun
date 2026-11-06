/**
 * Types and fixed values of contract C17, plugin version requirements
 * (`delo/docs/contracts/c17-plugin-versions.md`). A plugin is checked on two axes: upstream's
 * `engines.dsh` against `@deepseek-ai/dsh-app-boot`'s version, and `engines.delo` against
 * Delo's version, each with its own exact-version exemption file.
 *
 * @module @delo/contract-plugin-versions
 */

import type { SemanticVersion } from '@delo/contract-release-manifest'

/** The two version axes. */
export type VersionAxis = 'dsh' | 'delo'

/** Both axes in display order. */
export const VERSION_AXES: readonly VersionAxis[] = ['dsh', 'delo']

/** The `package.json` field of each axis's requirement. */
export const REQUIREMENT_FIELDS = {
  dsh: 'engines.dsh',
  delo: 'engines.delo',
} as const

/**
 * One axis's evaluation. `met`: the range is satisfied, with prereleases taking part.
 * `unmet`: not satisfied, or an empty, `workspace:` or invalid range. `unreadable`: the
 * declaration is not a string; treated as unmet. `none`: nothing declared on that axis.
 */
export type AxisStatus = 'met' | 'unmet' | 'unreadable' | 'none'

/** One axis's result for one plugin. */
export interface AxisResult {
  /** The evaluation. */
  readonly status: AxisStatus
  /** The declared range, for `met` and `unmet`. */
  readonly requirement?: string
  /** Whether an exemption for this exact plugin version and axis version admits an `unmet` result. */
  readonly exempted: boolean
}

/** Both versions a plugin is checked against. */
export interface VersionPair {
  /** Delo's release version. */
  readonly delo: SemanticVersion
  /** The `@deepseek-ai/dsh-app-boot` version. */
  readonly dsh: SemanticVersion
}

/** The result of evaluating one plugin against one {@link VersionPair}. */
export interface PluginVersionResult extends VersionPair {
  /** The plugin's manifest identity. */
  readonly plugin: { readonly name: string, readonly version: SemanticVersion }
  /** Each axis's result. */
  readonly axes: Readonly<Record<VersionAxis, AxisResult>>
}

/** The profile file holding each axis's exemptions; both map exact `package@version` keys to lists of exact versions, written with mode 0600. */
export const EXEMPTION_FILES = {
  dsh: 'compatibility.json',
  delo: 'delo-compatibility.json',
} as const

/** The `delorun plugin allow-version` option naming each axis's version. */
export const EXEMPTION_VERSION_OPTIONS = {
  dsh: '--dsh-version',
  delo: '--delo-version',
} as const

/** The contents of an exemption file: exact `package@version` keys to exact versions of the file's axis. */
export type ExemptionRecord = Readonly<Record<string, readonly SemanticVersion[]>>

/** Mode of both exemption files. */
export const EXEMPTION_FILE_MODE = 0o600

/** The JSON line `delorun --version --json` prints. */
export interface VersionOutput {
  /** Delo's version. */
  readonly delo: SemanticVersion
  /** Upstream's version. */
  readonly dsh: SemanticVersion
}

/** The label of each line `delorun --version` prints, in order: `Delo <delo>`, then `DSH <dsh>`. */
export const VERSION_OUTPUT_LABELS: readonly ['Delo', 'DSH'] = ['Delo', 'DSH']
