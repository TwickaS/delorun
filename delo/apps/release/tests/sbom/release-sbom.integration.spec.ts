/**
 * The release SBOM written from a build output's archives: it lists the packages each archive installs, and the
 * rebuild comparison accepts a copy only when it equals the SBOM derived from the archives beside it.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, type TestContext } from 'vitest'
import { RUNTIME_PLATFORMS } from '@delo/contract-release-manifest'
import { archiveClosure } from '../../src/closure/archive-closure.ts'
import { readRecipe } from '../../src/closure/config.ts'
import { readImagesRecipe } from '../../src/images/build.ts'
import { compareOutputs } from '../../src/rebuild/compare.ts'
import { sbomName, writeReleaseSbom } from '../../src/sbom/release-sbom.ts'
import { scratch, writeTree } from '../support.ts'

const LOCKFILE = `lockfileVersion: '9.0'\n\npackages:\n\n  zod@4.4.3:\n    resolution: {integrity: sha512-${'C'.repeat(86)}==}\n`

async function output(test: TestContext): Promise<string> {
  const directory = scratch(test)
  const out = join(directory, 'out')
  mkdirSync(out)
  for (const platform of RUNTIME_PLATFORMS) {
    const stage = join(directory, `stage-${platform}`)
    writeTree(stage, { 'app/pnpm-lock.yaml': LOCKFILE, 'app/node_modules/zod/package.json': '{"name":"zod","version":"4.4.3","license":"MIT"}\n', 'app/node_modules/zod/index.js': '' })
    await archiveClosure({ stage, outDir: out, version: '0.1.0', platform, epoch: 1_793_981_656, pins: undefined })
  }
  await writeReleaseSbom(out, '0.1.0', readRecipe().toolchain, readImagesRecipe().base)
  return out
}

/** Each case builds every platform's fixture archive twice, which a loaded host slows. */
const ARCHIVE_TIMEOUT = { timeout: 60_000 }

describe('release SBOM', ARCHIVE_TIMEOUT, () => {
  it('lists every archive and the packages it installs, and two builds give the same file', async (test) => {
    const first = await output(test)
    const second = await output(test)
    const text = readFileSync(join(first, sbomName('0.1.0')), 'utf8')
    expect(text).toBe(readFileSync(join(second, sbomName('0.1.0')), 'utf8'))
    const document = JSON.parse(text) as { packages: Array<{ name: string }>, relationships: Array<{ relationshipType: string }> }
    expect(document.packages.map(item => item.name)).toEqual(expect.arrayContaining(['zod', 'node', 'pnpm', 'delorun-0.1.0-win32-x64.zip']))
    expect(document.relationships.filter(item => item.relationshipType === 'DESCRIBES')).toHaveLength(RUNTIME_PLATFORMS.length)
    const recipe = { ...readRecipe(), images: readImagesRecipe() }
    expect((await compareOutputs(first, second, recipe)).differences).toEqual([])
  })

  it('makes the rebuild comparison fail on an SBOM that its archives do not derive', async (test) => {
    const first = await output(test)
    const second = await output(test)
    const path = join(second, sbomName('0.1.0'))
    writeFileSync(path, readFileSync(path, 'utf8').replace('"MIT"', '"Apache-2.0"'))
    const comparison = await compareOutputs(first, second, { ...readRecipe(), images: readImagesRecipe() })
    expect(comparison.differences).toEqual([{ file: sbomName('0.1.0'), detail: 'second: it does not equal the SBOM derived from its archives' }])
  })
})
