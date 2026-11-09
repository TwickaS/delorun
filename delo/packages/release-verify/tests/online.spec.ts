/**
 * The online half of contract C18's check (`Consistency with the current log`): the latest checkpoint from the
 * distributor carries the log's signature and the root's threshold of listed cosignatures, is no older than 24 hours,
 * and is consistent with the tree the client holds. An unreachable distributor or log leaves the release `unchecked`,
 * which is not a failure; a signature, a cosignature, a rollback or a proof that does not verify is a failure. Every
 * answer comes from this suite's transport stand-in, so no spec reaches the network.
 */
import { describe, expect, it } from 'vitest'
import { MAX_PROOF_HASHES, MAX_WITNESSED_CHECKPOINT_AGE_SECONDS } from '@delo/contract-release-log'
import { storedCheckpoint, type StoredCheckpoint } from '../src/checkpoint.ts'
import type { VerifiedBundle } from '../src/bundle.ts'
import { checkOnline, LogUnreachableError, type OnlineVerdict } from '../src/online.ts'
import { consistencyProof, COSIGNED_AT, FixtureTransport, NOTE_SIGNATURE, scenario, signatureLine, treeRoot, type Scenario } from './fixtures.ts'

/** The client's clock, a minute after the fixture checkpoint's cosignature. */
const NOW = COSIGNED_AT + 60

/**
 * What already verified offline, as the fixtures' bundle says it.
 * @param fixture - the fixture.
 * @returns the verified bundle the online check starts from.
 */
function verified(fixture: Scenario): VerifiedBundle {
  return {
    treeSize: fixture.bundle.inclusion.treeSize,
    rootHash: Buffer.from(fixture.bundle.inclusion.rootHash, 'hex'),
    cosigned: COSIGNED_AT,
    checkpoint: { origin: fixture.log.origin, size: fixture.bundle.inclusion.treeSize, rootHash: Buffer.from(fixture.bundle.inclusion.rootHash, 'hex'), body: '' },
  }
}

/**
 * Run the online check, with the answers a case prepares.
 * @param fixture - the fixture.
 * @param prepare - how the transport answers.
 * @param stored - the checkpoint the client holds.
 * @param now - the client's clock.
 * @returns the verdict.
 */
async function online(fixture: Scenario, prepare: (transport: FixtureTransport) => void, stored: StoredCheckpoint | undefined = undefined, now: number = NOW): Promise<OnlineVerdict> {
  const transport = new FixtureTransport()
  prepare(transport)
  return checkOnline({ root: fixture.root, bundle: verified(fixture), stored, transport, now })
}

describe('the online check that passes', () => {
  it('verifies the latest checkpoint against the tree the bundle verified and returns it to store', async () => {
    const fixture = scenario()
    const verdict = await online(fixture, (transport) => { transport.note = fixture.witness.cosign(fixture.log.checkpoint(), COSIGNED_AT) })
    expect(verdict.ok).toBe(true)
    if (!verdict.ok) return
    expect(verdict.checkpoint.treeSize).toBe(fixture.log.size)
    expect(verdict.checkpoint.rootHash).toBe(fixture.log.rootHash.toString('hex'))
    expect(verdict.checkpoint.origin).toBe(fixture.log.origin)
    expect(verdict.checkpoint.verifiedAt).toBe(NOW)
  })

  it('proves consistency from the tree the client stored to the larger tree the log serves', async () => {
    const fixture = scenario()
    fixture.log.append(Buffer.from('a later entry'))
    fixture.log.append(Buffer.from('a yet later entry'))
    const stored = storedCheckpoint(fixture.log.origin, 3, Buffer.from(fixture.bundle.inclusion.rootHash, 'hex'), 'a stored note', COSIGNED_AT)
    const transport = new FixtureTransport()
    transport.note = fixture.witness.cosign(fixture.log.checkpoint(), COSIGNED_AT)
    transport.proof = consistencyProof(3, fixture.log.leafHashes).map(hash => hash.toString('hex'))
    const verdict = await checkOnline({ root: fixture.root, bundle: verified(fixture), stored, transport, now: NOW })
    expect(verdict.ok).toBe(true)
    expect(transport.asked).toEqual([{ first: 3, second: 5 }])
    if (!verdict.ok) return
    expect(verdict.checkpoint.treeSize).toBe(5)
  })
})

