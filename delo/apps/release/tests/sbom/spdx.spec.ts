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

const TOOLCHAIN = { node: { version: '24.22.0', origin: 'https://nodejs.org/dist/v24.22.0' }, pnpm: { version: '11.28.5', integrity: `sha512-${'B'.repeat(86)}==` }, builder: { packages: ['gcc-12=12.2.0-14+deb12u1'], platforms: ['linux-x64'] } }

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
    const archiveId = document.packages.find(item => item.name === ARCHIVE.name)!.SPDXID as string
    expect(archiveId).toMatch(/^SPDXRef-archive-[0-9a-f]{32}$/u)
    expect(document.relationships).toContainEqual({ spdxElementId: 'SPDXRef-DOCUMENT', relationshipType: 'DESCRIBES', relatedSpdxElement: archiveId })
  })

  it('names the native builder\'s pinned packages as build tools of each archive whose native code they compiled', () => {
    const arm = { ...ARCHIVE, platform: 'linux-arm64' as const, name: 'delorun-0.1.0-linux-arm64.tar.gz' }
    const windows = { ...ARCHIVE, platform: 'win32-x64' as const, name: 'delorun-0.1.0-win32-x64.zip' }
    const document = spdxDocument('0.1.0', 1_793_981_656, { ...TOOLCHAIN, builder: { ...TOOLCHAIN.builder, platforms: ['linux-x64', 'win32-x64'] } }, [ARCHIVE, arm, windows]) as { packages: Array<Record<string, unknown>>, relationships: Array<Record<string, string>> }
    const gcc = document.packages.filter(item => item.name === 'gcc-12')
    expect(gcc).toHaveLength(1)
    expect(gcc[0]).toMatchObject({ versionInfo: '12.2.0-14+deb12u1', externalRefs: [{ referenceCategory: 'PACKAGE-MANAGER', referenceType: 'purl', referenceLocator: 'pkg:deb/debian/gcc-12@12.2.0-14%2Bdeb12u1?arch=amd64' }] })
    const archiveId = (name: string): string => document.packages.find(item => item.name === name)!.SPDXID as string
    const builds = document.relationships.filter(item => item.relationshipType === 'BUILD_TOOL_OF')
    expect(builds).toEqual([{ spdxElementId: gcc[0]!.SPDXID, relationshipType: 'BUILD_TOOL_OF', relatedSpdxElement: archiveId(ARCHIVE.name) }])
  })

  it('keeps packages whose names differ only in characters an SPDX id cannot hold', () => {
    const names = ['@a-b/c', '@a/b-c', 'a_b', 'a-b', 'a.b']
    const archive = { ...ARCHIVE, packages: names.map(name => ({ name, version: '1.0.0' })) }
    const document = spdxDocument('0.1.0', 1_793_981_656, TOOLCHAIN, [archive]) as { packages: Array<{ name: string, SPDXID: string }> }
    const listed = document.packages.filter(item => names.includes(item.name))
    expect(listed.map(item => item.name).sort()).toEqual([...names].sort())
    expect(new Set(listed.map(item => item.SPDXID)).size).toBe(names.length)
  })

  it('recognises installed package manifests at any depth and nothing else', () => {
    expect(isPackageManifest('app/node_modules/zod/package.json')).toBe(true)
    expect(isPackageManifest('app/node_modules/@scope/parser/package.json')).toBe(true)
    expect(isPackageManifest('app/node_modules/a/node_modules/b/package.json')).toBe(true)
    expect(isPackageManifest('app/node_modules/zod/lib/package.json')).toBe(false)
    expect(isPackageManifest('app/package.json')).toBe(false)
  })
})
