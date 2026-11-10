/**
 * The check with its two records under the home (contract C18, `Check states`; contract C1's `trust/`): a check records
 * the release's state and stores the checkpoint the online check verified, each as a protected file at mode 0600 in a
 * 0700 directory; a record that does not read is no record; and a record that is a link or that other users can read is
 * refused, as C1's refusal rule requires of every file under `trust/`.
 */
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { serializeStoredCheckpoint, storedCheckpoint } from '../src/checkpoint.ts'
import { checkStatePath, checkpointPath } from '../src/paths.ts'
import { checkAndRecord, readCheckpointFile, readCheckpointRecord, readCheckRecords, type CheckInput } from '../src/record.ts'
import { LogUnreachableError } from '../src/online.ts'
import { consistencyProof, COSIGNED_AT, FixtureTransport, MANIFEST, scenario, treeRoot, VERSION, type Scenario } from './fixtures.ts'

const homes: string[] = []

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
})

/**
 * A new, empty home.
 * @returns its path.
 */
function newHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'release-verify-record-'))
  homes.push(home)
  return home
}

/**
 * A start check's input over the fixture, with the distributor answering the fixture's cosigned checkpoint.
 * @param fixture - the fixture.
 * @param patch - fields to replace.
 * @returns the input.
 */
function input(fixture: Scenario, patch: Partial<CheckInput> = {}): CheckInput {
  const transport = new FixtureTransport()
  transport.note = fixture.witness.cosign(fixture.log.checkpoint(), COSIGNED_AT)
  return { root: fixture.root, version: VERSION, manifest: MANIFEST, bundle: Buffer.from(JSON.stringify(fixture.bundle)), now: COSIGNED_AT + 60, transport, mode: 'warn', ...patch }
}

describe('a check and its records', () => {
  it('records the release\'s state and stores the verified checkpoint, each at mode 0600 in a 0700 directory', async () => {
    const home = newHome()
    const fixture = scenario()
    const result = await checkAndRecord(home, input(fixture))
    expect(result.state).toBe('verified')
    expect((await readCheckRecords(home)).get(VERSION)).toMatchObject({ release: VERSION, state: 'verified', lastAttempt: COSIGNED_AT + 60 })
    expect(await readCheckpointRecord(home)).toMatchObject({ treeSize: 3, rootHash: fixture.log.rootHash.toString('hex') })
    expect(statSync(checkStatePath(home)).mode & 0o777).toBe(0o600)
    expect(statSync(checkpointPath(home)).mode & 0o777).toBe(0o600)
    expect(statSync(join(home, 'trust')).mode & 0o777).toBe(0o700)
  })

  it('records a failure with its refusal and keeps the checkpoint stored before', async () => {
    const home = newHome()
    const fixture = scenario()
    await checkAndRecord(home, input(fixture))
    const before = readFileSync(checkpointPath(home), 'utf8')
    const result = await checkAndRecord(home, input(fixture, { manifest: Buffer.from('another manifest') }))
    expect(result.state).toBe('failed')
    expect((await readCheckRecords(home)).get(VERSION)).toMatchObject({ state: 'failed', refusal: 'manifest-digest-mismatch', failure: 'manifest-digest-mismatch' })
    expect(readFileSync(checkpointPath(home), 'utf8')).toBe(before)
  })

  it('keeps every other release\'s record when it records one', async () => {
    const home = newHome()
    const fixture = scenario()
    await checkAndRecord(home, input(fixture, { transport: undefined }))
    await checkAndRecord(home, input(fixture, { version: '0.2.0' }))
    const records = await readCheckRecords(home)
    expect([...records.keys()]).toEqual(['0.1.0', '0.2.0'])
    expect(records.get('0.1.0')?.state).toBe('unchecked')
  })

  it('replaces a stored record no trusted key signed with the checkpoint that verified', async () => {
    const home = newHome()
    const fixture = scenario()
    const body = `${fixture.log.origin}\n999\n${Buffer.alloc(32, 5).toString('base64')}\n`
    const forged = storedCheckpoint(fixture.log.origin, 999, Buffer.alloc(32, 5), `${body}\n— nobody AAAAAAAAAAAA\n`, 1)
    mkdirSync(join(home, 'trust'), { mode: 0o700 })
    writeFileSync(checkpointPath(home), serializeStoredCheckpoint(forged), { mode: 0o600 })
    const stored = await readCheckpointRecord(home)
    expect(stored?.treeSize).toBe(999)
    const result = await checkAndRecord(home, input(fixture))
    expect(result.state).toBe('verified')
    expect((await readCheckpointRecord(home))?.treeSize).toBe(3)
  })
})