describe('a log that cannot be reached is not a failure', () => {
  it('reports an unreachable distributor with the reason a warning names', async () => {
    const fixture = scenario()
    const verdict = await online(fixture, (transport) => { transport.distributorFailure = new LogUnreachableError('the distributor answered 503') })
    expect(verdict.ok).toBe(false)
    if (verdict.ok || verdict.kind !== 'unreachable') throw new Error('the verdict is not unreachable')
    expect(verdict.detail).toContain('503')
  })

  it('reports an unreachable log when the consistency proof cannot be fetched', async () => {
    const fixture = scenario()
    const verdict = await online(fixture, (transport) => {
      transport.note = fixture.witness.cosign(fixture.log.checkpoint(), COSIGNED_AT)
      transport.logFailure = new LogUnreachableError('the log timed out')
    })
    expect(verdict).toMatchObject({ ok: false, kind: 'unreachable' })
  })

  it('reports a checkpoint whose newest cosignature is over 24 hours old as stale', async () => {
    const fixture = scenario()
    const verdict = await online(fixture, (transport) => { transport.note = fixture.witness.cosign(fixture.log.checkpoint(), COSIGNED_AT) }, undefined, COSIGNED_AT + MAX_WITNESSED_CHECKPOINT_AGE_SECONDS + 1)
    expect(verdict).toMatchObject({ ok: false, kind: 'stale' })
  })
})

describe('the latest checkpoint the distributor serves', () => {
  it('refuses one of another log origin', async () => {
    const fixture = scenario()
    const verdict = await online(fixture, (transport) => {
      const note = fixture.log.checkpoint().replace(fixture.log.origin, 'log.example.test/another')
      transport.note = fixture.witness.cosign(note, COSIGNED_AT)
    })
    expect(verdict).toMatchObject({ ok: false, kind: 'failed', refusal: 'log-origin-untrusted' })
  })

  it('refuses one without the log\'s signature', async () => {
    const fixture = scenario()
    const verdict = await online(fixture, (transport) => {
      const body = `${fixture.log.origin}\n${String(fixture.log.size)}\n${fixture.log.rootHash.toString('base64')}\n`
      transport.note = fixture.witness.cosign(`${body}\n`, COSIGNED_AT)
    })
    expect(verdict).toMatchObject({ ok: false, kind: 'failed', refusal: 'log-signature-invalid' })
  })

  it('refuses one without the root\'s threshold of witness cosignatures', async () => {
    const fixture = scenario()
    const verdict = await online(fixture, (transport) => { transport.note = fixture.log.checkpoint() })
    expect(verdict).toMatchObject({ ok: false, kind: 'failed', refusal: 'witness-cosignature-missing' })
  })

  it('requires one cosignature whatever threshold the root carries, instead of reading an infinitely old checkpoint', async () => {
    const fixture = scenario()
    const root = { ...fixture.root, witnesses: { ...fixture.root.witnesses, threshold: 0 } }
    const transport = new FixtureTransport()
    transport.note = fixture.log.checkpoint()
    // A threshold of 0 would satisfy `0 < 0`, and the newest cosigning time of no cosignature is `-Infinity`, which
    // the age check below would read as stale rather than as the missing cosignature it is.
    const verdict = await checkOnline({ root, bundle: verified(fixture), stored: undefined, transport, now: NOW })
    expect(verdict).toMatchObject({ ok: false, kind: 'failed', refusal: 'witness-cosignature-missing' })
  })

  it('refuses one that is not a signed note', async () => {
    const fixture = scenario()
    const verdict = await online(fixture, (transport) => { transport.note = 'not a signed note' })
    expect(verdict).toMatchObject({ ok: false, kind: 'failed', refusal: 'checkpoint-malformed' })
  })
})

