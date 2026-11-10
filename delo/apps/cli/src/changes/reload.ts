/**
 * The running Host's answer to contract C19's `changes.reload`: upstream's hot reload recomposes the profile from its
 * files and replaces every loaded plugin whose files changed on disk, so the Host runs what `delorun changes` wrote.
 * Nothing here reads or writes a file of Changes.
 *
 * @module @delo/cli/changes/reload
 */
import type { ChangesReloadOutcome } from '@delo/contract-home-process'

/** What the reload needs of upstream's `hmr` service (`@deepseek-ai/dsh-hmr`). */
export interface HotReload {
  /**
   * Run work that must not overlap any other reload.
   * @param operation - the work.
   * @returns what it returned.
   */
  runExclusive<T>(operation: () => Promise<T>): Promise<T>
  /**
   * Recompose the profile from its files, replacing running plugins whose files changed.
   * @returns why every change waits for a restart, when it does.
   * @throws when a replaced or added plugin fails to load or start.
   */
  reconcileProfile(): Promise<{ readonly restartReason?: string }>
}

/**
 * Make the running Host load what the profile's files now name.
 * @param hmr - upstream's hot reload service, or undefined when the profile runs without it.
 * @returns `ok`, or the error: hot reload is off, a plugin failed to load or start, or the change needs a restart.
 */
export async function reloadProfile(hmr: HotReload | undefined): Promise<ChangesReloadOutcome> {
  if (hmr === undefined) return { ok: false, error: 'hot reload is off; restart Delo' }
  try {
    const { restartReason } = await hmr.runExclusive(() => hmr.reconcileProfile())
    return restartReason === undefined ? { ok: true } : { ok: false, error: `the change loads only after a restart (${restartReason}); restart Delo` }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}
