/**
 * The running Host's answer to contract C19's `changes.reload`, which `@delorun/changes` owns
 * ([reload](../../../../packages/changes/src/reload.ts)): the home process calls it with the Host's `hmr` service.
 *
 * @module @delorun/cli/changes/reload
 */
export { reloadProfile, type HotReload } from '@delorun/changes'
