/**
 * The release-log check as a service of a Delo process (contract C18, `Behaviour per client`): a start records the
 * release's state and the verified checkpoint, and while the release stays `unchecked` the service retries the online
 * check every 15 minutes until it passes or fails. The retry is an effect of the service's context, so disposing the
 * context cancels it. The specs drive the retry through their own timers, so none waits 15 minutes.
 */
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import type { DeloLogger } from '@delo/logs'
import { RecordingLogger } from '../../runtime-store/tests/support.ts'
import { UNCHECKED_RETRY_INTERVAL_SECONDS } from '@delo/contract-release-log'
import { serializeStoredCheckpoint, storedCheckpoint } from '../src/checkpoint.ts'
import { LogUnreachableError } from '../src/online.ts'
import { checkAndRecord, type CheckInput } from '../src/record.ts'
import { ReleaseVerification, type RetryTimers } from '../src/service.ts'
import { consistencyProof, COSIGNED_AT, FixtureTransport, MANIFEST, scenario, VERSION, type Scenario } from './fixtures.ts'

const homes: string[] = []

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
})

/**
 * A new, empty home.
 * @returns its path.
 */
function newHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'release-verify-service-'))
  homes.push(home)
  return home
}

/** Timers a spec fires by hand. */
class ManualTimers implements RetryTimers {
  readonly scheduled: { readonly callback: () => void, readonly milliseconds: number, cleared: boolean }[] = []

  setTimeout(callback: () => void, milliseconds: number): unknown {
    const timer = { callback, milliseconds, cleared: false }
    this.scheduled.push(timer)
    return timer
  }

  clearTimeout(handle: unknown): void {
    (handle as { cleared: boolean }).cleared = true
  }

  /** The timers neither fired nor cleared. */
  get pending(): number {
    return this.scheduled.filter(timer => !timer.cleared).length
  }

  /**
   * Fire the newest pending timer.
   * @throws Error when none is pending.
   */
  fire(): void {
    const timer = this.scheduled.findLast(candidate => !candidate.cleared)
    if (timer === undefined) throw new Error('no timer is pending')
    timer.cleared = true
    timer.callback()
  }
}

/**
 * Start a service in a new context.
 * @param home - the home.
 * @param timers - the timers; the platform's when absent.
 * @returns the service and the context's fiber.
 */
async function serviceIn(home: string, timers?: RetryTimers, logger: DeloLogger = new RecordingLogger()): Promise<{ readonly service: ReleaseVerification, readonly dispose: () => Promise<void> }> {
  const root = new Context()
  let service: ReleaseVerification | undefined
  const fiber = root.plugin({
    apply: (ctx: Context) => {
      service = new ReleaseVerification(ctx, { home, logger, ...timers === undefined ? {} : { timers } })
    },
  })
  await fiber.await()
  return { service: service!, dispose: async () => { await fiber.dispose() } }
}

/**
 * A start check's input over the fixture.
 * @param fixture - the fixture.
 * @param transport - the transport.
 * @param patch - fields to replace.
 * @returns the input.
 */
function input(fixture: Scenario, transport: FixtureTransport | undefined, patch: Partial<CheckInput> = {}): CheckInput {
  return { root: fixture.root, version: VERSION, manifest: MANIFEST, bundle: Buffer.from(JSON.stringify(fixture.bundle)), now: COSIGNED_AT + 60, transport, mode: 'warn', missingBundle: 'failed', ...patch }
}

/**
 * A transport whose distributor is unreachable until a spec sets its note.
 * @returns the transport.
 */
function unreachable(): FixtureTransport {
  const transport = new FixtureTransport()
  transport.distributorFailure = new LogUnreachableError('the distributor is down')
  return transport
}

/**
 * Wait until the service's last result is in the given state, as a fired retry settles asynchronously.
 * @param service - the service.
 * @param state - the state to wait for.
 */
async function settled(service: ReleaseVerification, state: string): Promise<void> {
  await expect.poll(() => service.lastStartResult?.state).toBe(state)
}

