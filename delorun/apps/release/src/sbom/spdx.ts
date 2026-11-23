/**
 * The release's SPDX 2.3 JSON SBOM (contract C2, `delorun-<version>.spdx.json`), generated from the runtime archives
 * themselves so it lists what each archive holds: one SPDX package per archive with its SHA-256, the pinned Node and
 * pnpm, and one package per installed npm package version with its purl and, when the closure's lockfile names one,
 * its registry integrity. Every value derives from the archives, the lockfiles and the recipe, and `created` is the
 * release's `SOURCE_DATE_EPOCH`, so the same release always gives the same document.
 *
 * @module @delorun/release/sbom/spdx
 */
import { createHash } from 'node:crypto'
import { RELEASE_REPOSITORY_URL, type RuntimePlatform } from '@delorun/contract-release-manifest'
import { parse as parseYaml } from 'yaml'

/** One npm package version found in an archive. */
export interface NpmPackageEntry {
  readonly name: string
  readonly version: string
  /** The package's `license` field, when it is a string. */
  readonly license?: string
}

/** What the SBOM describes of one runtime archive. */
export interface ArchiveContents {
  readonly platform: RuntimePlatform
  readonly name: string
  readonly sha256: string
  readonly packages: readonly NpmPackageEntry[]
  /** The closure lockfile's text. */
  readonly lockfile: string
}

/** The S2 and S3 images and the base they are built from. */
export interface ImageContents {
  /** The base image reference, by digest. */
  readonly base: string
  /** Each image by repository and index digest. */
  readonly images: Readonly<Record<'s2' | 's3', { readonly repository: string, readonly index: string }>>
  /** Each image's installed Debian packages per OCI platform. */
  readonly debian: Readonly<Record<'s2' | 's3', Readonly<Record<string, ReadonlyArray<{ readonly name: string, readonly version: string, readonly architecture: string }>>>>>
}

/** The pinned toolchain parts each closure carries, and the builder image packages that compiled its native code. */
export interface ToolchainParts {
  readonly node: { readonly version: string, readonly origin: string }
  readonly pnpm: { readonly version: string, readonly integrity: string }
  /**
   * The Debian packages `toolchain.json` pins in the native builder image, as `name=version`, and the platforms whose
   * archives hold native code that image compiled.
   */
  readonly builder: { readonly packages: readonly string[], readonly platforms: readonly string[] }
}

/** The Debian architecture of the builder image that compiles each Linux platform's native code. */
const BUILDER_ARCHITECTURES: Readonly<Record<string, string>> = { 'linux-x64': 'amd64', 'linux-arm64': 'arm64' }

/**
 * Whether an archive entry path is an installed package's manifest: `node_modules/<name>/package.json` or
 * `node_modules/@<scope>/<name>/package.json` at any depth.
 * @param path - the entry path.
 * @returns true for a package manifest.
 */
export function isPackageManifest(path: string): boolean {
  return /(^|\/)node_modules\/(@[^/]+\/)?[^/@][^/]*\/package\.json$/u.test(path)
}

/**
 * An SPDX id that no other kind, name and version maps to: the kind and the first 128 bits of the SHA-256 of
 * `<kind> <name>@<version>`, since SPDX ids allow only letters, digits, `.` and `-`, and replacing a package name's
 * other characters makes distinct names collide.
 * @param kind - the package kind.
 * @param name - the package name.
 * @param version - the version.
 * @returns the id.
 */
function spdxId(kind: string, name: string, version: string): string {
  return `SPDXRef-${kind}-${createHash('sha256').update(`${kind} ${name}@${version}`).digest('hex').slice(0, 32)}`
}

/**
 * Add a package under its id, refusing an id that another package already holds.
 * @param packages - the document's packages by id.
 * @param id - the id.
 * @param entry - the package.
 * @throws Error when the id names a package with another name or version.
 */
function addPackage(packages: Map<string, Record<string, unknown>>, id: string, entry: Record<string, unknown>): void {
  const held = packages.get(id)
  if (held !== undefined && (held.name !== entry.name || held.versionInfo !== entry.versionInfo)) {
    throw new Error(`SPDX id ${id} names both ${String(held.name)}@${String(held.versionInfo)} and ${String(entry.name)}@${String(entry.versionInfo)}`)
  }
  if (held === undefined) packages.set(id, entry)
}

function purl(name: string, version: string): string {
  const encoded = name.startsWith('@') ? `%40${name.slice(1)}` : name
  return `pkg:npm/${encoded}@${version}`
}

function integrities(lockfile: string): Map<string, string> {
  const lock = parseYaml(lockfile) as { packages?: Record<string, { resolution?: { integrity?: unknown } }> }
  const map = new Map<string, string>()
  for (const [key, value] of Object.entries(lock.packages ?? {})) {
    if (typeof value.resolution?.integrity === 'string') map.set(key, value.resolution.integrity)
  }
  return map
}

