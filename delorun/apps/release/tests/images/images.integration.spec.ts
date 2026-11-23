/**
 * Reading the S2 and S3 images' digests from their OCI layouts, the image recipe, the images' seccomp profiles, and
 * the SBOM's description of the images; Docker builds run in `images.docker.spec.ts`.
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { builderProblems, imageDebianPackages, imagesName, ociImageRef, readImagesRecipe, readReleaseImages, seccompLicenceName, writeSeccompProfiles } from '../../src/images/build.ts'
import { readRecipe } from '../../src/closure/config.ts'
import { compareOutputs } from '../../src/rebuild/compare.ts'
import { spdxDocument } from '../../src/sbom/spdx.ts'
import { scratch } from '../support.ts'

function blob(directory: string, value: object): string {
  const text = JSON.stringify(value)
  const hex = createHash('sha256').update(text).digest('hex')
  writeFileSync(join(directory, 'blobs', 'sha256', hex), text)
  return `sha256:${hex}`
}

describe('image digests', () => {
  it('reads the index digest and both platform manifests of an OCI layout', (test) => {
    const directory = scratch(test)
    mkdirSync(join(directory, 'layout', 'blobs', 'sha256'), { recursive: true })
    const layout = join(directory, 'layout')
    const amd64 = blob(layout, { schemaVersion: 2, arch: 'amd64' })
    const arm64 = blob(layout, { schemaVersion: 2, arch: 'arm64' })
    const index = blob(layout, { schemaVersion: 2, manifests: [{ digest: amd64, platform: { os: 'linux', architecture: 'amd64' } }, { digest: arm64, platform: { os: 'linux', architecture: 'arm64', variant: 'v8' } }] })
    writeFileSync(join(layout, 'index.json'), JSON.stringify({ schemaVersion: 2, manifests: [{ digest: index }] }))
    execFileSync('tar', ['-cf', join(directory, 'image.oci.tar'), '-C', layout, 'index.json', 'blobs'], { timeout: 30_000 })
    expect(ociImageRef(join(directory, 'image.oci.tar'), 'ghcr.io/twickas/delorun-workspace-s2')).toEqual({ repository: 'ghcr.io/twickas/delorun-workspace-s2', index, platforms: { 'linux/amd64': amd64, 'linux/arm64': arm64 } })
  })

  it('pins the Debian base by digest and names the repositories contract C9 lists', () => {
    const recipe = readImagesRecipe()
    expect(recipe.base).toMatch(/^docker\.io\/library\/debian:bookworm-slim@sha256:[0-9a-f]{64}$/u)
    expect(recipe.images.s2.repository).toBe('ghcr.io/twickas/delorun-workspace-s2')
    expect(recipe.images.s3.repository).toBe('ghcr.io/twickas/delorun-harness-s3')
  })

  it('copies each image\'s committed seccomp profile, Docker\'s default profile, and its licence into the output as release files', async (test) => {
    const out = scratch(test)
    const recipe = readImagesRecipe()
    for (const image of ['s2', 's3'] as const) expect(recipe.images[image].seccomp).toEqual({ profile: 'images/seccomp.json', licence: 'images/seccomp.LICENSE' })
    const profile = readFileSync(join(import.meta.dirname, '../../images/seccomp.json'))
    const licence = readFileSync(join(import.meta.dirname, '../../images/seccomp.LICENSE'))
    expect(licence.toString('utf8')).toContain('Apache License')
    expect(JSON.parse(profile.toString('utf8'))).toMatchObject({ defaultAction: 'SCMP_ACT_ERRNO' })
    const refs = await writeSeccompProfiles(recipe, out, '0.1.0')
    for (const image of ['s2', 's3'] as const) {
      expect(refs[image]).toEqual({ name: `delorun-0.1.0.${image}.seccomp.json`, length: profile.byteLength, sha256: createHash('sha256').update(profile).digest('hex') })
      expect(readFileSync(join(out, refs[image].name)).equals(profile)).toBe(true)
      expect(readFileSync(join(out, seccompLicenceName('0.1.0', image))).equals(licence)).toBe(true)
    }
    await expect(writeSeccompProfiles(recipe, out, '0.1.0')).rejects.toThrow(/EEXIST/u)
  })

  it('reads the images file\'s seccomp references and refuses one whose name is a path', async (test) => {
    const out = scratch(test)
    const digest = `sha256:${'d'.repeat(64)}`
    const seccomp = { name: 'delorun-0.1.0.s2.seccomp.json', length: 2, sha256: 'e'.repeat(64) }
    const image = { repository: 'ghcr.io/twickas/fixture', index: digest, platforms: { 'linux/amd64': digest, 'linux/arm64': digest } }
    expect(await readReleaseImages(out, '0.1.0')).toBeUndefined()
    writeFileSync(join(out, imagesName('0.1.0')), JSON.stringify({ s2: { ...image, seccomp }, s3: image, builder: {}, debian: {} }))
    expect((await readReleaseImages(out, '0.1.0'))?.s2.seccomp).toEqual(seccomp)
    writeFileSync(join(out, imagesName('0.1.0')), JSON.stringify({ s2: { ...image, seccomp: { ...seccomp, name: 'profiles/s2.json' } }, s3: image }))
    await expect(readReleaseImages(out, '0.1.0')).rejects.toThrow(/delorun-0\.1\.0\.images\.json: .*seccomp/u)
  })

  it('describes both images in the SBOM by index digest, descended from the base, with their Debian packages', () => {
    const index = `sha256:${'d'.repeat(64)}`
    const document = spdxDocument('0.1.0', 1_793_981_656, { node: { version: '24.22.0', origin: 'https://nodejs.org/dist/v24.22.0' }, pnpm: { version: '11.28.5', integrity: `sha512-${'B'.repeat(86)}==` }, builder: { packages: [], platforms: [] } }, [], {
      base: `docker.io/library/debian:bookworm-slim@sha256:${'e'.repeat(64)}`,
      images: { s2: { repository: 'ghcr.io/twickas/delorun-workspace-s2', index }, s3: { repository: 'ghcr.io/twickas/delorun-harness-s3', index } },
      debian: { s2: { 'linux/amd64': [{ name: 'base-files', version: '12.4+deb12u11', architecture: 'amd64' }], 'linux/arm64': [{ name: 'base-files', version: '12.4+deb12u11', architecture: 'arm64' }] }, s3: { 'linux/amd64': [{ name: 'base-files', version: '12.4+deb12u11', architecture: 'amd64' }], 'linux/arm64': [] } },
    }) as { packages: Array<{ name: string, versionInfo: string, externalRefs?: Array<{ referenceLocator: string }> }>, relationships: Array<{ relationshipType: string }> }
    expect(document.packages.find(item => item.name === 'ghcr.io/twickas/delorun-workspace-s2')?.versionInfo).toBe(index)
    expect(document.packages.filter(item => item.name === 'base-files').map(item => item.externalRefs?.[0]?.referenceLocator).sort()).toEqual(['pkg:deb/debian/base-files@12.4%2Bdeb12u11?arch=amd64', 'pkg:deb/debian/base-files@12.4%2Bdeb12u11?arch=arm64'])
    expect(document.relationships.filter(item => item.relationshipType === 'DESCENDANT_OF')).toHaveLength(2)
  })
})

describe('Debian packages of an image', () => {
  it('lists the installed packages of the topmost layer carrying a dpkg status', (test) => {
    const directory = scratch(test)
    const layout = join(directory, 'layout')
    mkdirSync(join(layout, 'blobs', 'sha256'), { recursive: true })
    const rootfs = join(directory, 'rootfs')
    mkdirSync(join(rootfs, 'var/lib/dpkg'), { recursive: true })
    writeFileSync(join(rootfs, 'var/lib/dpkg/status'), 'Package: base-files\nStatus: install ok installed\nArchitecture: amd64\nVersion: 12.4+deb12u11\n\nPackage: removed-tool\nStatus: deinstall ok config-files\nArchitecture: amd64\nVersion: 1.0\n\nPackage: bash\nStatus: install ok installed\nArchitecture: amd64\nVersion: 5.2.15-2+b8\n')
    execFileSync('tar', ['-czf', join(directory, 'layer.tgz'), '-C', rootfs, 'var'], { timeout: 30_000 })
    const layer = createHash('sha256').update(readFileSync(join(directory, 'layer.tgz'))).digest('hex')
    writeFileSync(join(layout, 'blobs', 'sha256', layer), readFileSync(join(directory, 'layer.tgz')))
    const empty = blob(layout, { note: 'not a tar layer' })
    const manifest = blob(layout, { schemaVersion: 2, layers: [{ digest: `sha256:${layer}`, mediaType: 'application/vnd.oci.image.layer.v1.tar+gzip' }] })
    writeFileSync(join(layout, 'index.json'), JSON.stringify({ schemaVersion: 2, manifests: [{ digest: empty }] }))
    execFileSync('tar', ['-cf', join(directory, 'image.oci.tar'), '-C', layout, 'index.json', 'blobs'], { timeout: 30_000 })
    expect(imageDebianPackages(join(directory, 'image.oci.tar'), manifest)).toEqual([
      { name: 'base-files', version: '12.4+deb12u11', architecture: 'amd64' },
      { name: 'bash', version: '5.2.15-2+b8', architecture: 'amd64' },
    ])
    const bare = blob(layout, { schemaVersion: 2, layers: [{ digest: `sha256:${layer}`, mediaType: 'application/vnd.oci.image.layer.v1.tar+zstd' }] })
    execFileSync('tar', ['-cf', join(directory, 'image.oci.tar'), '-C', layout, 'index.json', 'blobs'], { timeout: 30_000 })
    expect(() => imageDebianPackages(join(directory, 'image.oci.tar'), bare)).toThrow(/neither gzip nor plain tar/u)
  })
})

describe('image builder pin', () => {
  it('refuses a Docker Engine or BuildKit other than toolchain.json pins', () => {
    const pinned = readRecipe().toolchain.images
    expect(builderProblems(pinned, pinned)).toEqual([])
    expect(builderProblems(pinned, { docker: '28.0.0', buildkit: 'v0.20.0' })).toEqual([
      `Docker Engine 28.0.0 would build the images, but toolchain.json pins ${pinned.docker}`,
      `BuildKit v0.20.0 would build the images, but toolchain.json pins ${pinned.buildkit}`,
    ])
  })

  it('makes the rebuild comparison fail on images files that differ only in the builder that made them', async (test) => {
    const directory = scratch(test)
    const image = { repository: 'ghcr.io/twickas/fixture', index: `sha256:${'a'.repeat(64)}`, platforms: { 'linux/amd64': `sha256:${'b'.repeat(64)}`, 'linux/arm64': `sha256:${'c'.repeat(64)}` } }
    for (const [name, buildkit] of [['first', 'v0.34.0'], ['second', 'v0.35.0']] as const) {
      mkdirSync(join(directory, name))
      writeFileSync(join(directory, name, 'delorun-0.1.0.images.json'), `${JSON.stringify({ s2: image, s3: image, builder: { docker: '29.9.2', buildkit } }, undefined, 2)}\n`)
    }
    const comparison = await compareOutputs(join(directory, 'first'), join(directory, 'second'), { ...readRecipe(), images: readImagesRecipe() })
    expect(comparison.differences).toEqual([{ file: 'delorun-0.1.0.images.json', detail: expect.stringContaining('content differs') }])
  })
})
