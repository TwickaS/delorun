/**
 * What an install reports while it runs, as typed events: the launcher turns each into one line for the person. The
 * install path never formats text for a terminal, and reports only what a check has already decided.
 *
 * @module @delo/install/progress
 */
import type { ReleaseChannel, SemanticVersion } from '@delo/contract-release-manifest'

/**
 * One step of an install that finished, in the order the steps run:
 *
 * - `resolved`: the verified timestamp names this release for the channel.
 * - `signature-checked`: the release's manifest verified under the trusted root, and its release-log bundle verified.
 * - `log-checked`: contract C18's online check found the release `verified`, or could not run (`unchecked`, with the
 *   reason). A check that failed refuses the install and reports no event.
 * - `downloading`: the runtime archive named by the signed manifest starts to download.
 */
export type InstallProgress =
  | { readonly step: 'resolved', readonly channel: ReleaseChannel, readonly version: SemanticVersion }
  | { readonly step: 'signature-checked', readonly version: SemanticVersion, readonly rootVersion: number }
  | { readonly step: 'log-checked', readonly version: SemanticVersion, readonly state: 'verified' | 'unchecked', readonly detail?: string }
  | { readonly step: 'downloading', readonly name: string, readonly bytes: number }
