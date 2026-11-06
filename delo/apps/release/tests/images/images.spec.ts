/**
 * Reading the S2 and S3 images' digests from their OCI layouts, the image recipe, and the SBOM's description of the
 * images; Docker builds run in `images.docker.spec.ts`.
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ociImageRef, readImagesRecipe } from '../../src/images/build.ts'
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
    execFileSync('tar', ['-cf', join(directory, 'image.oci.tar'), '-C', layout, 'index.json', 'blobs'])
    expect(ociImageRef(join(directory, 'image.oci.tar'), 'ghcr.io/delo-run/delo-workspace-s2')).toEqual({ repository: 'ghcr.io/delo-run/delo-workspace-s2', index, platforms: { 'linux/amd64': amd64, 'linux/arm64': arm64 } })
  })

  it('pins the Debian base by digest and names the repositories contract C9 lists', () => {
    const recipe = readImagesRecipe()
    expect(recipe.base).toMatch(/^docker\.io\/library\/debian:bookworm-slim@sha256:[0-9a-f]{64}$/u)
    expect(recipe.images.s2.repository).toBe('ghcr.io/delo-run/delo-workspace-s2')
    expect(recipe.images.s3.repository).toBe('ghcr.io/delo-run/delo-harness-s3')
  })

  it('describes both images in the SBOM by index digest, descended from the base', () => {
    const index = `sha256:${'d'.repeat(64)}`
    const document = spdxDocument('0.1.0', 1_793_981_656, { node: { version: '24.22.0', origin: 'https://nodejs.org/dist/v24.22.0' }, pnpm: { version: '11.28.5', integrity: `sha512-${'B'.repeat(86)}==` } }, [], {
      base: `docker.io/library/debian:bookworm-slim@sha256:${'e'.repeat(64)}`,
      images: { s2: { repository: 'ghcr.io/delo-run/delo-workspace-s2', index }, s3: { repository: 'ghcr.io/delo-run/delo-harness-s3', index } },
    }) as { packages: Array<{ name: string, versionInfo: string }>, relationships: Array<{ relationshipType: string }> }
    expect(document.packages.find(item => item.name === 'ghcr.io/delo-run/delo-workspace-s2')?.versionInfo).toBe(index)
    expect(document.relationships.filter(item => item.relationshipType === 'DESCENDANT_OF')).toHaveLength(2)
  })
})
