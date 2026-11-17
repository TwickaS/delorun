/**
 * The release-log bundle of a packs file: the same five steps over the packs file's bytes, with a bundle that must name
 * `delorun-<version>.packs.json`. A log record of other bytes, or the manifest's own bundle, is refused.
 */
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { checkBundle, checkPacksBundle } from '../src/bundle.ts'
import { COSIGNED_AT, FixtureLog, FixtureWitness, MANIFEST, rootMetadata, scenario, throwawayKeys, VERSION } from './fixtures.ts'

/** A packs file's bytes as the release signs them, and a log that recorded them beside the manifest. */
function packsScenario() {
  const keys = throwawayKeys()
  const log = new FixtureLog()
  const witness = new FixtureWitness()
  const packs = Buffer.from(`${JSON.stringify({ signed: { schema: 'delorun.release-packs/1', version: VERSION, manifest: createHash('sha256').update(MANIFEST).digest('hex'), packs: [] }, signatures: [] })}\n`)
  log.append(Buffer.from('an earlier entry'))
  const manifestIndex = log.submit(MANIFEST, keys.targets)
  const packsIndex = log.submit(packs, keys.targets)
  const root = rootMetadata(keys, log, [witness])
  const note = witness.cosign(log.checkpoint(), COSIGNED_AT)
  const bundleFor = (index: number, name: string, bytes: Uint8Array) => log.bundle(index, name, createHash('sha256').update(bytes).digest('hex'), note)
  return { root, packs, manifestBundle: bundleFor(manifestIndex, `delorun-${VERSION}.manifest.json`, MANIFEST), packsBundle: bundleFor(packsIndex, `delorun-${VERSION}.packs.json`, packs) }
}

describe('the release-log bundle of a packs file', () => {
  it('verifies the recorded bundle of the packs file, and the manifest\'s bundle still verifies as before', () => {
    const fixture = packsScenario()
    expect(checkPacksBundle(fixture.root, VERSION, fixture.packs, Buffer.from(JSON.stringify(fixture.packsBundle)))).toMatchObject({ ok: true })
    expect(checkBundle(fixture.root, VERSION, MANIFEST, Buffer.from(JSON.stringify(fixture.manifestBundle)))).toMatchObject({ ok: true })
    expect(scenario()).toBeDefined()
  })

  it('refuses a log record of different bytes', () => {
    const fixture = packsScenario()
    const bytes = Buffer.from(JSON.stringify(fixture.packsBundle))
    expect(checkPacksBundle(fixture.root, VERSION, Buffer.from('another packs file'), bytes)).toMatchObject({ ok: false, refusal: 'manifest-digest-mismatch' })
    expect(checkPacksBundle(fixture.root, VERSION, MANIFEST, bytes)).toMatchObject({ ok: false, refusal: 'manifest-digest-mismatch' })
  })

  it('refuses the manifest\'s bundle for the packs file, and the packs bundle for the manifest', () => {
    const fixture = packsScenario()
    expect(checkPacksBundle(fixture.root, VERSION, fixture.packs, Buffer.from(JSON.stringify(fixture.manifestBundle)))).toMatchObject({ ok: false, refusal: 'manifest-digest-mismatch' })
    expect(checkBundle(fixture.root, VERSION, MANIFEST, Buffer.from(JSON.stringify(fixture.packsBundle)))).toMatchObject({ ok: false, refusal: 'manifest-digest-mismatch' })
  })
})