function license(value: string | undefined): string {
  return value !== undefined && /^\(?[A-Za-z0-9.+-]+(?: (?:AND|OR|WITH) \(?[A-Za-z0-9.+-]+\)?)*\)?$/u.test(value) ? value : 'NOASSERTION'
}

/**
 * The SBOM document.
 * @param version - the release.
 * @param epoch - the release's `SOURCE_DATE_EPOCH`.
 * @param toolchain - the pinned Node and pnpm, and the native builder's packages.
 * @param archives - each archive's contents.
 * @param images - the S2 and S3 images, when the build output holds them.
 * @returns the SPDX document, ready for `JSON.stringify`.
 */
export function spdxDocument(version: string, epoch: number, toolchain: ToolchainParts, archives: readonly ArchiveContents[], images?: ImageContents): Record<string, unknown> {
  const packages = new Map<string, Record<string, unknown>>()
  const relationships: Array<{ spdxElementId: string, relationshipType: string, relatedSpdxElement: string }> = []
  const node = spdxId('generic', 'node', toolchain.node.version)
  const pnpm = spdxId('npm', 'pnpm', toolchain.pnpm.version)
  packages.set(node, { SPDXID: node, name: 'node', versionInfo: toolchain.node.version, downloadLocation: toolchain.node.origin, filesAnalyzed: false, licenseConcluded: 'NOASSERTION', licenseDeclared: 'MIT', copyrightText: 'NOASSERTION', externalRefs: [{ referenceCategory: 'PACKAGE-MANAGER', referenceType: 'purl', referenceLocator: `pkg:generic/node@${toolchain.node.version}` }] })
  packages.set(pnpm, { SPDXID: pnpm, name: 'pnpm', versionInfo: toolchain.pnpm.version, downloadLocation: `https://registry.npmjs.org/pnpm/-/pnpm-${toolchain.pnpm.version}.tgz`, filesAnalyzed: false, licenseConcluded: 'NOASSERTION', licenseDeclared: 'MIT', copyrightText: 'NOASSERTION', checksums: [{ algorithm: 'SHA512', checksumValue: Buffer.from(toolchain.pnpm.integrity.slice(7), 'base64').toString('hex') }], externalRefs: [{ referenceCategory: 'PACKAGE-MANAGER', referenceType: 'purl', referenceLocator: purl('pnpm', toolchain.pnpm.version) }] })
  for (const archive of archives) {
    const archiveId = spdxId('archive', archive.platform, version)
    packages.set(archiveId, { SPDXID: archiveId, name: archive.name, versionInfo: version, downloadLocation: `${RELEASE_REPOSITORY_URL}/releases/download/v${version}/${archive.name}`, filesAnalyzed: false, primaryPackagePurpose: 'ARCHIVE', licenseConcluded: 'NOASSERTION', licenseDeclared: 'NOASSERTION', copyrightText: 'NOASSERTION', checksums: [{ algorithm: 'SHA256', checksumValue: archive.sha256 }] })
    relationships.push({ spdxElementId: 'SPDXRef-DOCUMENT', relationshipType: 'DESCRIBES', relatedSpdxElement: archiveId })
    relationships.push({ spdxElementId: archiveId, relationshipType: 'CONTAINS', relatedSpdxElement: node }, { spdxElementId: archiveId, relationshipType: 'CONTAINS', relatedSpdxElement: pnpm })
    const architecture = BUILDER_ARCHITECTURES[archive.platform]
    if (architecture !== undefined && toolchain.builder.platforms.includes(archive.platform)) {
      for (const pin of toolchain.builder.packages) {
        const [name, debVersion] = [pin.slice(0, pin.indexOf('=')), pin.slice(pin.indexOf('=') + 1)]
        const debId = spdxId('deb', `${name}:${architecture}`, debVersion)
        addPackage(packages, debId, { SPDXID: debId, name, versionInfo: debVersion, downloadLocation: 'NOASSERTION', filesAnalyzed: false, licenseConcluded: 'NOASSERTION', licenseDeclared: 'NOASSERTION', copyrightText: 'NOASSERTION', externalRefs: [{ referenceCategory: 'PACKAGE-MANAGER', referenceType: 'purl', referenceLocator: `pkg:deb/debian/${encodeURIComponent(name)}@${encodeURIComponent(debVersion)}?arch=${architecture}` }] })
        relationships.push({ spdxElementId: debId, relationshipType: 'BUILD_TOOL_OF', relatedSpdxElement: archiveId })
      }
    }
    const locked = integrities(archive.lockfile)
    for (const entry of archive.packages) {
      const id = spdxId('npm', entry.name, entry.version)
      const integrity = locked.get(`${entry.name}@${entry.version}`)
      addPackage(packages, id, {
          SPDXID: id,
          name: entry.name,
          versionInfo: entry.version,
          downloadLocation: integrity === undefined ? 'NOASSERTION' : `https://registry.npmjs.org/${entry.name}/-/${entry.name.split('/').at(-1)!}-${entry.version}.tgz`,
          filesAnalyzed: false,
          licenseConcluded: 'NOASSERTION',
          licenseDeclared: license(entry.license),
          copyrightText: 'NOASSERTION',
          ...(integrity?.startsWith('sha512-') === true ? { checksums: [{ algorithm: 'SHA512', checksumValue: Buffer.from(integrity.slice(7), 'base64').toString('hex') }] } : {}),
          externalRefs: [{ referenceCategory: 'PACKAGE-MANAGER', referenceType: 'purl', referenceLocator: purl(entry.name, entry.version) }],
      })
      relationships.push({ spdxElementId: archiveId, relationshipType: 'CONTAINS', relatedSpdxElement: id })
    }
  }
  if (images !== undefined) {
    const [baseName, baseDigest] = images.base.split('@') as [string, string]
    const baseId = spdxId('oci', 'debian-bookworm-slim', baseDigest.slice('sha256:'.length, 'sha256:'.length + 12))
    packages.set(baseId, { SPDXID: baseId, name: baseName, versionInfo: baseDigest, downloadLocation: `https://${baseName.split(':')[0]!}`, filesAnalyzed: false, licenseConcluded: 'NOASSERTION', licenseDeclared: 'NOASSERTION', copyrightText: 'NOASSERTION', checksums: [{ algorithm: 'SHA256', checksumValue: baseDigest.slice('sha256:'.length) }] })
    for (const [name, image] of Object.entries(images.images)) {
      const id = spdxId('image', name, version)
      const repository = image.repository.slice(image.repository.lastIndexOf('/') + 1)
      packages.set(id, { SPDXID: id, name: image.repository, versionInfo: image.index, downloadLocation: `https://${image.repository}`, filesAnalyzed: false, primaryPackagePurpose: 'CONTAINER', licenseConcluded: 'NOASSERTION', licenseDeclared: 'NOASSERTION', copyrightText: 'NOASSERTION', checksums: [{ algorithm: 'SHA256', checksumValue: image.index.slice('sha256:'.length) }], externalRefs: [{ referenceCategory: 'PACKAGE-MANAGER', referenceType: 'purl', referenceLocator: `pkg:oci/${repository}@${encodeURIComponent(image.index)}?repository_url=${encodeURIComponent(image.repository.slice(0, image.repository.lastIndexOf('/')))}` }] })
      relationships.push({ spdxElementId: 'SPDXRef-DOCUMENT', relationshipType: 'DESCRIBES', relatedSpdxElement: id }, { spdxElementId: id, relationshipType: 'DESCENDANT_OF', relatedSpdxElement: baseId })
      for (const installed of Object.values(images.debian[name as 's2' | 's3'])) {
        for (const deb of installed) {
          const debId = spdxId('deb', `${deb.name}:${deb.architecture}`, deb.version)
          addPackage(packages, debId, { SPDXID: debId, name: deb.name, versionInfo: deb.version, downloadLocation: 'NOASSERTION', filesAnalyzed: false, licenseConcluded: 'NOASSERTION', licenseDeclared: 'NOASSERTION', copyrightText: 'NOASSERTION', externalRefs: [{ referenceCategory: 'PACKAGE-MANAGER', referenceType: 'purl', referenceLocator: `pkg:deb/debian/${encodeURIComponent(deb.name)}@${encodeURIComponent(deb.version)}?arch=${encodeURIComponent(deb.architecture)}` }] })
          relationships.push({ spdxElementId: id, relationshipType: 'CONTAINS', relatedSpdxElement: debId })
        }
      }
      if (name === 's3') {
        for (const archive of archives.filter(item => item.platform === 'linux-x64' || item.platform === 'linux-arm64')) relationships.push({ spdxElementId: id, relationshipType: 'CONTAINS', relatedSpdxElement: spdxId('archive', archive.platform, version) })
      }
    }
  }
  const unique = [...new Map(relationships.map(item => [`${item.spdxElementId} ${item.relationshipType} ${item.relatedSpdxElement}`, item])).values()]
  return {
    spdxVersion: 'SPDX-2.3',
    dataLicense: 'CC0-1.0',
    SPDXID: 'SPDXRef-DOCUMENT',
    name: `delorun-${version}`,
    documentNamespace: `${RELEASE_REPOSITORY_URL}/releases/download/v${version}/delorun-${version}.spdx.json`,
    creationInfo: { created: `${new Date(epoch * 1000).toISOString().slice(0, 19)}Z`, creators: ['Organization: Delorun', 'Tool: @delorun/release'] },
    packages: [...packages.keys()].sort().map(id => packages.get(id)!),
    relationships: unique.sort((a, b) => `${a.spdxElementId} ${a.relationshipType} ${a.relatedSpdxElement}`.localeCompare(`${b.spdxElementId} ${b.relationshipType} ${b.relatedSpdxElement}`, 'en')),
  }
}
