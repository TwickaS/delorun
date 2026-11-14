/**
 * The start check of contract C18 (`Behaviour per client`): a start that verified goes on; a start with no network, or
 * with no bundle stored yet, goes on with the warning that names the release and records `unchecked`; and a verifiable
 * failure stops the start in every verification mode (R5), whatever `integrity.mode` says.
 */
import { describe, expect, it } from 'vitest'
import { VERIFICATION_MODES, VERIFICATION_MODE_SETTING, type VerificationMode } from '@delorun/contract-verification-checks'
import { storedCheckpoint } from '../src/checkpoint.ts'
import { LogUnreachableError } from '../src/online.ts'
import { checkAtStart, INTEGRITY_MODE_SETTING, onlineCheckEnabled, uncheckedWarning, type StartCheckInput } from '../src/start.ts'
import { consistencyProof, COSIGNED_AT, FixtureTransport, MANIFEST, scenario, VERSION, type Scenario } from './fixtures.ts'

/** The client's clock, a minute after the fixture checkpoint's cosignature. */
const NOW = COSIGNED_AT + 60

/**
 * A start check of the fixture release.
 * @param fixture - the fixture.
 * @param overrides - what the case replaces.
 * @returns the input to run.
 */
function input(fixture: Scenario, overrides: Partial<StartCheckInput> = {}): StartCheckInput {
  return {
    root: fixture.root,
    version: VERSION,
    manifest: MANIFEST,
    bundle: Buffer.from(JSON.stringify(fixture.bundle)),
    now: NOW,
    stored: undefined,
    transport: undefined,
    mode: 'warn',
    missingBundle: 'failed',
    ...overrides,
  }
}

/**
 * A transport serving the fixture log's cosigned checkpoint, consistent with the bundle.
 * @param fixture - the fixture.
 * @returns the transport.
 */
function reachable(fixture: Scenario): FixtureTransport {
  const transport = new FixtureTransport()
  transport.note = fixture.witness.cosign(fixture.log.checkpoint(), COSIGNED_AT)
  return transport
}

describe('a release that verified', () => {
  it('records `verified`, stores the checkpoint and lets the start go on', async () => {
    const fixture = scenario()
    const result = await checkAtStart(input(fixture, { transport: reachable(fixture), mode: 'enforce' }))
    expect(result.state).toBe('verified')
    expect(result.stop).toBe(false)
    expect(result.warning).toBeUndefined()
    expect(result.checkpoint?.treeSize).toBe(fixture.log.size)
  })
})

describe('a release that could not be checked', () => {
  it('c18-offline-start-warns: with no network it records `unchecked`, warns with the version, and goes on', async () => {
    const fixture = scenario()
    const result = await checkAtStart(input(fixture))
    expect(result.state).toBe('unchecked')
    expect(result.stop).toBe(false)
    expect(result.warning).toBe(uncheckedWarning(VERSION))
    expect(result.warning).toContain(VERSION)
  })

  it('c18-store-install-missing-bundle-fails: stops the start of a store-installed release whose bundle is missing, in every mode', async () => {
    const fixture = scenario()
    for (const mode of ['off', 'warn', 'enforce'] as const) {
      const result = await checkAtStart(input(fixture, { bundle: undefined, transport: reachable(fixture), mode }))
      expect(result).toMatchObject({ state: 'failed', refusal: 'bundle-malformed', stop: true })
      expect(result.detail).toContain('no release-log bundle is stored beside this release')
    }
  })

  it('names the release when no bundle is stored for it yet, for a client that fetches it after installing', async () => {
    const fixture = scenario()
    const result = await checkAtStart(input(fixture, { bundle: undefined, missingBundle: 'unchecked' }))
    expect(result.state).toBe('unchecked')
    expect(result.stop).toBe(false)
    expect(result.detail).toContain('no release-log bundle')
    expect(result.warning).toContain(VERSION)
  })

  it('runs no online check and warns nothing under integrity.mode off, though the offline check still runs', async () => {
    const fixture = scenario()
    const transport = reachable(fixture)
    const result = await checkAtStart(input(fixture, { transport, mode: 'off' }))
    expect(result.state).toBe('unchecked')
    expect(result.stop).toBe(false)
    expect(result.warning).toBeUndefined()
    expect(result.checkpoint).toBeUndefined()
    expect(transport.asked).toEqual([])
  })
})

