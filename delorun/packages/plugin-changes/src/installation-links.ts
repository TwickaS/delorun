/**
 * The links of a profile that name the running installation's own packages. A start recognises them from the Host's
 * published resolution; when a package such as `@delorun/bundle-local` failed to import, the resolution does not list its
 * link, and the check before a reload would take the installation's own folder for a plugin folder and scan it whole.
 *
 * @module @delorun/plugin-changes/installation-links
 */
import { readFileSync, realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * The directory this package sits in: the running installation's own packages, `delorun/packages` in a source checkout
 * and `node_modules/@delorun` in a stored runtime.
 * @returns its absolute path.
 */
export function installationPackagesDirectory(): string {
  return dirname(fileURLToPath(new URL('..', import.meta.url)))
}

/**
 * @param path - a path.
 * @returns its real path, or undefined when it does not resolve: nothing is there (`ENOENT`, `ENOTDIR`), a link loops
 *   (`ELOOP`) or a directory on the way cannot be searched (`EACCES`, `EPERM`). Such a link is not the installation's, and
 *   Changes records it as unreadable.
 * @throws the filesystem error other than those.
 */
function realPathOf(path: string): string | undefined {
  try {
    return realpathSync(path)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'ELOOP' || code === 'EACCES' || code === 'EPERM') return undefined
    throw error
  }
}

/**
 * @param directory - a package directory.
 * @returns the `name` of its `package.json`, or undefined when it has none or cannot be parsed.
 */
function manifestName(directory: string): string | undefined {
  try {
    const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')) as { readonly name?: unknown }
    return typeof manifest.name === 'string' ? manifest.name : undefined
  } catch (error) {
    // A missing, unreadable or unparsable manifest is no package of the installation; the link is then scanned like any
    // plugin folder.
    const code = (error as NodeJS.ErrnoException).code
    if (error instanceof SyntaxError || code === 'ENOENT' || code === 'EACCES' || code === 'EISDIR') return undefined
    throw error
  }
}

/**
 * Whether a link is one of the installation's own packages: the package is one the installation ships (its profile
 * bundles, the list Safe mode keeps), the link's real target is the real directory this installation keeps the package
 * in, next to this package, and that directory's manifest names the package. A link to any other folder, however it is
 * spelled, is not, and neither is a folder here that the installation does not ship.
 * @param shipped - the names of the packages the installation ships.
 * @param packagesDirectory - the directory the installation keeps its packages in.
 * @returns a predicate over the linked package's name and the folder its link names.
 */
export function installationLinks(
  shipped: readonly string[],
  packagesDirectory: string = installationPackagesDirectory(),
): (name: string, target: string) => boolean {
  return (name, target) => {
    if (!shipped.includes(name)) return false
    const own = realPathOf(join(packagesDirectory, name.slice(name.lastIndexOf('/') + 1)))
    return own !== undefined && realPathOf(target) === own && manifestName(own) === name
  }
}
