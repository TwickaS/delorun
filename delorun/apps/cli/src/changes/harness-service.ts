/**
 * The `changesHarness` service the home process provides to the Host it boots, so the studio's Changes routes decide
 * changes to Delorun itself against the running runtime's signed file list, the one `delorun changes` uses
 * ({@link harnessContextOf}). A Host that does not run from the runtime store, such as one run from a source checkout,
 * gets a service whose harness is undefined, and the routes answer that they cannot change Delorun's own files.
 *
 * @module @delorun/cli/changes/harness-service
 */
import type { Context } from '@deepseek-ai/cordis'
import type { ChangesHarnessHost, HarnessContext } from '@delorun/changes'

/**
 * Provide `changesHarness` on the Host's root context for as long as it runs.
 * @param root - the Host's root context, before the Loader mounts its first row.
 * @param harness - the running runtime's harness, or undefined outside the runtime store.
 */
export function provideChangesHarness(root: Context, harness: HarnessContext | undefined): void {
  const host: ChangesHarnessHost = { context: () => harness }
  root.effect(() => root.provide('changesHarness', host), 'delorun changes harness')
}
