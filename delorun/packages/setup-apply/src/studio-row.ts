/**
 * The Web bundle's web server row that holds the studio's port.
 *
 * @module @delorun/setup-apply/studio-row
 */
import type { PatchRow } from './patch-file.ts'

/** The id of the Web bundle's web server row, whose `port` the profile section and the studio's port control set. */
export const STUDIO_ROW_ID = 'webserver'

/**
 * The patch row that makes the studio listen on a port. The patch replaces the web server row's config, so the row's
 * other keys are restated from the Web bundle.
 * @param port - the port; the caller has checked it.
 * @returns the row.
 */
export function studioRow(port: number): PatchRow {
  return { id: STUDIO_ROW_ID, config: { host: '127.0.0.1', port, compression: 'gzip', compressionLevel: 1, compressionThresholdBytes: 1024 } }
}
