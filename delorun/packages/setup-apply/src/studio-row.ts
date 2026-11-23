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

/** The ports web browsers refuse to connect to (the fetch standard's list, from 1024 up): a studio there cannot be opened. */
export const BROWSER_BLOCKED_PORTS: ReadonlySet<number> = new Set([6000, 6665, 6666, 6667, 6668, 6669, 6697, 10_080])

/**
 * Why a port cannot be the studio's, beyond being in range.
 * @param port - the port.
 * @param listenerPort - the port the phone-access listener holds; 0 when it holds none.
 * @returns the sentence to show, or `undefined` for a usable port.
 */
export function studioPortProblem(port: number, listenerPort = 0): string | undefined {
  if (BROWSER_BLOCKED_PORTS.has(port)) return `Port ${String(port)} is blocked by web browsers, so the studio could not be opened there. Choose another.`
  if (listenerPort !== 0 && port === listenerPort) return `Port ${String(port)} is the one phone access listens on. Choose another.`
  return undefined
}
