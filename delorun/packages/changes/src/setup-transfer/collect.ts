/**
 * Reading a profile's setup for `delorun setup export`: the plugins the person added, named by exact version where a
 * registry serves them and carried as the approved copy's files where the person made them, and the patch entries the
 * [policy](./policy.ts) carries. Nothing is written. A value that looks like a credential in an entry that would be
 * carried stops the export, because the file leaves this computer.
 *
 * @module @delorun/changes/setup-transfer/collect
 */
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseSetupDocument, SETUP_MAX_PLUGIN_FILES, type SetupDocument, type SetupJson, type SetupPlugin, type SetupPluginFile } from '@delorun/archive'
import { dependenciesOf, isLocalSpec } from '@delorun/profile-safety'
import { isMap, isScalar, isSeq, parseDocument, visit } from 'yaml'
import type { ChangesContext } from '../actions.ts'
import { ChangesError } from '../errors.ts'
import { readProfileManifest } from '../link.ts'
import { PACKAGE_NAME_PATTERN } from '../paths.ts'
import { approvedOf, readApproved } from '../records.ts'
import { readObject, readVersion } from '../store.ts'
import { isPlainObject, isProductPackage, judgeEntry } from './policy.ts'

/** The most bytes of plugin files one setup carries: 256 MiB. */
export const SETUP_MAX_PLUGIN_BYTES = 256 * 1024 * 1024

/** An exact version, as a setup names one. */
const EXACT_VERSION = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u

/** What an export collected. */
export interface SetupExport {
  /** The document to write. */
  readonly document: SetupDocument
  /** The bytes of each local plugin file, by SHA-256. */
  readonly files: ReadonlyMap<string, Uint8Array>
  /** What the setup does not carry, one sentence each, never holding a value. */
  readonly leftOut: readonly string[]
}

/**
 * Read the profile's setup.
 * @param ctx - the profile.
 * @returns the document, the files it names and what was left out.
 * @throws {ChangesError} `SETUP_REFUSED` for a patch entry that would be carried but holds a credential, a patch layer that is not YAML or a plugin larger than a setup carries; `RECORD_UNREADABLE` when the profile's manifest cannot be read; `STORE_CORRUPT` when the store does not hold an approved copy.
 */
export async function collectSetup(ctx: ChangesContext): Promise<SetupExport> {
  const manifest = await readProfileManifest(ctx.profileDir)
  const dependencies = dependenciesOf(manifest)
  const approved = await readApproved(ctx.profileDir)
  const integrities = await lockfileIntegrities(ctx.profileDir)
  const leftOut: string[] = []
  const files = new Map<string, Uint8Array>()
  const plugins: SetupPlugin[] = []
  let carriedBytes = 0
  for (const [name, spec] of Object.entries(dependencies)) {
    if (isProductPackage(name)) continue
    if (!PACKAGE_NAME_PATTERN.test(name)) {
      leftOut.push(`${name}: not a package name`)
      continue
    }
    if (!isLocalSpec(spec)) {
      const installed = await installedVersion(ctx.profileDir, name)
      const integrity = installed === undefined ? undefined : integrities.get(`${name}@${installed}`)
      if (installed === undefined) leftOut.push(`${name}: not installed in this profile, so its version is unknown`)
      else plugins.push({ name, source: 'registry', version: installed, ...integrity === undefined ? {} : { integrity } })
      continue
    }
    const approval = approvedOf(approved, name)
    if (approval === undefined) {
      leftOut.push(`${name}: made on this computer and not approved yet, so there is no copy to carry (delorun changes list)`)
      continue
    }
    const version = await readVersion(ctx.home, approval.version)
    const carried: SetupPluginFile[] = []
    const carriedBytesBefore = carriedBytes
    let links = 0
    for (const entry of version.entries) {
      if (entry.type === 'link') {
        links += 1
        continue
      }
      const bytes = await readObject(ctx.home, entry.digest)
      carriedBytes += bytes.length
      if (carried.length >= SETUP_MAX_PLUGIN_FILES || carriedBytes > SETUP_MAX_PLUGIN_BYTES) {
        throw new ChangesError('SETUP_REFUSED', name, `${name} holds more than a setup carries (${String(SETUP_MAX_PLUGIN_FILES)} files, or ${String(SETUP_MAX_PLUGIN_BYTES / 1024 / 1024)} MiB with the other plugins); publish it to a registry or share its folder instead.`)
      }
      files.set(entry.digest, bytes)
      carried.push({ path: entry.path, sha256: entry.digest, size: bytes.length, executable: entry.executable })
    }
    const packageJson = carried.find(file => file.path === 'package.json')
    if (packageJson === undefined) {
      leftOut.push(`${name}: its approved copy has no package.json at its top`)
      carriedBytes = carriedBytesBefore
      continue
    }
    if (links > 0) leftOut.push(`${name}: ${String(links)} symbolic link${links === 1 ? '' : 's'} not carried; install the packages the plugin needs in its folder after the import`)
    const declared = packageVersion(files.get(packageJson.sha256)!)
    plugins.push({ name, source: 'local', ...declared === undefined ? {} : { version: declared }, files: carried })
  }
  const patch = await collectPatch(ctx.profileDir, new Set(plugins.map(plugin => plugin.name)), leftOut)
  const document: SetupDocument = { schemaVersion: 1, profile: ctx.profile, plugins, patch }
  // The document is held to the schema an import applies, so an export never writes a setup its own import refuses.
  parseSetupDocument(new TextEncoder().encode(JSON.stringify(document)))
  return { document, files, leftOut }
}

