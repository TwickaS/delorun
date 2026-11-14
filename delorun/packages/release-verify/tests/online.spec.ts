/**
 * The online half of contract C18's check (`Consistency with the current log`): the latest checkpoint from the
 * distributor carries the log's signature and the root's threshold of listed cosignatures, is no older than 24 hours,
 * and is consistent with the tree the client holds. An unreachable distributor or log leaves the release `unchecked`,
 * which is not a failure; a signature, a cosignature, a rollback or a proof that does not verify is a failure. Every
 * answer comes from this suite's transport stand-in, so no spec reaches the network.
 */
import { describe, expect, it } from 'vitest'
import { MAX_PROOF_HASHES, MAX_WITNESSED_CHECKPOINT_AGE_SECONDS } from '@delorun/contract-release-log'
import { storedCheckpoint, type StoredCheckpoint } from '../src/checkpoint.ts'
import type { VerifiedBundle } from '../src/bundle.ts'
import { ReleaseLogRefusalError } from '../src/errors.ts'
import { checkOnline, COSIGNATURE_CLOCK_SKEW_SECONDS, LogContradictionError, LogUnreachableError, ReleaseLogInternalError, storedCheckpointSigned, type OnlineVerdict } from '../src/online.ts'
import { consistencyProof, COSIGNED_AT, FixtureTransport, NOTE_SIGNATURE, scenario, signatureLine, treeRoot, verifierKey, type Scenario } from './fixtures.ts'

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
 * A stored record of a checkpoint the fixture log's key signed, as the client stores one after the online check.
 * @param fixture - the fixture.
 * @param size - the tree size.
 * @param rootHash - the root hash; the root of the log's first `size` entries by default.
 * @returns the record.
 */
function signedStored(fixture: Scenario, size: number, rootHash?: Buffer): StoredCheckpoint {
  const root = rootHash ?? treeRoot(fixture.log.leafHashes.slice(0, size))
  return storedCheckpoint(fixture.log.origin, size, root, fixture.log.note(size, root), COSIGNED_AT)
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
    const stored = signedStored(fixture, 4)
    const transport = new FixtureTransport()
    transport.note = fixture.witness.cosign(fixture.log.checkpoint(), COSIGNED_AT)
    transport.proof = consistencyProof(4, fixture.log.leafHashes).map(hash => hash.toString('hex'))
    const verdict = await checkOnline({ root: fixture.root, bundle: verified(fixture), stored, transport, now: NOW })
    expect(verdict.ok).toBe(true)
    expect(transport.asked).toEqual([{ first: 4, second: 5 }])
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

  it('throws a failure of this client\'s own code as an internal failure, never as an unreachable log', async () => {
    const fixture = scenario()
    const transport = new FixtureTransport()
    transport.latestCheckpoint = () => Promise.reject(new TypeError('a defect'))
    await expect(checkOnline({ root: fixture.root, bundle: verified(fixture), stored: undefined, transport, now: NOW })).rejects.toBeInstanceOf(ReleaseLogInternalError)
    transport.latestCheckpoint = () => Promise.reject('down')
    await expect(checkOnline({ root: fixture.root, bundle: verified(fixture), stored: undefined, transport, now: NOW })).rejects.toThrow('the online check failed in this client: down')
    transport.note = fixture.witness.cosign(fixture.log.checkpoint(), COSIGNED_AT)
    transport.latestCheckpoint = FixtureTransport.prototype.latestCheckpoint
    transport.consistencyProof = () => Promise.reject(new RangeError('a defect in the proof'))
    await expect(checkOnline({ root: fixture.root, bundle: verified(fixture), stored: undefined, transport, now: NOW })).rejects.toBeInstanceOf(ReleaseLogInternalError)
  })

  it('stops at the check\'s deadline and leaves the release unchecked', async () => {
    const fixture = scenario()
    const transport = new FixtureTransport()
    const controller = new AbortController()
    transport.latestCheckpoint = () => new Promise<string>(() => { controller.abort() })
    const verdict = await checkOnline({ root: fixture.root, bundle: verified(fixture), stored: undefined, transport, now: NOW, signal: controller.signal })
    expect(verdict).toMatchObject({ ok: false, kind: 'unreachable' })
    if (!verdict.ok) expect(verdict.detail).toContain('passed its deadline of 90 seconds')
    // A deadline that already passed asks the log nothing.
    let asked = false
    transport.latestCheckpoint = () => { asked = true; return Promise.resolve('') }
    expect(await checkOnline({ root: fixture.root, bundle: verified(fixture), stored: undefined, transport, now: NOW, signal: controller.signal })).toMatchObject({ ok: false, kind: 'unreachable' })
    expect(asked).toBe(false)
  })

  it('reports a checkpoint whose newest cosignature is over 24 hours old as stale', async () => {
    const fixture = scenario()
    const verdict = await online(fixture, (transport) => { transport.note = fixture.witness.cosign(fixture.log.checkpoint(), COSIGNED_AT) }, undefined, COSIGNED_AT + MAX_WITNESSED_CHECKPOINT_AGE_SECONDS + 1)
    expect(verdict).toMatchObject({ ok: false, kind: 'stale' })
  })
})