describe('consistency with the tree the client holds', () => {
  it('c18-checkpoint-rollback-refused: refuses a latest checkpoint smaller than the stored one', async () => {
    const fixture = scenario()
    const stored = storedCheckpoint(fixture.log.origin, 9, Buffer.alloc(32, 3), 'a stored note', COSIGNED_AT)
    const verdict = await online(fixture, (transport) => { transport.note = fixture.witness.cosign(fixture.log.checkpoint(), COSIGNED_AT) }, stored)
    expect(verdict).toMatchObject({ ok: false, kind: 'failed', refusal: 'checkpoint-rolled-back' })
  })

  it('c18-inconsistent-log-fails-start: refuses a proof that the stored tree is not a prefix of the log\'s', async () => {
    const fixture = scenario()
    const stored = storedCheckpoint(fixture.log.origin, 2, treeRoot([Buffer.alloc(32, 5), Buffer.alloc(32, 6)]), 'a stored note', COSIGNED_AT)
    const verdict = await online(fixture, (transport) => {
      transport.note = fixture.witness.cosign(fixture.log.checkpoint(), COSIGNED_AT)
      transport.proof = consistencyProof(2, [Buffer.alloc(32, 5), Buffer.alloc(32, 6), Buffer.alloc(32, 8)]).map(hash => hash.toString('hex'))
    }, stored)
    expect(verdict).toMatchObject({ ok: false, kind: 'failed', refusal: 'consistency-proof-invalid' })
  })

  it('refuses a proof with more hashes than the limit, before verifying it', async () => {
    const fixture = scenario()
    const verdict = await online(fixture, (transport) => {
      transport.note = fixture.witness.cosign(fixture.log.checkpoint(), COSIGNED_AT)
      transport.proof = Array.from({ length: MAX_PROOF_HASHES + 1 }, () => '0'.repeat(64))
    })
    expect(verdict).toMatchObject({ ok: false, kind: 'failed', refusal: 'consistency-proof-invalid' })
  })

  it('refuses a tree of the stored size with another root hash', async () => {
    const fixture = scenario()
    const stored = storedCheckpoint(fixture.log.origin, fixture.bundle.inclusion.treeSize, Buffer.alloc(32, 4), 'a stored note', COSIGNED_AT)
    const verdict = await online(fixture, (transport) => { transport.note = fixture.witness.cosign(fixture.log.checkpoint(), COSIGNED_AT) }, stored)
    expect(verdict).toMatchObject({ ok: false, kind: 'failed', refusal: 'consistency-proof-invalid' })
  })

  it('proves from the bundle\'s verified tree, not from a stored record below it', async () => {
    const fixture = scenario()
    const stored = storedCheckpoint(fixture.log.origin, 1, fixture.log.leafHashes[0]!, 'a stored note', COSIGNED_AT)
    const transport = new FixtureTransport()
    transport.note = fixture.witness.cosign(fixture.log.checkpoint(), COSIGNED_AT)
    const verdict = await checkOnline({ root: fixture.root, bundle: verified(fixture), stored, transport, now: NOW })
    // The stored record lowers the floor, so the proof starts from the bundle's tree of 3, not the record's 1.
    expect(verdict.ok).toBe(true)
    expect(transport.asked).toEqual([{ first: 3, second: 3 }])
  })

  it('c18-checkpoint-rollback-refused: refuses a latest checkpoint below the bundle\'s tree, though the stored record is lower still', async () => {
    const fixture = scenario()
    const stored = storedCheckpoint(fixture.log.origin, 1, fixture.log.leafHashes[0]!, 'a stored note', COSIGNED_AT)
    // The log serves a two-leaf tree: above the stored record's 1, below the bundle's verified 3.
    const body = `${fixture.log.origin}\n2\n${treeRoot(fixture.log.leafHashes.slice(0, 2)).toString('base64')}\n`
    const note = `${body}\n${signatureLine(fixture.log.origin, NOTE_SIGNATURE, fixture.log.key, body)}`
    const transport = new FixtureTransport()
    transport.note = fixture.witness.cosign(note, COSIGNED_AT)
    transport.proof = consistencyProof(1, fixture.log.leafHashes.slice(0, 2)).map(hash => hash.toString('hex'))
    const verdict = await checkOnline({ root: fixture.root, bundle: verified(fixture), stored, transport, now: NOW })
    // Taking the record's 1 as the floor would let the proof from 1 to 2 verify and the record move backwards from 3.
    expect(verdict).toMatchObject({ ok: false, kind: 'failed', refusal: 'checkpoint-rolled-back' })
    expect(transport.asked).toEqual([])
  })
})