/**
 * The version a plugin's `package.json` declares.
 * @param bytes - the file's bytes.
 * @returns the exact version, or undefined when the file declares none that a setup can name.
 */
function packageVersion(bytes: Uint8Array): string | undefined {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(bytes).toString('utf8'))
    const version = isPlainObject(parsed) ? parsed['version'] : undefined
    return typeof version === 'string' && EXACT_VERSION.test(version) ? version : undefined
  } catch {
    // A package.json that is not JSON declares no version; the plugin is still carried.
    return undefined
  }
}

/**
 * The version installed under the profile's `node_modules`.
 * @param profileDir - the profile directory.
 * @param name - the package.
 * @returns the version its `package.json` declares, or undefined when it is not installed.
 */
async function installedVersion(profileDir: string, name: string): Promise<string | undefined> {
  const path = join(profileDir, 'node_modules', name, 'package.json')
  if (!existsSync(path)) return undefined
  return packageVersion(await readFile(path))
}

/**
 * The integrity the profile's lockfile records for each registry package, keyed `name@version`.
 * @param profileDir - the profile directory.
 * @returns the integrities; empty when the profile has no readable lockfile.
 */
export async function lockfileIntegrities(profileDir: string): Promise<ReadonlyMap<string, string>> {
  const path = join(profileDir, 'pnpm-lock.yaml')
  const found = new Map<string, string>()
  if (!existsSync(path)) return found
  const document = parseDocument(await readFile(path, 'utf8'), { logLevel: 'silent' })
  if (document.errors.length > 0) return found
  const packages = document.get('packages', true)
  if (!isMap(packages)) return found
  for (const item of packages.items) {
    const key = isScalar(item.key) ? item.key.value : undefined
    const resolution: unknown = isMap(item.value) ? item.value.get('resolution') : undefined
    const integrity: unknown = isMap(resolution) ? resolution.get('integrity') : undefined
    if (typeof key === 'string' && typeof integrity === 'string') found.set(key, integrity)
  }
  return found
}

/**
 * The patch entries a setup carries.
 * @param profileDir - the profile directory.
 * @param plugins - the names of the plugins the setup carries.
 * @param leftOut - receives one sentence for each entry not carried.
 * @returns the entries, as data.
 * @throws {ChangesError} `SETUP_REFUSED` for a patch layer that is not a YAML list, or an entry that would be carried but holds a credential.
 */
async function collectPatch(profileDir: string, plugins: ReadonlySet<string>, leftOut: string[]): Promise<SetupDocument['patch']> {
  const path = join(profileDir, 'cordis.patch.yml')
  if (!existsSync(path)) return []
  const document = parseDocument(await readFile(path, 'utf8'), { logLevel: 'silent' })
  if (document.errors.length > 0) throw new ChangesError('SETUP_REFUSED', path, "The profile's cordis.patch.yml is not YAML, so its settings cannot be exported.")
  if (document.contents === null) return []
  if (!isSeq(document.contents)) throw new ChangesError('SETUP_REFUSED', path, "The profile's cordis.patch.yml is not a list of patch entries, so its settings cannot be exported.")
  const carried: Record<string, SetupJson>[] = []
  for (const item of document.contents.items) {
    let tagged = false
    visit(item, { Node: (_key, node) => { if (node.tag !== undefined) tagged = true } })
    const entry: unknown = isMap(item) ? item.toJSON() : undefined
    if (!isPlainObject(entry)) {
      leftOut.push('a patch entry that is not a mapping')
      continue
    }
    if (tagged) {
      leftOut.push(`${typeof entry['id'] === 'string' ? entry['id'] : 'a patch entry'}: holds an expression (!!js), which a setup never carries`)
      continue
    }
    const verdict = judgeEntry(entry, plugins)
    if (verdict.carry) carried.push(entry as Record<string, SetupJson>)
    else if (verdict.secret === true) throw new ChangesError('SETUP_REFUSED', path, `Nothing was exported: ${verdict.reason}. A key belongs in the credentials file, not in a settings row; delorun setup stores it there.`)
    else leftOut.push(verdict.reason)
  }
  return carried
}
