/** Reads the source a profile's approved-plugin record names for a package. */

/**
 * Whether the profile's approved-plugin record (`delorun.changes.plugins`, written by Changes) says a package was
 * approved from the folder an offered install target links to. Then the installed copy is the reviewed copy of that
 * target, and its own `link:` spec differing from the target's does not make it a different source.
 * @param manifest - the profile's `package.json` content.
 * @param name - the package name.
 * @param target - the install target the manager offers for the package, if any.
 * @returns true when the approved source is the folder of a `link:` target.
 */
export function approvedFromTarget(manifest: object, name: string, target: { readonly spec: string } | undefined): boolean {
  if (target === undefined || !target.spec.startsWith('link:')) return false
  // The record is file data written by another package, so each level is checked before use.
  const changes = (manifest as { delorun?: { changes?: { plugins?: Record<string, { source?: unknown } | undefined> } } }).delorun?.changes
  const source = changes?.plugins?.[name]?.source
  return typeof source === 'string' && source === target.spec.slice('link:'.length)
}
