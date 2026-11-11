/**
 * Failures that are not refusals propagate: a reader treats a record or a checkpoint it cannot read as none only when
 * the reason is a refusal of this package, so a defect or an exhausted resource is reported instead of read as an
 * absent record or an unsigned checkpoint. The readers' own parsers are replaced here by ones that fail that way.
 */
import { vi } from 'vitest'

const { failures } = vi.hoisted(() => ({ failures: { note: false, cosignature: false, checkpoint: false, state: false } }))

vi.mock('../src/note.ts', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/note.ts')>()
  return {
    ...original,
    parseCheckpoint: (body: string) => {
      if (failures.note) throw new TypeError('the note parser broke')
      return original.parseCheckpoint(body)
    },
    verifySignature: (...args: Parameters<typeof original.verifySignature>) => {
      if (failures.cosignature && args[0].type === original.NOTE_COSIGNATURE) throw new TypeError('the cosignature check broke')
      return original.verifySignature(...args)
    },
  }
})

vi.mock('../src/checkpoint.ts', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/checkpoint.ts')>()
  return {
    ...original,
    readStoredCheckpoint: (bytes: Uint8Array) => {
      if (failures.checkpoint) throw new RangeError('the checkpoint reader broke')
      return original.readStoredCheckpoint(bytes)
    },
  }
})

vi.mock('../src/state.ts', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/state.ts')>()
  return {
    ...original,
    readCheckState: (bytes: Uint8Array) => {
      if (failures.state) throw new RangeError('the state reader broke')
      return original.readCheckState(bytes)
    },
  }
})

const { mkdtempSync, rmSync } = await import('node:fs')
const { tmpdir } = await import('node:os')
const { join } = await import('node:path')
const { afterEach, describe, expect, it } = await import('vitest')
const { checkOnline, storedCheckpointSigned } = await import('../src/online.ts')
const { checkBundle } = await import('../src/bundle.ts')
const { checkAndRecord, readCheckpointRecord, readCheckRecords } = await import('../src/record.ts')
const { storedCheckpoint } = await import('../src/checkpoint.ts')
const { COSIGNED_AT, FixtureTransport, MANIFEST, scenario, VERSION } = await import('./fixtures.ts')

afterEach(() => {
  failures.note = false
  failures.cosignature = false
  failures.checkpoint = false
  failures.state = false
})

describe('a failure that is not a refusal', () => {
  it('rejects the online check and the stored record\'s signature check instead of reading as a verdict', async () => {
    const fixture = scenario()
    const stored = storedCheckpoint(fixture.log.origin, 3, fixture.log.rootHash, fixture.log.checkpoint(), COSIGNED_AT)
    const transport = new FixtureTransport()
    transport.note = fixture.witness.cosign(fixture.log.checkpoint(), COSIGNED_AT)
    const bundle = { treeSize: 3, rootHash: fixture.log.rootHash, cosigned: COSIGNED_AT, checkpoint: { origin: fixture.log.origin, size: 3, rootHash: fixture.log.rootHash, body: '' } }
    failures.note = true
    await expect(checkOnline({ root: fixture.root, bundle, stored: undefined, transport, now: COSIGNED_AT + 60 })).rejects.toThrow('the note parser broke')
    expect(() => storedCheckpointSigned(fixture.root, stored)).toThrow('the note parser broke')
    expect(() => checkBundle(fixture.root, VERSION, MANIFEST, Buffer.from(JSON.stringify(fixture.bundle)))).toThrow('the note parser broke')
    failures.note = false
    failures.cosignature = true
    await expect(checkOnline({ root: fixture.root, bundle, stored: undefined, transport, now: COSIGNED_AT + 60 })).rejects.toThrow('the cosignature check broke')
  })

  it('rejects reading the records instead of reading them as absent', async () => {
    const home = mkdtempSync(join(tmpdir(), 'release-verify-unexpected-'))
    try {
      const fixture = scenario()
      const transport = new FixtureTransport()
      transport.note = fixture.witness.cosign(fixture.log.checkpoint(), COSIGNED_AT)
      await checkAndRecord(home, { root: fixture.root, version: VERSION, manifest: MANIFEST, bundle: Buffer.from(JSON.stringify(fixture.bundle)), now: COSIGNED_AT + 60, transport, mode: 'warn', missingBundle: 'failed' })
      failures.checkpoint = true
      await expect(readCheckpointRecord(home)).rejects.toThrow('the checkpoint reader broke')
      failures.state = true
      await expect(readCheckRecords(home)).rejects.toThrow('the state reader broke')
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})
