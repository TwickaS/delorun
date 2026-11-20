/**
 * @delorun/plugin-multiview — Multiview, which is browser-only. This half declares the settings the browser half reads
 * through the settings service ({@link Config}) and mounts nothing else; the studio loads the package's `./client` module.
 * @module @delorun/plugin-multiview
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Config as MultiviewConfig } from './config.ts'

export {
  Config, DEFAULT_MULTIVIEW_SETTINGS, MAX_PANES_RANGE, MIN_PANE_SIZE_RANGE, MULTIVIEW_ROW_ID, type MultiviewSettings,
} from './config.ts'

/** The plugin's name in logs. */
export const name = 'delorun-multiview'

/**
 * Mount nothing: Multiview lives in the browser, and its settings are read there.
 * @param _ctx - the harness context.
 * @param _config - the validated settings, served to the browser by the settings service.
 */
export function apply(_ctx: Context, _config: MultiviewConfig): void {}