describe('a record that does not read', () => {
  it('is no record: an absent file and one that is not a record read as none', async () => {
    const home = newHome()
    expect(await readCheckpointRecord(home)).toBeUndefined()
    expect((await readCheckRecords(home)).size).toBe(0)
    mkdirSync(join(home, 'trust'), { mode: 0o700 })
    writeFileSync(checkpointPath(home), '{"treeSize":3,"rootHash":"00"}\n', { mode: 0o600 })
    writeFileSync(checkStatePath(home), 'not json', { mode: 0o600 })
    expect(await readCheckpointRecord(home)).toBeUndefined()
    expect((await readCheckRecords(home)).size).toBe(0)
  })
})

describe('contract C1\'s refusal rule', () => {
  it('refuses a checkpoint record and a state record that other users can read', async () => {
    const home = newHome()
    const fixture = scenario()
    await checkAndRecord(home, input(fixture))
    chmodSync(checkpointPath(home), 0o644)
    await expect(readCheckpointRecord(home)).rejects.toMatchObject({ code: 'SECRET_FILE_MODE' })
    chmodSync(checkStatePath(home), 0o640)
    await expect(readCheckRecords(home)).rejects.toMatchObject({ code: 'SECRET_FILE_MODE' })
    await expect(checkAndRecord(home, input(fixture))).rejects.toMatchObject({ code: 'SECRET_FILE_MODE' })
  })

  it('refuses a record that is a symbolic link, without reading the file it names', async () => {
    const home = newHome()
    const elsewhere = join(home, 'elsewhere.json')
    writeFileSync(elsewhere, '{}', { mode: 0o600 })
    mkdirSync(join(home, 'trust'), { mode: 0o700 })
    symlinkSync(elsewhere, checkpointPath(home))
    await expect(readCheckpointRecord(home)).rejects.toMatchObject({ code: 'SECRET_FILE_MODE' })
  })
})

