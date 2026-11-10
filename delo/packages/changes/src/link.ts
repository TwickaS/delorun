/**
 * The profile's `link:` dependencies: plugins the person links from a folder. pnpm records one in three places, the
 * spec in the profile's `package.json`, the importer entry in `pnpm-lock.yaml` and the `node_modules/<name>` symbolic
 * link, and resets the link to the recorded spec on every operation. Changes therefore moves the recorded spec: a
 * plugin under Changes is `link:<active directory>` in all three places ([paths](./paths.ts)), and pnpm keeps it.
 *
 * @module @delo/changes/link
 */
import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { lstat, mkdir, readFile, rename, rm, stat, symlink } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { isMap, parseDocument } from 'yaml'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { ChangesError } from './errors.ts'

/** The manifest sections a profile's plugin dependency can be in, in the order they are read. */
export const LINK_SECTIONS = ['dependencies', 'optionalDependencies', 'devDependencies'] as const

/** One manifest section of {@link LINK_SECTIONS}. */
export type LinkSection = (typeof LINK_SECTIONS)[number]

/** The spec prefix pnpm records for a dependency linked from a folder. */
export const LINK_PREFIX = 'link:'

/** One `link:` dependency of the profile's manifest. */
export interface ProfileLink {
  /** The package name. */
  readonly name: string
  /** The section that holds it; the first of {@link LINK_SECTIONS} when several do. */
  readonly section: LinkSection
  /** The spec as written, `link:` included. */
  readonly spec: string
  /** The folder the spec names, absolute: relative to the profile directory, with a leading `~` as the OS home. */
  readonly target: string
}

/** The profile manifest's filename. */
const MANIFEST = 'package.json'

/** The profile lockfile's filename. */
const LOCKFILE = 'pnpm-lock.yaml'

/** A JSON object read from a file, whose members are checked where they are used. */
export type JsonObject = Record<string, unknown>

/**
 * The `link:` dependencies of the profile's manifest.
 * @param profileDir - the profile directory.
 * @returns one entry per package name with a `link:` spec, in manifest order.
 * @throws {ChangesError} `RECORD_UNREADABLE` when the manifest cannot be read or is not a JSON object.
 */
export async function readLinks(profileDir: string): Promise<ProfileLink[]> {
  const manifest = await readProfileManifest(profileDir)
  const links = new Map<string, ProfileLink>()
  for (const section of LINK_SECTIONS) {
    const entries = manifest[section]
    if (!isJsonObject(entries)) continue
    for (const [name, spec] of Object.entries(entries)) {
      if (links.has(name) || typeof spec !== 'string' || !spec.startsWith(LINK_PREFIX)) continue
      links.set(name, { name, section, spec, target: linkTarget(profileDir, spec.slice(LINK_PREFIX.length)) })
    }
  }
  return [...links.values()]
}

/**
 * Point one `link:` dependency at another folder in all three places pnpm records it: the manifest's spec becomes
 * `link:<target>`, the lockfile's importer `.` entry for it (when the lockfile has one) gets `specifier: link:<target>`
 * and `version: link:<target relative to the profile>`, and `node_modules/<name>` becomes a relative symbolic link to
 * the target, replaced in one rename. Everything else in both files is kept. The caller holds the profile's write lock,
 * the `package.json` file lock upstream's plugin management takes.
 * @param profileDir - the profile directory.
 * @param name - the package name.
 * @param target - the folder to link, absolute.
 * @throws {ChangesError} `NOT_LINKED` when the manifest has no `link:` spec for the package; `RECORD_UNREADABLE` when
 *   the manifest or the lockfile cannot be read.
 */
export async function pointLinkAt(profileDir: string, name: string, target: string): Promise<void> {
  const spec = `${LINK_PREFIX}${target}`
  const manifestPath = join(profileDir, MANIFEST)
  const manifest = await readProfileManifest(profileDir)
  let linked = false
  for (const section of LINK_SECTIONS) {
    const entries = manifest[section]
    if (!isJsonObject(entries)) continue
    const current = entries[name]
    if (typeof current !== 'string' || !current.startsWith(LINK_PREFIX)) continue
    entries[name] = spec
    linked = true
  }
  if (!linked) throw new ChangesError('NOT_LINKED', name, `${name} is not linked from a folder in the profile ${profileDir}.`)
  await writeFileAtomic(manifestPath, JSON.stringify(manifest, undefined, 2) + '\n', { mode: await modeOf(manifestPath) })
  await pointLockfileAt(profileDir, name, spec, `${LINK_PREFIX}${relative(profileDir, target).split(sep).join('/')}`)
  await replaceSymlink(join(profileDir, 'node_modules', name), target)
}