describe('the latest checkpoint the distributor serves', () => {
  it('leaves the release unchecked for a checkpoint of another log origin, which no signed data of this log backs', async () => {
    const fixture = scenario()
    const verdict = await online(fixture, (transport) => {
      const note = fixture.log.checkpoint().replace(fixture.log.origin, 'log.example.test/another')
      transport.note = fixture.witness.cosign(note, COSIGNED_AT)
    })
    expect(verdict).toMatchObject({ ok: false, kind: 'unreachable' })
    if (!verdict.ok) expect(verdict.detail).toContain('not of the trusted root\'s log')
  })

  it('leaves the release unchecked for a checkpoint without the log\'s signature, as for any answer before signed data', async () => {
    const fixture = scenario()
    const verdict = await online(fixture, (transport) => {
      const body = `${fixture.log.origin}\n${String(fixture.log.size)}\n${fixture.log.rootHash.toString('base64')}\n`
      transport.note = fixture.witness.cosign(`${body}\n`, COSIGNED_AT)
    })
    expect(verdict).toMatchObject({ ok: false, kind: 'unreachable', detail: 'the log\'s answer carries no valid signature from the trusted root\'s log key' })
  })

  it('leaves a checkpoint the witnesses have not cosigned unchecked, after proving it consistent', async () => {
    const fixture = scenario()
    const transport = new FixtureTransport()
    transport.note = fixture.log.checkpoint()
    const verdict = await checkOnline({ root: fixture.root, bundle: verified(fixture), stored: undefined, transport, now: NOW })
    expect(verdict).toMatchObject({ ok: false, kind: 'unwitnessed', detail: 'the latest checkpoint has 0 of the 1 witness cosignatures a check needs' })
    expect(transport.asked).toEqual([{ first: 3, second: 3 }])
  })

  it('refuses an uncosigned checkpoint whose proof does not verify, so leaving the cosignature out avoids no check', async () => {
    const fixture = scenario()
    fixture.log.append(Buffer.from('a fourth entry'))
    const verdict = await online(fixture, (transport) => {
      transport.note = fixture.log.checkpoint()
      transport.proof = ['0'.repeat(64)]
    })
    expect(verdict).toMatchObject({ ok: false, kind: 'failed', refusal: 'consistency-proof-invalid' })
  })

  it('refuses a listed witness\'s cosignature that is present and does not verify', async () => {
    const fixture = scenario()
    const cosigned = fixture.witness.cosign(fixture.log.checkpoint(), COSIGNED_AT)
    const lines = cosigned.split('\n')
    // The witness's line keeps its name and key hash; its signature is another body's.
    const other = fixture.witness.cosign(fixture.log.note(2), COSIGNED_AT).split('\n').at(-2)!
    lines[lines.length - 2] = other
    const verdict = await online(fixture, (transport) => { transport.note = lines.join('\n') })
    expect(verdict).toMatchObject({ ok: false, kind: 'failed', refusal: 'witness-cosignature-missing', detail: `the cosignature of witness ${fixture.witness.name} does not verify` })
  })

  it('requires one cosignature whatever threshold the root carries, instead of reading an infinitely old checkpoint', async () => {
    const fixture = scenario()
    const root = { ...fixture.root, witnesses: { ...fixture.root.witnesses, threshold: 0 } }
    const transport = new FixtureTransport()
    transport.note = fixture.log.checkpoint()
    // A threshold of 0 would satisfy `0 < 0`, and the newest cosigning time of no cosignature is `-Infinity`; the
    // contract's client value of 1 leaves the uncosigned checkpoint unchecked instead of verified.
    const verdict = await checkOnline({ root, bundle: verified(fixture), stored: undefined, transport, now: NOW })
    expect(verdict).toMatchObject({ ok: false, kind: 'unwitnessed' })
  })

  it('leaves the release unchecked for an answer that is not a signed note, such as a proxy\'s page', async () => {
    const fixture = scenario()
    const verdict = await online(fixture, (transport) => { transport.note = '<html>blocked</html>' })
    expect(verdict).toMatchObject({ ok: false, kind: 'unreachable' })
    if (!verdict.ok) expect(verdict.detail).toContain('is not a checkpoint')
  })

  it('fails the check for a root whose log key does not read, which is this client\'s trust and not the log\'s answer', async () => {
    const fixture = scenario()
    const root = { ...fixture.root, log: { ...fixture.root.log, vkey: 'not a verifier key' } }
    const transport = new FixtureTransport()
    transport.note = fixture.witness.cosign(fixture.log.checkpoint(), COSIGNED_AT)
    expect(await checkOnline({ root, bundle: verified(fixture), stored: undefined, transport, now: NOW })).toMatchObject({ ok: false, kind: 'failed', refusal: 'log-origin-untrusted' })
  })
})

