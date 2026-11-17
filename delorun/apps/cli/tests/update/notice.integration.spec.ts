/**
 * The update check (`delorun/apps/cli/src/update/notice.ts`, `notice-host.ts`), over a temporary home whose store runs
 * release 0.1.0 and a stand-in host that publishes a newer release signed under the same throwaway root: what the check
 * sends, what it verifies and records, what it shows for the profile's plugins, and what the Host's source, a
 * background start and `delorun update --check` print. No request leaves loopback.
 */
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import { Context } from '@deepseek-ai/cordis'
import { DELORUN_HOME_ENTRIES, DELORUN_LAUNCHER_ROOTS_ENV, TRUST_FILES, type RuntimeVersion } from '@delorun/contract-home-layout'
import type { SemanticVersion, Sha256Hex, UtcTimestamp } from '@delorun/contract-release-manifest'
import { UPDATE_CHECK_FAILURES, UPDATE_CHECK_SCHEMA, type UpdateCheckRecord } from '@delorun/contract-update-report'
import * as UpdateCheck from '@delorun/bundle-local/update-check'
import { ensureHomeTree } from '@delorun/home'
import { InstallError } from '@delorun/install'
import type { DelorunLogger } from '@delorun/logs'
import { RuntimeStore } from '@delorun/runtime-store'
import { envelope, fixtureRelease, NOW, releasePaths, type Fixture } from '../../../install/tests/support.ts'
import { EXIT } from '../../src/exit.ts'
import { recordedLogTransport, runtimePlatformOf, type Publication } from '../../src/update/channel.ts'
import { launcherAnchor, type LauncherAnchor } from '../../src/update/trusted-root.ts'
import { runUpdate, updateCommand, type UpdateCheckDependencies } from '../../src/update/command.ts'
import { checkedReleaseOf, checkForUpdate, readUpdateNotes, updateNotesPath, countDisabled, failureOf, failureText, noticeLine, noticeLines, noticeOf, withDeadline, readUpdateCheck, removeUpdateCheck, runningRelease, updateCheckPath, updateKind, writeUpdateCheck } from '../../src/update/notice.ts'
import { recordedNoticeLine, startNoticeLine, updateCheckSource, watchUpdates } from '../../src/update/notice-host.ts'
import { checkUpdate } from '../../src/doctor/update.ts'
import { fakeClosure, signedRelease, writeClosure } from './support.ts'

const PROFILE = 'default'
const RUNNING = brandString<RuntimeVersion>('0.1.0')
const NEWEST = brandString<RuntimeVersion>('0.2.0')
const platform = runtimePlatformOf(process.platform, process.arch)
const SILENT: DelorunLogger = { error: () => {}, warn: () => {}, info: () => {}, debug: () => {} }
const SUMMARY = 'Fixes the reach listener\'s origin check.'
const semantic = (text: string): SemanticVersion => brandString<SemanticVersion>(text)
const clock = (): Date => new Date(NOW * 1000)

/** One request the stand-in host received. */
interface Seen {
  readonly method: string
  readonly url: string
  readonly headers: IncomingHttpHeaders
  readonly body: number
}

/** A stand-in release host that records every request and can stop answering. */
interface Host {
  readonly origin: string
  readonly files: Map<string, Buffer>
  readonly seen: Seen[]
  silent: boolean
  close(): Promise<void>
}

/**
 * Serve a fixture release.
 * @param fixture - the release.
 * @returns the host.
 */
