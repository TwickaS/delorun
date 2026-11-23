/**
 * The launcher's judgement of the profile's bundle layers as the Host's `delorunPackLayers` service, which
 * `@delorun/plugin-mcp-consent` reads at each review to tell a server from a pack or from Delorun's own bundles from one
 * a third-party bundle brings (A631, L201). The judgement is the composition's own ({@link packLayersOf}); it reads the
 * folders and the approved record at each call, so a hot reload that changed the layers is judged as it is then.
 *
 * @module @delorun/cli/pack-layers-service
 */
import type { Context } from '@deepseek-ai/cordis'
import type { DelorunPackLayers } from '@delorun/plugin-mcp-consent'

/**
 * Provide `delorunPackLayers` on the Host's root context for as long as it runs.
 * @param root - the Host's root context, before the Loader mounts its first row.
 * @param layers - the judge ({@link packLayersOf} of the composed start).
 */
export function providePackLayers(root: Context, layers: DelorunPackLayers): void {
  root.effect(() => root.provide('delorunPackLayers', layers), 'delorun pack layers')
}