describe('a verifiable failure', () => {
  it('stops the start in every verification mode, and records the refusal', async () => {
    const fixture = scenario()
    for (const mode of VERIFICATION_MODES) {
      const result = await checkAtStart(input(fixture, { manifest: Buffer.from('another manifest'), mode }))
      expect(result.state).toBe('failed')
      expect(result.stop).toBe(true)
      expect(result.refusal).toBe('manifest-digest-mismatch')
      expect(result.detail).toBeDefined()
    }
  })

  it('c18-inconsistent-log-fails-start: a latest checkpoint whose proof does not verify stops the start', async () => {
    const fixture = scenario()
    fixture.log.append(Buffer.from('a later entry'))
    const rootHash = Buffer.from(fixture.bundle.inclusion.rootHash, 'hex')
    const stored = storedCheckpoint(fixture.log.origin, fixture.bundle.inclusion.treeSize, rootHash, fixture.log.note(fixture.bundle.inclusion.treeSize, rootHash), COSIGNED_AT)
    const transport = new FixtureTransport()
    transport.note = fixture.witness.cosign(fixture.log.checkpoint(), COSIGNED_AT)
    transport.proof = consistencyProof(3, [Buffer.alloc(32, 1), Buffer.alloc(32, 2), Buffer.alloc(32, 3), Buffer.alloc(32, 4)]).map(hash => hash.toString('hex'))
    for (const mode of ['warn', 'enforce'] as const) {
      const result = await checkAtStart(input(fixture, { transport, stored, mode }))
      expect(result.state).toBe('failed')
      expect(result.stop).toBe(true)
      expect(result.refusal).toBe('consistency-proof-invalid')
    }
  })

  it('c18-checkpoint-rollback-refused: a witnessed checkpoint smaller than the stored one stops the start', async () => {
    const fixture = scenario()
    const stored = storedCheckpoint(fixture.log.origin, 9, Buffer.alloc(32, 3), fixture.log.note(9, Buffer.alloc(32, 3)), COSIGNED_AT)
    const result = await checkAtStart(input(fixture, { transport: reachable(fixture), stored }))
    expect(result.state).toBe('failed')
    expect(result.stop).toBe(true)
    expect(result.refusal).toBe('checkpoint-rolled-back')
  })

  it('records `failed` instead of rejecting when the release version is not a semantic version', async () => {
    const fixture = scenario()
    for (const mode of VERIFICATION_MODES) {
      const result = await checkAtStart(input(fixture, { version: 'v0.1', mode }))
      expect(result.state).toBe('failed')
      expect(result.stop).toBe(true)
      expect(result.refusal).toBe('entry-key-untrusted')
      expect(result.detail).toContain('not a semantic version')
    }
  })

  it('records `unchecked` when the distributor is unreachable, which is not a failure', async () => {
    const fixture = scenario()
    const transport = new FixtureTransport()
    transport.distributorFailure = new LogUnreachableError('the log answered 503')
    const result = await checkAtStart(input(fixture, { transport }))
    expect(result.state).toBe('unchecked')
    expect(result.stop).toBe(false)
    expect(result.warning).toBe(uncheckedWarning(VERSION))
  })
})

describe('the online check\'s setting', () => {
  it('is `integrity.mode`, and runs unless the mode is off', () => {
    expect(INTEGRITY_MODE_SETTING).toBe(VERIFICATION_MODE_SETTING)
    const enabled: Record<VerificationMode, boolean> = { warn: true, enforce: true, off: false }
    for (const mode of VERIFICATION_MODES) expect(onlineCheckEnabled(mode)).toBe(enabled[mode])
  })

  it('warns in the contract\'s words, naming the release and the next connection', () => {
    expect(uncheckedWarning('0.2.0')).toContain('0.2.0')
    expect(uncheckedWarning('0.2.0')).toContain('release log')
  })
})

describe('the online check\'s deadline at a start', () => {
  it('leaves the release unchecked when the deadline the caller passes has already passed', async () => {
    const fixture = scenario()
    const controller = new AbortController()
    controller.abort()
    const result = await checkAtStart(input(fixture, { transport: reachable(fixture), signal: controller.signal }))
    expect(result).toMatchObject({ state: 'unchecked', stop: false })
  })
})