/**
 * The folder a `link:` spec names.
 * @param profileDir - the directory a relative path is relative to.
 * @param path - the spec without `link:`.
 * @returns the absolute folder.
 */
function linkTarget(profileDir: string, path: string): string {
  if (/^~(?=$|[\\/])/.test(path)) return join(homedir(), path.slice(1))
  return isAbsolute(path) ? resolve(path) : resolve(profileDir, path)
}

/**
 * Read the profile's manifest.
 * @param profileDir - the profile directory.
 * @returns the manifest.
 * @throws {ChangesError} `RECORD_UNREADABLE` when it cannot be read or is not a JSON object.
 */
export async function readProfileManifest(profileDir: string): Promise<JsonObject> {
  const path = join(profileDir, MANIFEST)
  let parsed: unknown
  try {
    parsed = JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    throw new ChangesError('RECORD_UNREADABLE', path, `The profile's ${MANIFEST} could not be read: ${String(error)}`, { cause: error })
  }
  if (!isJsonObject(parsed)) throw new ChangesError('RECORD_UNREADABLE', path, `The profile's ${MANIFEST} is not a JSON object.`)
  return parsed
}

/**
 * Rewrite the lockfile's importer `.` entries for one package, keeping the rest of the file as it is.
 * @param profileDir - the profile directory.
 * @param name - the package name.
 * @param specifier - the new `specifier`.
 * @param version - the new `version`.
 * @throws {ChangesError} `RECORD_UNREADABLE` when the lockfile exists but is not YAML.
 */
async function pointLockfileAt(profileDir: string, name: string, specifier: string, version: string): Promise<void> {
  const path = join(profileDir, LOCKFILE)
  if (!existsSync(path)) return
  const document = parseDocument(await readFile(path, 'utf8'))
  if (document.errors.length > 0) {
    throw new ChangesError('RECORD_UNREADABLE', path, `The profile's ${LOCKFILE} is not YAML: ${document.errors.map(error => error.message).join('; ')}`)
  }
  let changed = false
  for (const section of LINK_SECTIONS) {
    const entry = document.getIn(['importers', '.', section, name], true)
    if (!isMap(entry)) continue
    entry.set('specifier', specifier)
    entry.set('version', version)
    changed = true
  }
  if (!changed) return
  await writeFileAtomic(path, document.toString({ lineWidth: 0, flowCollectionPadding: false }), { mode: await modeOf(path) })
}

/**
 * Replace `node_modules/<name>` with a relative symbolic link to the target: a link is created beside it and renamed
 * over it, so the entry always names either the old or the new folder. A directory in its place is removed first.
 * @param linkPath - the entry's path.
 * @param target - the folder, absolute.
 */
async function replaceSymlink(linkPath: string, target: string): Promise<void> {
  const parent = dirname(linkPath)
  await mkdir(parent, { recursive: true })
  const existing = await lstat(linkPath).catch((error: unknown) => {
    // A missing entry is replaced by the new link like any other.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  })
  if (existing?.isDirectory() === true) await rm(linkPath, { recursive: true, force: true })
  const temp = `${linkPath}.${randomBytes(6).toString('hex')}.tmp`
  // Windows makes a junction, which needs no privilege; elsewhere the type is ignored.
  await symlink(relative(parent, target), temp, 'junction')
  try {
    await rename(temp, linkPath)
  } catch (error) {
    await rm(temp, { force: true })
    throw error
  }
}

/**
 * @param path - an existing file.
 * @returns its permission bits, which a rewrite keeps.
 */
async function modeOf(path: string): Promise<number> {
  return (await stat(path)).mode & 0o777
}

/**
 * @param value - a parsed JSON value.
 * @returns whether it is a JSON object.
 */
export function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
