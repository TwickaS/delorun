/**
 * Browser half of Multiview. This entry is a placeholder until the entry-point and panel lanes register the `main`
 * panel, the header button and the pin buttons; the layout engine they build on is `../layout/index.ts`.
 * @module @delorun/plugin-multiview/client
 */

import type { Context } from '@deepseek-ai/cordis'

/** Services every registration needs. */
export const inject: string[] = []

/**
 * Register nothing yet.
 * @param _ctx - the browser plugin context.
 */
export function apply(_ctx: Context): void {}