async function host(fixture: Fixture): Promise<Host> {
  const files = releasePaths(fixture)
  const seen: Seen[] = []
  const state = { silent: false }
  const server: Server = createServer((request, response) => {
    let body = 0
    request.on('data', (chunk: Buffer) => { body += chunk.byteLength })
    request.on('end', () => {
      seen.push({ method: request.method ?? '', url: request.url ?? '', headers: request.headers, body })
      if (state.silent) return
      const bytes = files.get(request.url ?? '')
      if (bytes === undefined) response.writeHead(404).end()
      else response.writeHead(200, { 'content-length': String(bytes.byteLength) }).end(bytes)
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`
  return {
    origin, files, seen,
    get silent() { return state.silent },
    set silent(value: boolean) { state.silent = value },
    close: async () => {
      server.closeAllConnections()
      await new Promise<void>(resolve => server.close(() => { resolve() }))
    },
  }
}

let base: string
let home: string
let fixture: Fixture
let server: Host
let publication: Publication
/** The environment a launcher-started process has: the directory of the release roots the launcher ships. */
let launched: Readonly<Record<string, string>>
let anchor: LauncherAnchor

/**
 * Write files under a directory, creating their parents.
 * @param directory - the directory.
 * @param files - the contents by relative path.
 */
function writeFiles(directory: string, files: Readonly<Record<string, string>>): void {
  for (const [path, content] of Object.entries(files)) {
    const target = join(directory, path)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, content)
  }
}

/**
 * Write the profile with one installed plugin.
 * @param engines - the plugin's `engines`.
 */
function profileWith(engines: Record<string, string>): void {
  const profileDir = join(home, 'profiles', PROFILE)
  rmSync(profileDir, { recursive: true, force: true })
  writeFiles(profileDir, {
    'package.json': JSON.stringify({ name: 'profile', private: true, dependencies: { 'example-plugin': '1.0.0' }, dsh: { profile: { bundles: [] } } }),
    'node_modules/example-plugin/package.json': JSON.stringify({ name: 'example-plugin', version: '1.0.0', engines }),
  })
}

/**
 * Run one check against the stand-in.
 * @param timeoutMs - the deadline.
 * @returns the record.
 */
async function check(timeoutMs = 10_000): Promise<UpdateCheckRecord> {
  return checkForUpdate({ home, profile: PROFILE, platform, running: RUNNING, anchor, timeoutMs, now: clock, publication })
}

beforeAll(async () => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'dun-')))
  home = join(base, 'h')
  await ensureHomeTree(home, PROFILE)
  fixture = await fixtureRelease({ version: '0.2.0', dsh: '0.2.3', notice: { security: true, summary: SUMMARY } })
  writeFileSync(join(home, DELORUN_HOME_ENTRIES.trust, TRUST_FILES.root), fixture.roots[0]!, { mode: 0o600 })
  mkdirSync(join(base, 'roots'))
  writeFileSync(join(base, 'roots', '1.root.json'), fixture.roots[0]!)
  launched = { [DELORUN_LAUNCHER_ROOTS_ENV]: join(base, 'roots') }
  anchor = launcherAnchor(home, launched)
  const store = new RuntimeStore({ home, platform, logger: SILENT })
  for (const version of [RUNNING, NEWEST]) {
    const closure = fakeClosure(version, { healthy: true, persistence: 'a'.repeat(64) })
    await store.install({ version, root: fixture.rootMetadata, fill: async (directory) => {
      writeClosure(directory, closure)
      return Promise.resolve(signedRelease(fixture.keys.targets, platform, version, closure))
    } })
  }
}, 120_000)

beforeEach(async () => {
  server = await host(fixture)
  publication = { source: { metadata: server.origin, files: (version, name) => `${server.origin}/releases/${version}/${name}` }, hosts: { scheme: 'http:', hosts: ['127.0.0.1'], maxRedirects: 5 } }
  await removeUpdateCheck(home, PROFILE)
  profileWith({ delorun: '^0.1.0' })
})

afterEach(async () => {
  await server.close()
})

afterAll(() => {
  execFileSync('chmod', ['-R', 'u+rwX', base], { timeout: 30_000 })
  rmSync(base, { recursive: true, force: true })
})

const NOTES = Buffer.from('Delorun 0.2.0\n\nChats\n- You can now see what changed in a release.\n')

/**
 * Stand up a host for a release that names notes, then run one check.
 * @param change - alters the host's files after signing: the notes file the host serves.
 * @param notes - the notes the manifest names.
 * @returns the record.
 */
async function checkWithNotes(change: (files: Map<string, Buffer>) => void = () => {}, notes: Buffer | null = NOTES): Promise<UpdateCheckRecord> {
  const withNotes = await fixtureRelease({ version: '0.2.0', dsh: '0.2.3', notice: { security: false, summary: SUMMARY }, keys: fixture.keys, ...notes === null ? {} : { notes } })
  await server.close()
  server = await host(withNotes)
  publication = { source: { metadata: server.origin, files: (version, name) => `${server.origin}/releases/${version}/${name}` }, hosts: { scheme: 'http:', hosts: ['127.0.0.1'], maxRedirects: 5 } }
  change(server.files)
  return check()
}

describe('the release notes', { timeout: 60_000 }, () => {
  const served = '/releases/0.2.0/delorun-0.2.0.notes.txt'

  it('stores notes that match the signed manifest and serves them while the record names their digest', async () => {
    const record = await checkWithNotes()
    expect(record.newest?.notes).toEqual({ sha256: createHash('sha256').update(NOTES).digest('hex'), length: NOTES.byteLength })
    expect(await readUpdateNotes(home, PROFILE, record)).toBe(NOTES.toString('utf8'))
  })

  it('whats-new-denies-wrong-digest: notes of the right length but another digest are not stored or shown, and the update still shows', async () => {
    const record = await checkWithNotes((files) => { files.set(served, Buffer.from(NOTES.toString('utf8').replace('Chats', 'Chat!')) ) })
    expect(record.failure).toBeUndefined()
    expect(record.newest?.delorun).toBe('0.2.0')
    expect(record.newest?.notes).toBeUndefined()
    expect(await readUpdateNotes(home, PROFILE, record)).toBeUndefined()
    expect(await readUpdateCheck(home, PROFILE)).toEqual(record)
  })

  it('whats-new-denies-wrong-length: notes shorter or longer than the signed length are not shown', async () => {
    for (const bytes of [NOTES.subarray(0, NOTES.byteLength - 1), Buffer.concat([NOTES, Buffer.from('\n')])]) {
      const record = await checkWithNotes((files) => { files.set(served, bytes) })
      expect(record.newest?.notes).toBeUndefined()
      expect(await readUpdateNotes(home, PROFILE, record)).toBeUndefined()
    }
  })

  it('whats-new-denies-unsigned-notes: a notes file the host serves for a manifest that names none is never fetched or shown', async () => {
    const record = await checkWithNotes((files) => { files.set(served, Buffer.from('Injected')) }, null)
    expect(record.newest?.notes).toBeUndefined()
    expect(server.seen.map(request => request.url)).not.toContain(served)
  })

  it('whats-new-denies-bidi-and-control-characters: notes the signer should have refused are not shown even with a matching digest', async () => {
    for (const text of ['Fixed \u202Egnirts', 'Fixed\u0007bell', 'Line\r\nbreak', 'Line\u2028separator', '\uFEFFmark']) {
      const record = await checkWithNotes(() => {}, Buffer.from(text))
      expect(record.failure).toBeUndefined()
      expect(record.newest?.notes).toBeUndefined()
      expect(await readUpdateNotes(home, PROFILE, record)).toBeUndefined()
    }
  })

  it('whats-new-denies-another-version: notes stored for one release are not served for another release', async () => {
    const record = await checkWithNotes()
    const other: UpdateCheckRecord = { ...record, newest: { ...record.newest!, notes: { sha256: brandString<Sha256Hex>('0'.repeat(64)), length: NOTES.byteLength } } }
    expect(await readUpdateNotes(home, PROFILE, other)).toBeUndefined()
  })

  it('whats-new-denies-edited-file: a stored notes file changed after verification is not served', async () => {
    const record = await checkWithNotes()
    writeFileSync(updateNotesPath(home, PROFILE), 'Edited after the check\n', { mode: 0o600 })
    expect(await readUpdateNotes(home, PROFILE, record)).toBeUndefined()
  })

  it('whats-new-rechecks-text-at-display: a record whose digest matches bidi or control bytes still shows nothing', async () => {
    const record = await checkWithNotes()
    for (const text of ['Fixed \u202Egnirts', 'Fixed\u0007bell']) {
      const bytes = Buffer.from(text)
      writeFileSync(updateNotesPath(home, PROFILE), bytes, { mode: 0o600 })
      const forged: UpdateCheckRecord = { ...record, newest: { ...record.newest!, notes: { sha256: brandString<Sha256Hex>(createHash('sha256').update(bytes).digest('hex')), length: bytes.byteLength } } }
      expect(await readUpdateNotes(home, PROFILE, forged), JSON.stringify(text)).toBeUndefined()
    }
  })

  it('whats-new-size-before-read: a stored notes file above the limit is refused before it is read, even when the record names its digest', async () => {
    const record = await checkWithNotes()
    const big = Buffer.alloc(65_537, 'a')
    writeFileSync(updateNotesPath(home, PROFILE), big, { mode: 0o600 })
    const forged: UpdateCheckRecord = { ...record, newest: { ...record.newest!, notes: { sha256: brandString<Sha256Hex>(createHash('sha256').update(big).digest('hex')), length: big.byteLength } } }
    expect(await readUpdateNotes(home, PROFILE, forged)).toBeUndefined()
  })

  it('serves nothing for a record without notes', async () => {
    expect(await readUpdateNotes(home, PROFILE, await check())).toBeUndefined()
    expect(await readUpdateNotes(home, PROFILE, undefined)).toBeUndefined()
  })
})

describe('the check', { timeout: 60_000 }, () => {
  it('update-notice-sends-no-identifier: asks only for the channel\'s signed files, with no query, cookie, body or name of this installation', async () => {
    await check()
    expect(server.seen.map(request => request.url)).toEqual(['/timestamp.json', '/releases/0.2.0/delorun-0.2.0.manifest.json', '/releases/0.2.0/delorun-0.2.0.manifest.log.json'])
    for (const request of server.seen) {
      expect(request.method).toBe('GET')
      expect(request.url).not.toContain('?')
      expect(request.body).toBe(0)
      expect(request.headers.cookie).toBeUndefined()
      expect(request.headers.authorization).toBeUndefined()
      const sent = `${request.url} ${JSON.stringify(request.headers)}`
      for (const identifying of ['0.1.0', PROFILE, 'example-plugin', home]) expect(sent).not.toContain(identifying)
      expect(JSON.stringify(request.headers).toLowerCase()).not.toContain('delorun')
    }
  })

  it('records the verified release with its upstream version, its security mark and its summary', async () => {
    const record = await check()
    expect(record).toEqual({ schema: UPDATE_CHECK_SCHEMA, checked: clock().toISOString(), verified: clock().toISOString(), newest: { delorun: '0.2.0', dsh: '0.2.3', channel: 'stable', security: true, summary: SUMMARY }, timestamp: 1 })
    expect(await readUpdateCheck(home, PROFILE)).toEqual(record)
    expect(readFileSync(updateCheckPath(home, PROFILE), 'utf8').endsWith('\n')).toBe(true)
  })

  it('counts the installed plugins the release would disable on either axis, at the moment it is read', async () => {
    const record = await check()
    const running = await runningRelease(home, platform, RUNNING, fixture.rootMetadata)
    const read = async () => (await import('../../src/update/sources.ts')).readProfileFacts(home, PROFILE)
    expect(await noticeOf(record, running, read)).toEqual({ running: { delorun: '0.1.0', dsh: '0.2.2' }, release: record.newest, kind: 'minor', disables: 1 })
    profileWith({ delorun: '>=0.1.0', dsh: '>=0.2.2' })
    expect((await noticeOf(record, running, read))?.disables).toBe(0)
    profileWith({ dsh: '0.2.2' })
    expect((await noticeOf(record, running, read))?.disables).toBe(1)
    expect(countDisabled({ plugins: [], bundles: [], layers: [], exemptions: { dsh: {}, delorun: {} } }, running, record.newest!)).toBe(0)
  })

  it('update-notice-unverified-index-silent: records why a check failed and keeps the last verified release', async () => {
    const verified = await check()
    server.files.set('/timestamp.json', envelope(fixture.timestamp, [fixture.keys.targets]))
    const failed = await check()
    expect(failed.failure).toBe('unverified')
    expect(failed.newest).toEqual(verified.newest)
    expect(failed.verified).toBe(verified.verified)
    await removeUpdateCheck(home, PROFILE)
    const first = await check()
    expect(first.newest).toBeUndefined()
    expect(first.failure).toBe('unverified')
    expect(await noticeOf(first, await runningRelease(home, platform, RUNNING, fixture.rootMetadata), () => Promise.reject(new Error('not read')))).toBeUndefined()
  })

  it('refuses a manifest that is not the one the timestamp names', async () => {
    server.files.set('/releases/0.2.0/delorun-0.2.0.manifest.json', Buffer.from('{"signed":{}}'))
    expect((await check()).failure).toBe('unverified')
  })

  it('update-notice-deadline: ends a check whose host never answers at its deadline', async () => {
    server.silent = true
    const started = Date.now()
    const record = await check(300)
    expect(record.failure).toBe('deadline')
    expect(Date.now() - started).toBeLessThan(5_000)
  })

  it('records a failure when the running release is not in the store', async () => {
    const record = await checkForUpdate({ home, profile: PROFILE, platform, running: brandString<RuntimeVersion>('9.9.9'), anchor, timeoutMs: 1_000, now: clock, publication })
    expect(record.failure).toBe('running-release-unreadable')
    expect(server.seen).toEqual([])
  })

  it('update-notice-unanchored: a Delorun its launcher did not start reads no root, asks the channel nothing and records why', async () => {
    const record = await checkForUpdate({ home, profile: PROFILE, platform, running: RUNNING, anchor: launcherAnchor(home, {}), timeoutMs: 1_000, now: clock, publication })
    expect(record.failure).toBe('running-release-unreadable')
    expect(server.seen).toEqual([])
  })

  it('uses this process\'s clock and contract C2\'s publication by default, through the fetch it is given', async () => {
    const asked: string[] = []
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      vi.setSystemTime(new Date('2027-03-01T12:00:00.000Z'))
      const record = await checkForUpdate({ home, profile: PROFILE, platform, running: RUNNING, anchor, timeoutMs: 1_000, fetch: async (input) => { asked.push(String(input)); throw new Error('offline') } })
      expect(asked).toEqual(['https://releases.delorun.com/timestamp.json', 'https://releases.delo.run/timestamp.json'])
      expect(record.failure).toBe('unreachable')
      expect(record.checked).toBe('2027-03-01T12:00:00.000Z')
    } finally {
      vi.useRealTimers()
    }
  })

  it('stops at once when its signal aborts, and records nothing', async () => {
    const cancel = new AbortController()
    let started = 0
    const hanging: typeof globalThis.fetch = (_input, init) => new Promise<Response>((_resolve, reject) => {
      started++
      // The channel tries its next host with the same, already aborted signal.
      if (init?.signal?.aborted === true) reject(new Error('aborted'))
      init?.signal?.addEventListener('abort', () => { reject(new Error('aborted')) })
    })
    const running = checkForUpdate({ home, profile: PROFILE, platform, running: RUNNING, anchor, timeoutMs: 600_000, fetch: hanging, signal: cancel.signal })
    await vi.waitFor(() => { expect(started).toBeGreaterThan(0) })
    cancel.abort()
    await running
    expect(await readUpdateCheck(home, PROFILE)).toBeUndefined()
  })

  it('update-notice-regressed: refuses a channel that names an older timestamp or an older release than an earlier check verified, and keeps it', async () => {
    const verified = await check()
    await writeUpdateCheck(home, PROFILE, { ...verified, timestamp: 5 })
    const older = await check()
    expect(older.failure).toBe('regressed')
    expect(older).toMatchObject({ newest: verified.newest, verified: verified.verified, timestamp: 5 })
    await writeUpdateCheck(home, PROFILE, { ...verified, newest: { ...verified.newest!, delorun: semantic('0.3.0') } })
    const lower = await check()
    expect(lower.failure).toBe('regressed')
    expect(lower.newest?.delorun).toBe('0.3.0')
    await writeUpdateCheck(home, PROFILE, { ...verified, newest: { ...verified.newest!, delorun: semantic('0.3.0'), channel: 'beta' } })
    expect((await check()).failure).toBeUndefined()
    const { timestamp: _timestamp, ...untimed } = verified
    await writeUpdateCheck(home, PROFILE, untimed)
    server.silent = true
    const failed = await check(200)
    expect(failed).toEqual({ ...untimed, checked: failed.checked, failure: 'deadline' })
  })

  it('update-notice-hostile-text: records a code, never the channel\'s text, and logs that text escaped', async () => {
    const hostile = '\u001b]0;owned\u0007\u001b[2J'
    server.files.set('/timestamp.json', envelope({ ...fixture.timestamp, [hostile]: hostile }, [fixture.keys.timestamp]))
    const logged: string[] = []
    const record = await checkForUpdate({ home, profile: PROFILE, platform, running: RUNNING, anchor, timeoutMs: 10_000, now: clock, publication, log: (text) => { logged.push(text) } })
    expect(UPDATE_CHECK_FAILURES).toContain(record.failure)
    expect(readFileSync(updateCheckPath(home, PROFILE), 'utf8')).not.toContain('owned')
    expect(logged).toHaveLength(1)
    expect(logged[0]).not.toMatch(/[\u0000-\u001f\u007f]/u)
    const doctor = await checkUpdate(home, PROFILE, { version: RUNNING, store: true }, () => platform, anchor.root)
    expect(doctor.message).not.toMatch(/[\u0000-\u001f\u007f]|owned/u)
  })

  it('names each failure in Delorun\'s own words, and an unknown error as Delorun\'s own failure', () => {
    for (const failure of UPDATE_CHECK_FAILURES) expect(failureText(failure)).toMatch(/^[ -~]+$/u)
    expect(failureOf(new Error('anything'), false)).toBe('internal')
    expect(failureOf(new Error('anything'), true)).toBe('deadline')
    expect(failureOf(new InstallError('DOWNLOAD_REFUSED', 'http://example.invalid/', 'refused'), false)).toBe('download-refused')
    expect(failureOf(new InstallError('RELEASE_LOG_FAILED', 'bundle', 'refused'), false)).toBe('log-bundle-invalid')
    expect(failureOf(new InstallError('TRUST_STATE_INVALID', 'trust/timestamp.json', 'refused'), false)).toBe('trust-state-invalid')
    expect(failureOf(new InstallError('NO_TRUSTED_ROOT', 'trust/root.json', 'refused'), false)).toBe('trust-state-invalid')
  })

  it('holds a request without a signal of its own to the deadline, and one with a signal to both', async () => {
    const deadline = new AbortController()
    const seen: (AbortSignal | null | undefined)[] = []
    const fetch = withDeadline(async (_input, init) => { seen.push(init?.signal); return new Response('') }, deadline.signal)
    await fetch('http://127.0.0.1/a')
    const own = new AbortController()
    await fetch('http://127.0.0.1/b', { signal: own.signal })
    expect(seen[0]).toBe(deadline.signal)
    deadline.abort()
    expect(seen[1]?.aborted).toBe(true)
  })

  it('goes through the fetch it is given, with its own deadline on each request', async () => {
    const signals: AbortSignal[] = []
    const record = await checkForUpdate({ home, profile: PROFILE, platform, running: RUNNING, anchor, timeoutMs: 10_000, now: clock, publication, fetch: async (input, init) => { signals.push(init!.signal!); return globalThis.fetch(input, init) } })
    expect(record.failure).toBeUndefined()
    expect(signals).toHaveLength(3)
  })
})

describe('the record', () => {
  const valid: UpdateCheckRecord = { schema: UPDATE_CHECK_SCHEMA, checked: brandString<UtcTimestamp>('2027-01-15T08:00:00.000Z'), newest: { delorun: semantic('0.2.0'), dsh: semantic('0.2.3'), channel: 'stable', security: false } }

  it('reads what it wrote, and nothing from a file that is absent, not JSON, not the schema or readable by others', async () => {
    expect(await readUpdateCheck(home, PROFILE)).toBeUndefined()
    await writeUpdateCheck(home, PROFILE, valid)
    expect(await readUpdateCheck(home, PROFILE)).toEqual(valid)
    chmodSync(updateCheckPath(home, PROFILE), 0o644)
    expect(await readUpdateCheck(home, PROFILE)).toBeUndefined()
    writeFileSync(updateCheckPath(home, PROFILE), 'not json', { mode: 0o600 })
    chmodSync(updateCheckPath(home, PROFILE), 0o600)
    expect(await readUpdateCheck(home, PROFILE)).toBeUndefined()
    writeFileSync(updateCheckPath(home, PROFILE), JSON.stringify({ ...valid, schema: 'delorun.update-check/2' }))
    expect(await readUpdateCheck(home, PROFILE)).toBeUndefined()
  })

  it('refuses a recorded summary that would print a control character on the terminal', async () => {
    writeFileSync(updateCheckPath(home, PROFILE), JSON.stringify({ ...valid, newest: { ...valid.newest, summary: 'Run \u001b[2Jthis' } }), { mode: 0o600 })
    expect(await readUpdateCheck(home, PROFILE)).toBeUndefined()
  })
})

describe('what the notice says', () => {
  const running = { delorun: semantic('0.1.0'), dsh: semantic('0.2.2'), channel: 'stable' as const }
  const release = { delorun: semantic('0.1.3'), dsh: semantic('0.2.2'), channel: 'stable' as const, security: true }

  it('names a security fix that keeps every plugin, and a release that moves the base and turns plugins off', () => {
    expect(noticeLine({ running, release, kind: 'patch', disables: 0 })).toBe('Delorun 0.1.3 is available (security fix; all your plugins stay compatible). Run: delorun update')
    expect(noticeLine({ running, release: { ...release, delorun: semantic('0.2.0'), dsh: semantic('0.3.0'), security: false }, kind: 'minor', disables: 2 }))
      .toBe('Delorun 0.2.0 is available (minor release on DSH 0.3.0; it would turn off 2 of your plugins). Run: delorun update')
  })

  it('reads the mark and the summary from a manifest, and their absence as no security fix and no summary', () => {
    expect(checkedReleaseOf(fixture.manifest)).toEqual({ delorun: '0.2.0', dsh: '0.2.3', channel: 'stable', security: true, summary: SUMMARY })
    const { security: _security, summary: _summary, ...older } = fixture.manifest
    expect(checkedReleaseOf(older)).toEqual({ delorun: '0.2.0', dsh: '0.2.3', channel: 'stable', security: false })
  })

  it('reaches the release log the trusted root names', () => {
    const transport = recordedLogTransport({}, fixture.rootMetadata, globalThis.fetch)
    expect(typeof transport.latestCheckpoint).toBe('function')
  })

  it('prints the summary beneath the line when the release has one', () => {
    expect(noticeLines({ running, release, kind: 'patch', disables: 0 })).toHaveLength(1)
    expect(noticeLines({ running, release: { ...release, summary: SUMMARY }, kind: 'patch', disables: 0 })[1]).toBe(`  Release note: ${SUMMARY}`)
  })

  it('says how far a release moves', () => {
    expect(updateKind(semantic('0.1.0'), semantic('1.0.0'))).toBe('major')
    expect(updateKind(semantic('0.1.0'), semantic('1.0.0-rc.1'))).toBe('major')
    expect(updateKind(semantic('0.1.0'), semantic('0.2.0'))).toBe('minor')
    expect(updateKind(semantic('0.1.0'), semantic('0.2.0-rc.1'))).toBe('minor')
    expect(updateKind(semantic('0.1.0'), semantic('0.1.1'))).toBe('patch')
    expect(updateKind(semantic('0.1.0'), semantic('0.1.1-rc.1'))).toBe('patch')
    expect(updateKind(semantic('0.1.0-preview.1'), semantic('0.1.0-preview.2'))).toBe('patch')
    expect(updateKind(semantic('0.1.0-preview.2'), semantic('0.1.0-rc.1'))).toBe('patch')
  })

  it('shows nothing for a release that is not newer than the running one', async () => {
    const record: UpdateCheckRecord = { schema: UPDATE_CHECK_SCHEMA, checked: brandString<UtcTimestamp>('2027-01-15T08:00:00.000Z'), newest: { ...release, delorun: semantic('0.1.0') } }
    expect(await noticeOf(record, running, () => Promise.reject(new Error('not read')))).toBeUndefined()
    expect(await noticeOf(undefined, running, () => Promise.reject(new Error('not read')))).toBeUndefined()
  })
})

describe('in a running Host', { timeout: 60_000 }, () => {
  it('reads the record, checks on demand, and prints each newer version once', async () => {
    const lines: string[] = []
    const source = updateCheckSource({ home, profile: PROFILE, platform, running: RUNNING, anchor, line: (text) => { lines.push(text) }, publication, now: clock })
    expect(await source.read()).toEqual({})
    const state = await source.check(10_000, new AbortController().signal)
    expect(state.checked).toBe(NOW * 1000)
    expect(state.notice?.release.delorun).toBe('0.2.0')
    expect(await source.read()).toEqual(state)
    expect(lines).toEqual(['Delorun 0.2.0 is available (security fix on DSH 0.2.3; it would turn off 1 of your plugins). Run: delorun update'])
  })

  it('attaches the check to the row\'s service, and removes the record when the row is switched off', async () => {
    await check()
    const off = new Context()
    await watchUpdates(off, { home, profile: PROFILE, platform, running: RUNNING, anchor, line: () => {}, publication, now: clock })
    expect(await readUpdateCheck(home, PROFILE)).toBeUndefined()
    await off.fiber.dispose()

    await check()
    const on = new Context()
    await on.plugin(UpdateCheck, { enabled: true, intervalHours: 24, timeoutSeconds: 15 } as never)
    await watchUpdates(on, { home, profile: PROFILE, platform, running: RUNNING, anchor, line: () => {}, publication, now: clock })
    expect((await on.delorunUpdateCheck.notice())?.release.delorun).toBe('0.2.0')
    await on.fiber.dispose()
  })

  it('update-notice-running-release-retried: reads the running release again after a read that failed', async () => {
    await check()
    const source = updateCheckSource({ home, profile: PROFILE, platform, running: RUNNING, anchor, line: () => {}, publication, now: clock })
    const root = join(home, DELORUN_HOME_ENTRIES.trust, TRUST_FILES.root)
    renameSync(root, `${root}.away`)
    try {
      await expect(source.read()).rejects.toThrow()
    } finally {
      renameSync(`${root}.away`, root)
    }
    expect((await source.read()).notice?.release.delorun).toBe('0.2.0')
    await writeUpdateCheck(home, PROFILE, { ...(await readUpdateCheck(home, PROFILE))!, failure: 'unreachable' })
    expect(await source.read()).toMatchObject({ failed: true, notice: { release: { delorun: '0.2.0' } } })
  })

  it('update-notice-record-unremovable: a record that cannot be removed is logged and the start goes on', async () => {
    rmSync(updateCheckPath(home, PROFILE), { force: true })
    mkdirSync(join(updateCheckPath(home, PROFILE), 'inside'), { recursive: true })
    const logged: string[] = []
    const off = new Context()
    try {
      await watchUpdates(off, { home, profile: PROFILE, platform, running: RUNNING, anchor, line: () => {}, publication, now: clock, log: (text) => { logged.push(text) } })
      expect(logged).toEqual([expect.stringMatching(/^delorun-update-check: the update check's record could not be removed: /u)])
      await watchUpdates(off, { home, profile: PROFILE, platform, running: RUNNING, anchor, line: () => {}, publication, now: clock })
    } finally {
      await off.fiber.dispose()
      rmSync(updateCheckPath(home, PROFILE), { recursive: true, force: true })
    }
  })

  it('gives a background start the recorded line, and nothing when the running release cannot be read', async () => {
    expect(await recordedNoticeLine(home, PROFILE, platform, RUNNING, anchor.root)).toBeUndefined()
    await check()
    expect(await recordedNoticeLine(home, PROFILE, platform, RUNNING, anchor.root)).toBe('Delorun 0.2.0 is available (security fix on DSH 0.2.3; it would turn off 1 of your plugins). Run: delorun update')
    expect(await recordedNoticeLine(home, PROFILE, platform, brandString<RuntimeVersion>('9.9.9'), anchor.root)).toBeUndefined()
    expect(await startNoticeLine(home, PROFILE, launched, join(home, 'runtimes', '0.1.0', 'app', 'start.js'))).toContain('Delorun 0.2.0 is available')
    expect(await startNoticeLine(home, PROFILE, launched)).toBeUndefined()
  })
})

describe('delorun update --check and delorun doctor', { timeout: 60_000 }, () => {
  const output = { stdout: '', stderr: '' }
  const context = () => ({ env: { ...process.env, ...launched, DELORUN_HOME: home, DELORUN_PROFILE: PROFILE }, stdout: (text: string) => { output.stdout += text }, stderr: (text: string) => { output.stderr += text } })
  const noPrompts = { confirm: () => Promise.reject(new Error('asked')), copy: () => Promise.reject(new Error('asked')), agree: () => Promise.reject(new Error('asked')) }

  beforeEach(() => {
    output.stdout = ''
    output.stderr = ''
  })

  /**
   * Run `delorun update` with the stand-in publication.
   * @param args - the arguments.
   * @param store - whether this Delorun runs from the store.
   * @param version - the version it runs.
   * @returns the exit code.
   */
  async function update(args: readonly string[], store = true, version = RUNNING): Promise<number | undefined> {
    const checks: UpdateCheckDependencies = { runtime: () => ({ version, store }), check: { now: clock, publication } }
    return runUpdate(args, context(), noPrompts, checks)
  }

  it('prints the notice and the summary, and starts no home process', async () => {
    expect(await update(['--check'])).toBe(EXIT.ok)
    expect(output.stdout).toBe(`● Delorun 0.2.0 is available (security fix on DSH 0.2.3; it would turn off 1 of your plugins). Run: delorun update\n  Release note: ${SUMMARY}\n  delorun update --report  see what changes\n  delorun update           install it\n`)
  })

  it('says the running release is the newest when the channel names it, and prints no summary a manifest lacks', async () => {
    expect(await update(['--check'], true, NEWEST)).toBe(EXIT.ok)
    expect(output.stdout).toBe('✓ Up to date · 0.2.0 (newest on the stable channel)\n')
    await writeUpdateCheck(home, PROFILE, { schema: UPDATE_CHECK_SCHEMA, checked: brandString<UtcTimestamp>('2027-01-15T08:00:00.000Z'), newest: { delorun: semantic('0.2.0'), dsh: semantic('0.2.3'), channel: 'stable', security: false } })
    const lines: string[] = []
    await updateCheckSource({ home, profile: PROFILE, platform, running: RUNNING, anchor, line: (text) => { lines.push(text) } }).read()
    expect(lines).toEqual(['Delorun 0.2.0 is available (minor release on DSH 0.2.3; it would turn off 1 of your plugins). Run: delorun update'])
  })

  it('exits 1 naming the failure, and refuses outside the store and with --yes', async () => {
    server.files.delete('/timestamp.json')
    expect(await update(['--check'])).toBe(EXIT.failed)
    expect(output.stderr).toBe('delorun update --check: the check failed, so nothing is known about a newer release: the release host did not answer, answered with an error, or sent a file larger than its limit\n')
    expect(await update(['--check'], false)).toBe(EXIT.failed)
    expect(output.stderr).toContain("This is a source build, so it doesn't update itself. Install Delorun with: npx delorun")
    output.stderr = ''
    expect(await update(['--report'], false)).toBe(EXIT.failed)
    expect(output.stderr).toBe("This is a source build, so it doesn't update itself. Install Delorun with: npx delorun\n")
    await expect(update(['--check', '--yes'])).rejects.toMatchObject({ exit: EXIT.usage })
    await expect(update(['--check', '--no-data-copy'])).rejects.toMatchObject({ exit: EXIT.usage })
    expect(await updateCommand.run(['--check'], context())).toBe(EXIT.failed)
  })

  it('reports the last check in delorun doctor', async () => {
    const store = { version: RUNNING, store: true }
    expect(await checkUpdate(home, PROFILE, { ...store, store: false }, () => platform, anchor.root)).toMatchObject({ status: 'pass', message: expect.stringContaining('is a source build') })
    expect(await checkUpdate(home, PROFILE, store, () => platform, anchor.root)).toMatchObject({ status: 'pass', message: expect.stringContaining('no update check is recorded') })
    await check()
    expect(await checkUpdate(home, PROFILE, store, () => platform, anchor.root)).toMatchObject({ status: 'warn', message: expect.stringContaining('Delorun 0.2.0 is available') })
    server.silent = true
    await check(200)
    expect(await checkUpdate(home, PROFILE, store, () => platform, anchor.root)).toMatchObject({ status: 'warn', message: expect.stringContaining('failed, so the studio shows no notice: the check took longer than its deadline.') })
    await writeUpdateCheck(home, PROFILE, { schema: UPDATE_CHECK_SCHEMA, checked: brandString<UtcTimestamp>('2027-01-15T08:00:00.000Z'), newest: { delorun: semantic('0.1.0'), dsh: semantic('0.2.2'), channel: 'stable', security: false } })
    expect(await checkUpdate(home, PROFILE, store, () => platform, anchor.root)).toMatchObject({ status: 'pass', message: 'Delorun 0.1.0 is the newest release on the stable channel (checked 2027-01-15T08:00:00.000Z).' })
  })
})
