/**
 * Reads one pinned package's integrity out of `pnpm-lock.yaml`, for the owner-attended proof's check of a package it
 * fetches with npm.
 * @module
 */

/**
 * Escape a literal for a `u`-flag regular expression, where escaping any other character, such as `@` or `-`, is a
 * syntax error.
 * @param literal - the text to match as it is.
 * @returns the pattern.
 */
function escapeLiteral(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\/]/gu, '\\$&')
}

/**
 * The lockfile's sha512 integrity of one package version.
 * @param lock - the text of `pnpm-lock.yaml`.
 * @param name - the package name, such as `@opencode/browse-windows-x64`.
 * @param version - the pinned version.
 * @returns the integrity string.
 * @throws Error when the lockfile pins no such package version.
 */
export function lockIntegrity(lock: string, name: string, version: string): string {
  const pattern = new RegExp(`'${escapeLiteral(name)}@${escapeLiteral(version)}':\\n\\s+resolution: \\{integrity: (sha512-[^}]+)\\}`, 'u')
  const match = pattern.exec(lock)
  if (match?.[1] === undefined) throw new Error(`pnpm-lock.yaml pins no ${name}@${version}`)
  return match[1]
}