describe('consistency with the tree the client holds', () => {
  it('c18-checkpoint-rollback-refused: refuses a latest checkpoint smaller than the stored one', async () => {
    const fixture = scenario()
    const stored = signedStored(fixture, 9, Buffer.alloc(32, 3))
    const verdict = await online(fixture, (transport) => { transport.note = fixture.witness.cosign(fixture.log.checkpoint(), COSIGNED_AT) }, stored)
    expect(verdict).toMatchObject({ ok: false, kind: 'failed', refusal: 'checkpoint-rolled-back' })
  })

  it('c18-inconsistent-log-fails-start: refuses a proof that the stored tree is not a prefix of the log\'s', async () => {
    const fixture = scenario()
    // The client stored a tree of 4 the log signed, whose first leaves are not the log's current ones.
    const forked = [Buffer.alloc(32, 5), Buffer.alloc(32, 6), Buffer.alloc(32, 7), Buffer.alloc(32, 8)]
    const stored = signedStored(fixture, 4, treeRoot(forked))
    fixture.log.append(Buffer.from('a fourth entry'))
    fixture.log.append(Buffer.from('a fifth entry'))
    const verdict = await online(fixture, (transport) => {
      transport.note = fixture.witness.cosign(fixture.log.checkpoint(), COSIGNED_AT)
      transport.proof = consistencyProof(4, [...forked, Buffer.alloc(32, 9)]).map(hash => hash.toString('hex'))
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
    const stored = signedStored(fixture, fixture.bundle.inclusion.treeSize, Buffer.alloc(32, 4))
    const verdict = await online(fixture, (transport) => { transport.note = fixture.witness.cosign(fixture.log.checkpoint(), COSIGNED_AT) }, stored)
    expect(verdict).toMatchObject({ ok: false, kind: 'failed', refusal: 'consistency-proof-invalid' })
  })

  it('proves from the bundle\'s verified tree, not from a stored record below it', async () => {
    const fixture = scenario()
    const stored = signedStored(fixture, 1)
    const transport = new FixtureTransport()
    transport.note = fixture.witness.cosign(fixture.log.checkpoint(), COSIGNED_AT)
    const verdict = await checkOnline({ root: fixture.root, bundle: verified(fixture), stored, transport, now: NOW })
    // The stored record lowers the floor, so the proof starts from the bundle's tree of 3, not the record's 1.
    expect(verdict.ok).toBe(true)
    expect(transport.asked).toEqual([{ first: 3, second: 3 }])
  })

  it('c18-checkpoint-rollback-refused: refuses a latest checkpoint below the bundle\'s tree, though the stored record is lower still', async () => {
    const fixture = scenario()
    const stored = signedStored(fixture, 1)
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

describe('a stored record the trusted root\'s log did not sign', () => {
  it('sets no floor: a record of a larger tree with a note no trusted key signed is not a rollback', async () => {
    const fixture = scenario()
    const body = `${fixture.log.origin}\n999\n${Buffer.alloc(32, 5).toString('base64')}\n`
    const forged = storedCheckpoint(fixture.log.origin, 999, Buffer.alloc(32, 5), `${body}\n${signatureLine(fixture.log.origin, NOTE_SIGNATURE, fixture.keys.other, body)}`, 1)
    const transport = new FixtureTransport()
    transport.note = fixture.witness.cosign(fixture.log.checkpoint(), COSIGNED_AT)
    const verdict = await checkOnline({ root: fixture.root, bundle: verified(fixture), stored: forged, transport, now: NOW })
    // The proof runs from the bundle's verified tree, and the checkpoint to store replaces the record.
    expect(verdict).toMatchObject({ ok: true, checkpoint: { treeSize: 3 } })
    expect(transport.asked).toEqual([{ first: 3, second: 3 }])
  })

  it('counts a record only when its note is the root\'s log\'s signed checkpoint of the tree it names', () => {
    const fixture = scenario()
    const genuine = signedStored(fixture, 2)
    expect(storedCheckpointSigned(fixture.root, genuine)).toBe(true)
    // Another origin in the record, and the same record under a root that names another log.
    expect(storedCheckpointSigned(fixture.root, { ...genuine, origin: 'log.example.test/another' })).toBe(false)
    expect(storedCheckpointSigned({ ...fixture.root, log: { ...fixture.root.log, origin: 'log.example.test/another' } }, genuine)).toBe(false)
    // A note of another tree than the record names: another size, another root hash.
    expect(storedCheckpointSigned(fixture.root, { ...genuine, treeSize: 3 })).toBe(false)
    expect(storedCheckpointSigned(fixture.root, { ...genuine, rootHash: '0'.repeat(64) })).toBe(false)
    // A note with no signature line, one that is not a note, and one signed by a key the root does not name.
    expect(storedCheckpointSigned(fixture.root, { ...genuine, checkpoint: `${fixture.log.origin}\n2\n${treeRoot(fixture.log.leafHashes.slice(0, 2)).toString('base64')}\n` })).toBe(false)
    expect(storedCheckpointSigned(fixture.root, { ...genuine, checkpoint: 'a stored note' })).toBe(false)
    expect(storedCheckpointSigned({ ...fixture.root, log: { ...fixture.root.log, vkey: verifierKey(fixture.log.origin, NOTE_SIGNATURE, fixture.keys.other) } }, genuine)).toBe(false)
    expect(() => storedCheckpointSigned({ ...fixture.root, log: { ...fixture.root.log, vkey: 'not a verifier key' } }, genuine)).toThrow(ReleaseLogRefusalError)
  })
})

describe('the cosigning time', () => {
  it('refuses a checkpoint whose only cosignature is dated beyond the clock-skew allowance ahead of the client\'s clock', async () => {
    const fixture = scenario()
    const now = COSIGNED_AT - 365 * 86_400
    const verdict = await online(fixture, (transport) => { transport.note = fixture.witness.cosign(fixture.log.checkpoint(), COSIGNED_AT) }, undefined, now)
    expect(verdict).toMatchObject({ ok: false, kind: 'failed', refusal: 'witness-cosignature-missing' })
    if (verdict.ok || verdict.kind !== 'failed') return
    // The refusal names the cosigning time and the local clock, so a wrong clock can be seen.
    expect(verdict.detail).toContain(new Date(COSIGNED_AT * 1000).toISOString().replace('.000Z', 'Z'))
    expect(verdict.detail).toContain(new Date(now * 1000).toISOString().replace('.000Z', 'Z'))
  })

  it('counts a cosignature dated up to the allowance ahead, and refuses one a second beyond it', async () => {
    const fixture = scenario()
    const within = await online(fixture, (transport) => { transport.note = fixture.witness.cosign(fixture.log.checkpoint(), COSIGNED_AT) }, undefined, COSIGNED_AT - COSIGNATURE_CLOCK_SKEW_SECONDS)
    expect(within.ok).toBe(true)
    const beyond = await online(fixture, (transport) => { transport.note = fixture.witness.cosign(fixture.log.checkpoint(), COSIGNED_AT) }, undefined, COSIGNED_AT - COSIGNATURE_CLOCK_SKEW_SECONDS - 1)
    expect(beyond).toMatchObject({ ok: false, kind: 'failed', refusal: 'witness-cosignature-missing' })
  })

  it('refuses a witness whose newest cosignature is dated beyond the allowance, though an older one is valid', async () => {
    const fixture = scenario()
    const future = NOW + COSIGNATURE_CLOCK_SKEW_SECONDS + 3600
    const verdict = await online(fixture, (transport) => { transport.note = fixture.witness.cosign(fixture.witness.cosign(fixture.log.checkpoint(), COSIGNED_AT), future) })
    expect(verdict).toMatchObject({ ok: false, kind: 'failed', refusal: 'witness-cosignature-missing' })
  })
})

describe('an answer that is wrong in itself', () => {
  it('leaves a wrong answer for the checkpoint unchecked, and fails a wrong answer for a tile of the signed tree', async () => {
    const fixture = scenario()
    const checkpoint = await online(fixture, (transport) => { transport.distributorFailure = new LogContradictionError('the log does not serve its checkpoint') })
    expect(checkpoint).toMatchObject({ ok: false, kind: 'unreachable', detail: 'the release log gave no checkpoint (the log does not serve its checkpoint)' })
    const tile = await online(fixture, (transport) => {
      transport.note = fixture.witness.cosign(fixture.log.checkpoint(), COSIGNED_AT)
      transport.logFailure = new LogContradictionError('a tile has the wrong length')
    })
    expect(tile).toMatchObject({ ok: false, kind: 'failed', refusal: 'consistency-proof-invalid', detail: 'a tile has the wrong length' })
  })
})