describe('a start through the service', () => {
  it('records `verified` and the checkpoint, and arms no retry', async () => {
    const home = newHome()
    const fixture = scenario()
    const timers = new ManualTimers()
    const { service, dispose } = await serviceIn(home, timers)
    expect(service.lastStartResult).toBeUndefined()
    const transport = new FixtureTransport()
    transport.note = fixture.witness.cosign(fixture.log.checkpoint(), COSIGNED_AT)
    const result = await service.start(input(fixture, transport))
    expect(result.state).toBe('verified')
    expect(service.lastStartResult).toBe(result)
    expect(await service.lastRecorded(VERSION)).toMatchObject({ state: 'verified' })
    expect(await service.lastRecorded('9.9.9')).toBeUndefined()
    expect((await service.storedCheckpoint())?.treeSize).toBe(3)
    expect(timers.scheduled).toEqual([])
    await dispose()
  })

  it('c18-offline-recheck-on-connect: retries an unchecked release every 15 minutes until the log answers', async () => {
    const home = newHome()
    const fixture = scenario()
    const timers = new ManualTimers()
    const { service, dispose } = await serviceIn(home, timers)
    const transport = unreachable()
    expect((await service.start(input(fixture, transport))).state).toBe('unchecked')
    expect(timers.scheduled.map(timer => timer.milliseconds)).toEqual([UNCHECKED_RETRY_INTERVAL_SECONDS * 1000])
    // Still unreachable: the retry records `unchecked` again and arms the next one.
    timers.fire()
    await expect.poll(() => timers.scheduled.length).toBe(2)
    expect(await service.lastRecorded(VERSION)).toMatchObject({ state: 'unchecked' })
    // The log answers: the next retry records `verified` and arms nothing more.
    transport.distributorFailure = undefined
    transport.note = fixture.witness.cosign(fixture.log.checkpoint(), COSIGNED_AT)
    timers.fire()
    await settled(service, 'verified')
    expect(await service.lastRecorded(VERSION)).toMatchObject({ state: 'verified' })
    expect(timers.pending).toBe(0)
    await dispose()
  })

  it('proves a retry from the checkpoint stored since the start', async () => {
    const home = newHome()
    const fixture = scenario()
    const timers = new ManualTimers()
    const { service, dispose } = await serviceIn(home, timers)
    const transport = unreachable()
    await service.start(input(fixture, transport))
    // Another process verified the log in the meantime and stored a larger tree.
    fixture.log.append(Buffer.from('a fourth entry'))
    const other = new FixtureTransport()
    other.note = fixture.witness.cosign(fixture.log.checkpoint(), COSIGNED_AT)
    other.proof = consistencyProof(3, fixture.log.leafHashes).map(hash => hash.toString('hex'))
    await checkAndRecord(home, input(fixture, other))
    transport.distributorFailure = undefined
    transport.note = other.note
    timers.fire()
    await settled(service, 'verified')
    // The retry started from the stored tree of 4, so it asked for the proof of 4 against itself.
    expect(transport.asked).toEqual([{ first: 4, second: 4 }])
    await dispose()
  })

  it('stops retrying once the release fails, and arms none without a transport or with the online check off', async () => {
    const home = newHome()
    const fixture = scenario()
    const timers = new ManualTimers()
    const { service, dispose } = await serviceIn(home, timers)
    const transport = unreachable()
    await service.start(input(fixture, transport))
    transport.distributorFailure = undefined
    // The log answers with its signed checkpoint and a witness cosignature dated a day after this machine's clock.
    transport.note = fixture.witness.cosign(fixture.log.checkpoint(), COSIGNED_AT + 86_400)
    timers.fire()
    await settled(service, 'failed')
    expect(timers.pending).toBe(0)
    expect((await service.start(input(fixture, undefined))).state).toBe('unchecked')
    expect((await service.start(input(fixture, unreachable(), { mode: 'off' }))).state).toBe('unchecked')
    expect(timers.pending).toBe(0)
    await dispose()
  })

  it('proves from the checkpoint stored under the home', async () => {
    const home = newHome()
    const fixture = scenario()
    const { service, dispose } = await serviceIn(home, new ManualTimers())
    const stored = storedCheckpoint(fixture.log.origin, 9, Buffer.alloc(32, 3), fixture.log.note(9, Buffer.alloc(32, 3)), COSIGNED_AT)
    mkdirSync(join(home, 'trust'), { mode: 0o700 })
    writeFileSync(join(home, 'trust', 'checkpoint.json'), serializeStoredCheckpoint(stored), { mode: 0o600 })
    const transport = new FixtureTransport()
    transport.note = fixture.witness.cosign(fixture.log.checkpoint(), COSIGNED_AT)
    expect(await service.start(input(fixture, transport))).toMatchObject({ state: 'failed', refusal: 'checkpoint-rolled-back' })
    await dispose()
  })

  it('logs a retry whose own work throws, and keeps retrying on schedule', async () => {
    const home = newHome()
    const fixture = scenario()
    const timers = new ManualTimers()
    const logger = new RecordingLogger()
    const { service, dispose } = await serviceIn(home, timers, logger)
    const transport = unreachable()
    await service.start(input(fixture, transport))
    // The state record becomes one other users can read, which the home refuses to read.
    chmodSync(join(home, 'trust', 'release-log.json'), 0o644)
    timers.fire()
    await expect.poll(() => logger.records.length).toBe(1)
    expect(logger.records[0]).toMatchObject({ level: 'error', msg: 'the release-log check retry failed; the next retry runs on schedule' })
    await expect.poll(() => timers.pending).toBe(1)
    await dispose()
  })
})

describe('the retry and the context', () => {
  it('cancels the pending retry when the context is disposed', async () => {
    const home = newHome()
    const fixture = scenario()
    const timers = new ManualTimers()
    const { service, dispose } = await serviceIn(home, timers)
    await service.start(input(fixture, unreachable()))
    expect(timers.pending).toBe(1)
    await dispose()
    expect(timers.pending).toBe(0)
  })

  it('arms the platform\'s timer by default, and clears it with the context', async () => {
    const home = newHome()
    const fixture = scenario()
    const { service, dispose } = await serviceIn(home)
    expect((await service.start(input(fixture, unreachable()))).state).toBe('unchecked')
    // A pending platform timer would keep this process alive for 15 minutes; disposing clears it.
    await dispose()
    service.cancel()
  })
})
