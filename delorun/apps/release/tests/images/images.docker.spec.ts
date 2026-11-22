/**
 * Docker lane: the S2 and S3 images built twice from the same fixture closures have the same index and platform
 * digests and Debian package lists. It builds both architectures with BuildKit and needs Docker with emulation, so it runs only with
 * `DELORUN_DOCKER_SPECS=1`, which the check runner's Docker lane (`tests:docker`) sets once a Docker engine answers.
 */
import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { archiveClosure } from '../../src/closure/archive-closure.ts'
import { builderVersions, buildImages, imagesName, readImagesRecipe } from '../../src/images/build.ts'
import { scratch, writeTree } from '../support.ts'

const EPOCH = 1_793_981_656

describe.runIf(process.env.DELORUN_DOCKER_SPECS === '1')('S2 and S3 images', () => {
  it('build to the same digests twice, from the digest-pinned base', { timeout: 1_800_000 }, async (test) => {
    const digests: string[] = []
    for (const run of ['first', 'second']) {
      const directory = scratch(test, `delorun-images-${run}-`)
      const out = join(directory, 'out')
      mkdirSync(out)
      for (const platform of ['linux-x64', 'linux-arm64'] as const) {
        writeTree(join(directory, `stage-${platform}`), { 'app/package.json': '{"name":"fixture"}\n', 'node/bin/node': { data: `#!/bin/sh\n# ${platform}\n`, executable: true } })
        await archiveClosure({ stage: join(directory, `stage-${platform}`), outDir: out, version: '0.1.0', platform, epoch: EPOCH, pins: undefined })
      }
      await buildImages({ recipe: readImagesRecipe(), out, oci: directory, version: '0.1.0', epoch: EPOCH, builder: builderVersions() })
      digests.push(readFileSync(join(out, imagesName('0.1.0')), 'utf8'))
    }
    expect(digests[1]).toBe(digests[0])
    const file = JSON.parse(digests[0]!) as { debian: Record<'s2' | 's3', Record<'linux/amd64' | 'linux/arm64', Array<{ name: string, architecture: string }>>> }
    expect(file).toMatchObject({ s2: { repository: 'ghcr.io/twickas/delorun-workspace-s2' }, s3: { repository: 'ghcr.io/twickas/delorun-harness-s3' } })
    expect(file.debian.s3['linux/arm64'].find(item => item.name === 'base-files')?.architecture).toBe('arm64')
    expect(file.debian.s2['linux/amd64'].find(item => item.name === 'base-files')?.architecture).toBe('amd64')
  })
})
