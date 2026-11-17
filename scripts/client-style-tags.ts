import { relative, sep } from 'node:path'

/**
 * Document-wide id of one injected plugin stylesheet: the plugin id plus the
 * stylesheet path relative to the repository root. A basename is not unique
 * across packages that a bundle inlines, and the injector skips a tag whose id
 * already exists, so the second same-named stylesheet would never apply.
 * @param pluginId - Package that owns the bundle.
 * @param fileId - Absolute path of the stylesheet source.
 * @param repositoryRoot - Absolute repository root.
 * @returns The `data-plugin-css` value.
 */
export function styleTagId(pluginId: string, fileId: string, repositoryRoot: string): string {
  return `${pluginId}/${relative(repositoryRoot, fileId).split(sep).join('/')}`
}

/** Tag ids claimed so far in one client bundle, mapped to the stylesheet that claimed each. */
export type StyleTagClaims = Map<string, string>

/**
 * Record that a stylesheet will inject under a tag id.
 * @param claims - Claims of the bundle being built.
 * @param tagId - Tag id the stylesheet injects under.
 * @param fileId - Absolute path of the stylesheet source.
 * @throws When a different stylesheet in the same bundle already holds the id.
 */
export function claimStyleTag(claims: StyleTagClaims, tagId: string, fileId: string): void {
  const holder = claims.get(tagId)
  if (holder !== undefined && holder !== fileId) {
    throw new Error(
      `client style tag collision: "${tagId}" is claimed by both ${holder} and ${fileId}; `
      + 'the second stylesheet would never be injected',
    )
  }
  claims.set(tagId, fileId)
}