describe('a checkpoint stored in the installer\'s earlier format', () => {
  /**
   * Write the earlier `{treeSize, rootHash}` record.
   * @param home - the home.
   * @param treeSize - its tree size.
   * @param rootHash - its root hash.
   */
  function legacy(home: string, treeSize: number, rootHash: Buffer): void {
    mkdirSync(join(home, 'trust'), { recursive: true, mode: 0o700 })
    writeFileSync(checkpointPath(home), `${JSON.stringify({ treeSize, rootHash: rootHash.toString('hex') })}\n`, { mode: 0o600 })
  }

  it('reads as the earlier format, and as no signed record', async () => {
    const home = newHome()
    legacy(home, 4, Buffer.alloc(32, 1))
    expect(await readCheckpointFile(home)).toEqual({ kind: 'legacy', legacy: { treeSize: 4, rootHash: '01'.repeat(32) } })
    expect(await readCheckpointRecord(home)).toBeUndefined()
  })

  it('is kept as the floor when the log proves it a prefix of the latest checkpoint, and replaced by the signed record', async () => {
    const home = newHome()
    const fixture = scenario()
    fixture.log.append(Buffer.from('a fourth entry'))
    fixture.log.append(Buffer.from('a fifth entry'))
    legacy(home, 4, treeRoot(fixture.log.leafHashes.slice(0, 4)))
    const transport = new FixtureTransport()
    transport.note = fixture.witness.cosign(fixture.log.checkpoint(), COSIGNED_AT)
    transport.proof = consistencyProof(4, fixture.log.leafHashes).map(hash => hash.toString('hex'))
    const result = await checkAndRecord(home, { ...input(fixture), transport })
    expect(result.state).toBe('verified')
    expect(result.notices).toBeUndefined()
    // Both proofs ran from the earlier record's tree: the one that kept it, and the one that verified the log.
    expect(transport.asked).toEqual([{ first: 4, second: 5 }, { first: 4, second: 5 }])
    expect((await readCheckpointRecord(home))?.treeSize).toBe(5)
  })

  it('is replaced with a notice, never refused, when the log cannot prove it', async () => {
    for (const [treeSize, rootHash] of [[9, Buffer.alloc(32, 2)], [4, Buffer.alloc(32, 3)]] as const) {
      const home = newHome()
      const fixture = scenario()
      fixture.log.append(Buffer.from('a fourth entry'))
      fixture.log.append(Buffer.from('a fifth entry'))
      legacy(home, treeSize, rootHash)
      const transport = new FixtureTransport()
      transport.note = fixture.witness.cosign(fixture.log.checkpoint(), COSIGNED_AT)
      transport.proof = consistencyProof(3, fixture.log.leafHashes).map(hash => hash.toString('hex'))
      const result = await checkAndRecord(home, { ...input(fixture), transport })
      expect(result.state, String(treeSize)).toBe('verified')
      expect(result.notices).toEqual([`the checkpoint an earlier install stored, tree size ${String(treeSize)}, could not be proved against the log's latest checkpoint, so it sets no floor and is replaced`])
      expect((await readCheckRecords(home)).get(VERSION)?.notices).toEqual(result.notices)
      expect((await readCheckpointRecord(home))?.treeSize).toBe(5)
    }
  })

  it('stays in place when the log cannot be reached to prove it', async () => {
    const home = newHome()
    const fixture = scenario()
    fixture.log.append(Buffer.from('a fourth entry'))
    legacy(home, 4, treeRoot(fixture.log.leafHashes.slice(0, 4)))
    const transport = new FixtureTransport()
    transport.note = fixture.witness.cosign(fixture.log.checkpoint(), COSIGNED_AT)
    transport.logFailure = new LogUnreachableError('the log timed out')
    expect((await checkAndRecord(home, { ...input(fixture), transport })).state).toBe('unchecked')
    expect((await readCheckpointFile(home)).kind).toBe('legacy')
  })

  it('adds nothing when it names a tree the bundle already proved', async () => {
    const home = newHome()
    const fixture = scenario()
    legacy(home, 2, Buffer.alloc(32, 4))
    const result = await checkAndRecord(home, input(fixture))
    expect(result.state).toBe('verified')
    expect(result.notices).toBeUndefined()
  })
})

describe('a floor that starts again', () => {
  it('records a notice naming the releases this home recorded as verified when the stored checkpoint does not read', async () => {
    const home = newHome()
    const fixture = scenario()
    await checkAndRecord(home, input(fixture))
    writeFileSync(checkpointPath(home), 'damaged', { mode: 0o600 })
    const result = await checkAndRecord(home, input(fixture))
    expect(result.notices).toEqual([expect.stringContaining(`the rollback floor started again from the release's own checkpoint, though this home recorded ${VERSION} as verified`)])
    const fresh = newHome()
    mkdirSync(join(fresh, 'trust'), { mode: 0o700 })
    writeFileSync(checkpointPath(fresh), 'damaged', { mode: 0o600 })
    expect((await checkAndRecord(fresh, input(fixture))).notices).toEqual([expect.stringMatching(/started again from the release's own checkpoint$/u)])
  })

  it('records a notice when the stored record is not one the trusted root\'s log signed', async () => {
    const home = newHome()
    const fixture = scenario()
    mkdirSync(join(home, 'trust'), { mode: 0o700 })
    const unsigned = storedCheckpoint(fixture.log.origin, 2, treeRoot(fixture.log.leafHashes.slice(0, 2)), `${fixture.log.origin}\n2\n${treeRoot(fixture.log.leafHashes.slice(0, 2)).toString('base64')}\n\n— nobody AAAAAAAAAAAA\n`, 1)
    writeFileSync(checkpointPath(home), serializeStoredCheckpoint(unsigned), { mode: 0o600 })
    const result = await checkAndRecord(home, input(fixture))
    expect(result.notices).toEqual(['the stored checkpoint of tree size 2 is not one the trusted root\'s log signed, so it sets no floor and is replaced'])
  })
})
