/**
 * The release SBOM: an SPDX 2.3 document that describes each runtime archive by its SHA-256, the pinned Node and
 * pnpm, and every installed npm package with its purl and locked integrity; the same inputs give the same bytes.
 */
import { describe, expect, it } from 'vitest'
import { isPackageManifest, spdxDocument, type ArchiveContents } from '../../src/sbom/spdx.ts'

const LOCKFILE = `lockfileVersion: '9.0'

packages:

  '@scope/parser@1.2.3':
    resolution: {integrity: sha512-${'A'.repeat(86)}==}
`

const ARCHIVE: ArchiveContents = {
  platform: 'linux-x64',
  name: 'delorun-0.1.0-linux-x64.tar.gz',
  sha256: 'a'.repeat(64),
  packages: [{ name: '@scope/parser', version: '1.2.3', license: 'MIT' }, { name: 'local-only', version: '0.0.1', license: 'SEE LICENSE IN LICENSE.md' }],
  lockfile: LOCKFILE,
}

const TOOLCHAIN = { node: { version: '24.22.0', origin: 'https://nodejs.org/dist/v24.22.0' }, pnpm: { version: '11.28.5', integrity: `sha512-${'B'.repeat(86)}==` } }

describe('spdxDocument', () => {
  it('describes each archive, the toolchain and every package, deterministically', () => {
    const first = JSON.stringify(spdxDocument('0.1.0', 1_793_981_656, TOOLCHAIN, [ARCHIVE]))
    const second = JSON.stringify(spdxDocument('0.1.0', 1_793_981_656, TOOLCHAIN, [ARCHIVE]))
    expect(first).toBe(second)
    const document = JSON.parse(first) as { spdxVersion: string, creationInfo: { created: string }, packages: Array<Record<string, unknown>>, relationships: Array<Record<string, string>> }
    expect(document.spdxVersion).toBe('SPDX-2.3')
    expect(document.creationInfo.created).toBe('2026-11-06T16:14:16Z')
    const parser = document.packages.find(item => item.name === '@scope/parser')!
    expect(parser.externalRefs).toEqual([{ referenceCategory: 'PACKAGE-MANAGER', referenceType: 'purl', referenceLocator: 'pkg:npm/%40scope/parser@1.2.3' }])
    expect(parser.checksums).toEqual([{ algorithm: 'SHA512', checksumValue: Buffer.from('A'.repeat(86) + '==', 'base64').toString('hex') }])
    expect(document.packages.find(item => item.name === 'local-only')).toMatchObject({ downloadLocation: 'NOASSERTION', licenseDeclared: 'NOASSERTION' })
    expect(document.packages.find(item => item.name === ARCHIVE.name)).toMatchObject({ checksums: [{ algorithm: 'SHA256', checksumValue: 'a'.repeat(64) }] })
    expect(document.relationships).toContainEqual({ spdxElementId: 'SPDXRef-DOCUMENT', relationshipType: 'DESCRIBES', relatedSpdxElement: 'SPDXRef-archive-linux-x64-0.1.0' })
  })

  it('recognises installed package manifests at any depth and nothing else', () => {
    expect(isPackageManifest('app/node_modules/zod/package.json')).toBe(true)
    expect(isPackageManifest('app/node_modules/@scope/parser/package.json')).toBe(true)
    expect(isPackageManifest('app/node_modules/a/node_modules/b/package.json')).toBe(true)
    expect(isPackageManifest('app/node_modules/zod/lib/package.json')).toBe(false)
    expect(isPackageManifest('app/package.json')).toBe(false)
  })
})
