/**
 * Class-name joining for the list's components.
 * @module @delorun/plugin-sidebar/client/cx
 */

/**
 * Join class names, leaving out the ones that are false or missing.
 * @param names - class names, or false or undefined for a class that does not apply.
 * @returns the names separated by spaces.
 */
export function cx(...names: readonly (string | false | undefined)[]): string {
  return names.filter(Boolean).join(' ')
}
