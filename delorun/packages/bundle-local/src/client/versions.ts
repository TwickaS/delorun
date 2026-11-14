/**
 * Delorun's version and the DeepSeek Harness version it runs on, as the harness half prints them into each page under
 * {@link VERSIONS_GLOBAL}. The page global crosses a process boundary, so it is read through {@link readVersions}.
 * @module @delorun/bundle-local/client/versions
 */

/** The `globalThis` property the harness half's index injection sets. */
export const VERSIONS_GLOBAL = 'delorunVersions'

/** The two versions the About page shows. */
export interface DelorunVersions {
  /** Delorun's version, from the `delorun` that started the harness. */
  readonly delorun: string
  /** The DeepSeek Harness version Delorun runs on. */
  readonly dsh: string
}

const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/

/**
 * Read the versions the harness printed into the page.
 * @param scope - the object holding the page global; `globalThis` by default.
 * @returns both versions, or `undefined` when the page carries none or carries anything other than two version strings.
 */
export function readVersions(scope: object = globalThis): DelorunVersions | undefined {
  const value: unknown = Reflect.get(scope, VERSIONS_GLOBAL)
  if (typeof value !== 'object' || value === null) return undefined
  const delorun: unknown = Reflect.get(value, 'delorun')
  const dsh: unknown = Reflect.get(value, 'dsh')
  if (typeof delorun !== 'string' || typeof dsh !== 'string' || !VERSION.test(delorun) || !VERSION.test(dsh)) return undefined
  return { delorun, dsh }
}
