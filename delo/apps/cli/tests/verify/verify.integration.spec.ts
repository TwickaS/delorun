/**
 * `delorun verify` against a home with a release installed through the runtime store (contracts C2, C15 and C18): one
 * line per registered check, the release-log state recorded under `trust/`, exit 0 when nothing failed, and exit 1
 * naming the check for each verifiable fault: a changed runtime file, a manifest whose signature does not verify, a
 * stale timestamp, a bundle of another release, a log that contradicts the stored checkpoint and a missing bundle. A log
 * that cannot be reached leaves the check not run, with the warning that names the release, and exits 0. Every log
 * answer comes from the fixture's `fetch`.
 */
import { generateKeyPairSync } from 'node:crypto'
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DELO_HOME_ENTRIES, TRUST_FILES } from '@delo/contract-home-layout'
import { VERIFICATION_CHECK_IDS, VERIFICATION_DETAIL_MAX_LENGTH, VERIFICATION_NOTICE } from '@delo/contract-verification-checks'
import { writeChannelRecord } from '@delo/install'
import { publicKeyEntry, signEnvelope } from '@delo/release-formats/sign/envelope'
import { toJsonValue } from '@delo/release-formats/sign/json'
import { checkStatePath, checkpointPath, serializeStoredCheckpoint, storedCheckpoint } from '@delo/release-verify'
import { CliError, EXIT } from '../../src/exit.ts'
import { main } from '../../src/main.ts'
import { boundedDetail, durationText, utcText } from '../../src/verify/checks.ts'
import { createVerifyCommand, reportLines, stderrLogger, type VerifyEnvironment } from '../../src/verify/index.ts'
import { installedHome, makeWritable, NOW, PLATFORM, RELEASE, timestampFile, writeTrustFile, type InstalledHome } from './fixtures.ts'

const homes: string[] = []

afterEach(() => {
  for (const home of homes.splice(0)) {
    makeWritable(dirname(home))
    rmSync(dirname(home), { recursive: true, force: true })
  }
})

/**
 * A fixture home, removed after the spec.
 * @returns the home.
 */
async function home(): Promise<InstalledHome> {
  const fixture = await installedHome()
  homes.push(fixture.home)
  return fixture
}

/** What one run printed and returned. */
interface Run {
  readonly exit: number | undefined
  readonly stdout: string
  readonly stderr: string
}

/**
 * Run `delorun verify` over a fixture home.
 * @param fixture - the home.
 * @param args - the arguments after `verify`.
 * @param environment - fields of the environment to replace.
 * @returns the exit code and the output.
 */
async function verify(fixture: InstalledHome, args: readonly string[] = [], environment: Partial<VerifyEnvironment> = {}, env: Record<string, string | undefined> = { DELO_LAUNCHER_ROOTS: fixture.launcherRoots }): Promise<Run> {
  let stdout = ''
  let stderr = ''
  const command = createVerifyCommand({ fetch: fixture.tiles.fetch, now: () => NOW, platform: PLATFORM, running: () => RELEASE, ...environment })
  const exit = await command.run(args, { env: { DELO_HOME: fixture.home, ...env }, stdout: (text) => { stdout += text }, stderr: (text) => { stderr += text } })
  return { exit, stdout, stderr }
}

/**
 * The line a run printed for one check.
 * @param run - the run.
 * @param id - the check.
 * @returns the line.
 * @throws Error when the run printed none.
 */
function line(run: Run, id: string): string {
  const found = run.stdout.split('\n').find(text => new RegExp(`^\\S+(?: \\S+)?\\s+${id}\\s`, 'u').test(text))
  if (found === undefined) throw new Error(`no line for ${id} in:\n${run.stdout}`)
  return found
}

/**
 * The recorded release-log state of the fixture release.
 * @param fixture - the home.
 * @returns the record.
 */
function recorded(fixture: InstalledHome): { readonly state: string, readonly refusal?: string } {
  return (JSON.parse(readFileSync(checkStatePath(fixture.home), 'utf8')) as { releases: Record<string, { state: string, refusal?: string }> }).releases[RELEASE]!
}

/**
 * Make an installed file and its directory writable, as a program with the person's access can.
 * @param path - the file.
 */
function writable(path: string): void {
  makeWritable(dirname(path))
}

describe('a release that verifies', { timeout: 30_000 }, () => {
  it('passes both release checks, lists every other check as not run, records `verified` and exits 0', async () => {
    const fixture = await home()
    const run = await verify(fixture)
    expect(run.exit).toBe(EXIT.ok)
    expect(run.stderr).toBe('')
    const lines = run.stdout.split('\n')
    expect(lines[0]).toBe(`Release ${RELEASE}, verification mode warn; checks run as your user.`)
    expect(lines[1]).toMatch(/^Trusted root: version 1, root keys [0-9a-f]{16}, anchored on the shipped roots of the launcher that started this Delorun, in \S+ \(DELO_LAUNCHER_ROOTS\)\.$/u)
    expect(lines[1]).toContain(` in ${fixture.launcherRoots} (`)
    expect(lines[2]).toBe('Release channel: production; release log: production; as the launcher that installed this Delorun recorded them.')
    expect(lines[3]).toBe(`Launcher: the launcher that started this Delorun reported no version (DELO_LAUNCHER_VERSION), so it is not compared with the npm packages release ${RELEASE} lists.`)
    expect(lines.at(-2)).toBe('2 checks passed, 0 failed, 0 not run; this is not a full verification of this Delorun.')
    expect(line(run, 'release-signature')).toMatch(/^passed\s+release-signature\s+trusted root 1 is anchored on the launcher's shipped roots; trusted root 1 is valid until 2027-10-01T00:00:00Z; the manifest's targets signature verifies; the stored timestamp is fresh; the release-log entry verifies and the log is consistent with the stored checkpoint$/u)
    expect(line(run, 'runtime-files')).toMatch(/^passed\s+runtime-files\s+all 5 files of runtime 0\.1\.0 match the signed file list$/u)
    expect(lines.at(-3)).toBe('Delorun does not include 9 more checks.')
    for (const id of VERIFICATION_CHECK_IDS.filter(id => id !== 'release-signature' && id !== 'runtime-files')) expect(run.stdout).not.toContain(id)
    expect(recorded(fixture).state).toBe('verified')
    expect(JSON.parse(readFileSync(checkpointPath(fixture.home), 'utf8'))).toMatchObject({ treeSize: 3, rootHash: fixture.log.rootHash.toString('hex') })
    expect(fixture.tiles.requested).toEqual([`${fixture.tiles.prefix}/checkpoint`])
  })

  it('prints contract C15\'s report with --json, naming the release', async () => {
    const fixture = await home()
    const run = await verify(fixture, ['--json'])
    expect(run.exit).toBe(EXIT.ok)
    const report = JSON.parse(run.stdout) as Record<string, unknown> & { checks: { id: string, result: string }[] }
    expect(report).toMatchObject({ schemaVersion: 1, mode: 'warn', stage: 'verify', notice: VERIFICATION_NOTICE, badge: 'not-green', release: RELEASE, generatedAt: new Date(NOW * 1000).toISOString().replace('.000Z', 'Z') })
    expect(report.checks.map(check => check.id)).toEqual([...VERIFICATION_CHECK_IDS])
    expect(report.checks.slice(0, 2).map(check => check.result)).toEqual(['pass', 'pass'])
    expect(report.root).toMatchObject({ anchored: 'shipped', rootsDirectory: fixture.launcherRoots })
    expect(report.origins).toEqual({ channel: 'production', log: 'production' })
  })

  it('reads the release log at the origin the installing launcher recorded, not the one the root names', async () => {
    const fixture = await home()
    await writeChannelRecord(fixture.home, { logOrigin: 'http://127.0.0.1:9' })
    const run = await verify(fixture)
    expect(fixture.tiles.requested).toEqual(['http://127.0.0.1:9/checkpoint'])
    expect(line(run, 'release-signature')).toContain('the online check could not complete')
    expect(run.stdout).toContain('Release channel: production; release log: http://127.0.0.1:9; as the launcher that installed this Delorun recorded them.')
  })

  it('says where releases come from is unknown, with a warning, when the channel record does not read', async () => {
    const fixture = await home()
    writeTrustFile(fixture.home, TRUST_FILES.channel, Buffer.from('{"v":1,"channelOrigin":"ftp://192.0.2.1"}\n'))
    const run = await verify(fixture, ['--offline'])
    expect(run.exit).toBe(EXIT.ok)
    expect(run.stdout).toContain('Release channel: unknown, because the home\'s channel record does not read.')
    expect(run.stderr).toContain('warning: the home\'s channel record does not read, so where its releases come from is unknown')
  })

  it('checks a release named with --release', async () => {
    const fixture = await home()
    const run = await verify(fixture, ['--release', RELEASE], { running: () => '9.9.9' })
    expect(run.exit).toBe(EXIT.ok)
  })
})

describe('a release log that is not reached', { timeout: 30_000 }, () => {
  it('runs no online check with --offline: not run, the warning naming the release, `unchecked` recorded, exit 0', async () => {
    const fixture = await home()
    const run = await verify(fixture, ['--offline'])
    expect(run.exit).toBe(EXIT.ok)
    expect(line(run, 'release-signature')).toMatch(/^not run\s+release-signature\s+the release-log bundle verifies offline; the online check was not run \(--offline\)$/u)
    expect(run.stderr).toBe(`warning: Release ${RELEASE} has not been checked against the release log; Delorun checks it at the next connection. It has stayed unchecked since ${utcText(NOW)} (under a minute); the online check was not run (--offline).\n`)
    expect(fixture.tiles.requested).toEqual([])
    expect(recorded(fixture).state).toBe('unchecked')
  })

  it('reports an unreachable log as not run with its reason and the warning, and exits 0', async () => {
    const fixture = await home()
    fixture.tiles.answers.set(`${fixture.tiles.prefix}/checkpoint`, () => new Response('down', { status: 503 }))
    const run = await verify(fixture)
    expect(run.exit).toBe(EXIT.ok)
    expect(line(run, 'release-signature')).toContain('the online check could not complete: the release log gave no checkpoint')
    expect(line(run, 'release-signature')).toContain('answered 503')
    expect(run.stderr).toContain(`warning: Release ${RELEASE} has not been checked`)
    expect(line(run, 'runtime-files')).toMatch(/^passed/u)
  })
})

describe('a checkpoint the witnesses have not cosigned', { timeout: 30_000 }, () => {
  it('leaves release-signature not run with the warning, and exits 0', async () => {
    const fixture = await home()
    fixture.tiles.note = fixture.log.checkpoint()
    const run = await verify(fixture)
    expect(run.exit).toBe(EXIT.ok)
    expect(line(run, 'release-signature')).toMatch(/^not run\s+release-signature\s+the release-log bundle verifies offline; the online check could not complete: the latest checkpoint has 0 of the 1 witness cosignatures a check needs$/u)
    expect(run.stderr).toContain(`warning: Release ${RELEASE} has not been checked`)
  })
})

describe('a verifiable fault fails the run, naming the check', { timeout: 30_000 }, () => {
  it('fails runtime-files for a changed runtime file', async () => {
    const fixture = await home()
    const path = join(fixture.home, 'runtimes', RELEASE, 'app', 'node_modules', '@delo', 'cli', 'src', 'bin.js')
    writable(path)
    writeFileSync(path, 'console.log("changed")\n')
    const run = await verify(fixture)
    expect(run.exit).toBe(EXIT.failed)
    expect(line(run, 'runtime-files')).toMatch(/^failed\s+runtime-files\s+RUNTIME_CHANGED: runtime 0\.1\.0 differs from its signed file list: .*app\/node_modules\/@delo\/cli\/src\/bin\.js/u)
    expect(line(run, 'release-signature')).toMatch(/^passed/u)
  })

  it('fails release-signature for a manifest whose signature does not verify, and leaves the files unchecked', async () => {
    const fixture = await home()
    const path = join(fixture.home, 'runtimes', `delorun-${RELEASE}.manifest.json`)
    writable(path)
    writeFileSync(path, readFileSync(path, 'utf8').replace('"channel": "stable"', '"channel": "beta"'))
    const run = await verify(fixture)
    expect(run.exit).toBe(EXIT.failed)
    expect(line(run, 'release-signature')).toMatch(/^failed\s+release-signature\s+the manifest of release 0\.1\.0 does not verify with the trusted root: /u)
    expect(line(run, 'runtime-files')).toMatch(/^not run\s+runtime-files\s+not checked, because the signed manifest did not verify$/u)
    expect(fixture.tiles.requested).toEqual([])
  })

  it('fails release-signature for a stale timestamp', async () => {
    const fixture = await home()
    writeTrustFile(fixture.home, TRUST_FILES.timestamp, timestampFile(fixture, NOW - 4 * 86_400))
    const run = await verify(fixture)
    expect(run.exit).toBe(EXIT.failed)
    expect(line(run, 'release-signature')).toMatch(/^failed\s+release-signature\s+the stored timestamp is not fresh: timestamp 1 expired at /u)
  })

  it('fails release-signature for a bundle of another release', async () => {
    const fixture = await home()
    const path = join(fixture.home, 'runtimes', `delorun-${RELEASE}.manifest.log.json`)
    writable(path)
    const bundle = JSON.parse(readFileSync(path, 'utf8')) as { manifest: { name: string } }
    writeFileSync(path, JSON.stringify({ ...bundle, manifest: { ...bundle.manifest, name: 'delorun-0.2.0.manifest.json' } }))
    const run = await verify(fixture)
    expect(run.exit).toBe(EXIT.failed)
    expect(line(run, 'release-signature')).toMatch(/^failed\s+release-signature\s+the release log refused it \(manifest-digest-mismatch\): /u)
    expect(recorded(fixture)).toMatchObject({ state: 'failed', refusal: 'manifest-digest-mismatch' })
  })

  it('fails release-signature when the log contradicts the stored checkpoint', async () => {
    const fixture = await home()
    // The client stored a tree of 9 the log signed; the log now serves a tree of 3.
    const stored = storedCheckpoint(fixture.log.origin, 9, Buffer.alloc(32, 3), fixture.log.note(9, Buffer.alloc(32, 3)), NOW - 600)
    writeTrustFile(fixture.home, TRUST_FILES.checkpoint, Buffer.from(serializeStoredCheckpoint(stored)))
    const run = await verify(fixture)
    expect(run.exit).toBe(EXIT.failed)
    expect(line(run, 'release-signature')).toMatch(/^failed\s+release-signature\s+the release log refused it \(checkpoint-rolled-back\): /u)
    expect(recorded(fixture)).toMatchObject({ state: 'failed', refusal: 'checkpoint-rolled-back' })
  })

  it('fails release-signature when a tile the log serves breaks consistency with the stored checkpoint', async () => {
    const fixture = await home()
    fixture.log.append(Buffer.from('one more entry'))
    fixture.tiles.size = 4
    fixture.tiles.note = fixture.witness.cosign(fixture.log.checkpoint(), NOW - 30)
    fixture.tiles.answers.set(`${fixture.tiles.prefix}/tile/0/000.p/4`, () => new Response(Buffer.alloc(4 * 32, 9)))
    const run = await verify(fixture)
    expect(run.exit).toBe(EXIT.failed)
    expect(line(run, 'release-signature')).toContain('(consistency-proof-invalid)')
  })

  it('fails release-signature for a missing bundle, which also stops a start', async () => {
    const fixture = await home()
    const path = join(fixture.home, 'runtimes', `delorun-${RELEASE}.manifest.log.json`)
    writable(path)
    rmSync(path)
    const run = await verify(fixture)
    expect(run.exit).toBe(EXIT.failed)
    expect(line(run, 'release-signature')).toContain(`no release-log bundle is stored for release ${RELEASE} at ${path}`)
  })

  it('names every failed part of release-signature on its line', async () => {
    const fixture = await home()
    writeTrustFile(fixture.home, TRUST_FILES.timestamp, timestampFile(fixture, NOW - 4 * 86_400))
    const path = join(fixture.home, 'runtimes', `delorun-${RELEASE}.manifest.log.json`)
    writable(path)
    rmSync(path)
    const text = line(await verify(fixture), 'release-signature')
    expect(text).toContain('no release-log bundle is stored')
    expect(text).toContain('the stored timestamp is not fresh')
  })
})

describe('what the checks cannot read', { timeout: 30_000 }, () => {
  it('fails release-signature for a release that is not installed', async () => {
    const fixture = await home()
    const run = await verify(fixture, ['--release', '0.9.0'])
    expect(run.exit).toBe(EXIT.failed)
    expect(line(run, 'release-signature')).toContain(`release 0.9.0 is not installed: ${join(fixture.home, 'runtimes', 'delorun-0.9.0.manifest.json')} is missing`)
  })

  it('fails release-signature for a stored manifest of another release, an unreadable one and an oversized one', async () => {
    const fixture = await home()
    const runtimes = join(fixture.home, 'runtimes')
    writeFileSync(join(runtimes, 'delorun-0.2.0.manifest.json'), readFileSync(join(runtimes, `delorun-${RELEASE}.manifest.json`)))
    expect(line(await verify(fixture, ['--release', '0.2.0']), 'release-signature')).toContain('the stored manifest is release 0.1.0, not 0.2.0')
    mkdirSync(join(runtimes, 'delorun-0.3.0.manifest.json'))
    expect(line(await verify(fixture, ['--release', '0.3.0']), 'release-signature')).toContain('cannot be read: EISDIR')
    writeFileSync(join(runtimes, 'delorun-0.4.0.manifest.json'), Buffer.alloc(1024 * 1024 + 1))
    expect(line(await verify(fixture, ['--release', '0.4.0']), 'release-signature')).toContain('is above its size limit')
  })

  it('fails release-signature without a trusted root, and leaves the files unchecked', async () => {
    const fixture = await home()
    rmSync(join(fixture.home, DELO_HOME_ENTRIES.trust, TRUST_FILES.root))
    const run = await verify(fixture)
    expect(run.exit).toBe(EXIT.failed)
    expect(line(run, 'release-signature')).toContain('/trust/root.json does not read')
    expect(line(run, 'runtime-files')).toMatch(/^not run\s+runtime-files\s+not checked, because no trusted root reads$/u)
    // The report names no root and no release-log record, as the run anchored and recorded nothing.
    const json = await verify(fixture, ['--json'])
    expect(JSON.parse(json.stdout)).toMatchObject({ root: null, releaseLog: null })
  })

  it('fails release-signature without a stored timestamp, or with one other users can read', async () => {
    const fixture = await home()
    const path = join(fixture.home, DELO_HOME_ENTRIES.trust, TRUST_FILES.timestamp)
    chmodSync(path, 0o644)
    expect(line(await verify(fixture), 'release-signature')).toContain('the stored timestamp cannot be read: SECRET_FILE_MODE')
    rmSync(path)
    expect(line(await verify(fixture), 'release-signature')).toContain(`no timestamp is stored at ${path}`)
  })

  it('fails release-signature when the release-log records cannot be read or the bundle is not a file', async () => {
    const fixture = await home()
    writeTrustFile(fixture.home, TRUST_FILES.checkpoint, Buffer.from('{}'))
    chmodSync(checkpointPath(fixture.home), 0o644)
    expect(line(await verify(fixture), 'release-signature')).toContain('the release-log check could not run: SECRET_FILE_MODE')
    rmSync(checkpointPath(fixture.home))
    const path = join(fixture.home, 'runtimes', `delorun-${RELEASE}.manifest.log.json`)
    writable(path)
    rmSync(path)
    mkdirSync(path)
    expect(line(await verify(fixture), 'release-signature')).toContain('the release-log check could not run: EISDIR')
  })

  it('fails both release checks on a platform Delorun publishes no runtime for', async () => {
    const fixture = await home()
    const run = await verify(fixture, [], { platform: 'freebsd-x64' })
    expect(run.exit).toBe(EXIT.failed)
    expect(line(run, 'release-signature')).toContain('Delorun publishes no runtime for freebsd-x64')
    expect(line(run, 'runtime-files')).toContain('Delorun publishes no runtime for freebsd-x64')
  })
})

describe('the command line', { timeout: 30_000 }, () => {
  it('refuses a release name that is not a version, and an unknown option', async () => {
    const fixture = await home()
    await expect(verify(fixture, ['--release', '../0.1.0'])).rejects.toMatchObject({ exit: EXIT.usage })
    await expect(verify(fixture, ['--release', '../0.1.0'])).rejects.toBeInstanceOf(CliError)
    await expect(verify(fixture, ['--mystery'])).rejects.toMatchObject({ exit: EXIT.usage })
  })

  it('is a delorun command that checks the running release', async () => {
    const fixture = await home()
    let stdout = ''
    const exit = await main(['verify', '--offline'], { env: { DELO_HOME: fixture.home, DELO_LAUNCHER_ROOTS: fixture.launcherRoots }, stdout: (text) => { stdout += text }, stderr: () => undefined })
    // The running release is this checkout's, which is not installed in the fixture home.
    expect(exit).toBe(EXIT.failed)
    expect(stdout).toMatch(/^Release \S+, verification mode warn;/u)
    expect(stdout).toContain('is not installed')
  })
})

describe('the report', () => {
  it('cuts a detail to contract C15\'s limit', () => {
    expect(boundedDetail('short')).toBe('short')
    const long = boundedDetail('x'.repeat(VERIFICATION_DETAIL_MAX_LENGTH + 10))
    expect(long).toHaveLength(VERIFICATION_DETAIL_MAX_LENGTH)
    expect(long.endsWith('…')).toBe(true)
  })

  it('labels a result the machine cannot enforce', () => {
    const text = reportLines(RELEASE, { results: [{ id: 'confinement-rule', result: 'not-enforced', detail: 'the dialect cannot deny it' }], root: undefined, origins: undefined, launcher: undefined })
    expect(text).toContain('not enforced  confinement-rule  the dialect cannot deny it')
    expect(text).toContain('Trusted root: none read.')
    expect(text).toContain('Release channel: unknown, because the home\'s channel record does not read.')
    expect(text).toContain('0 checks passed, 0 failed, 0 not run, 1 not enforced; this is not a full verification of this Delorun.')
  })
})

describe('the runtime store\'s logger', () => {
  it('writes warnings and errors to standard error, and nothing else', () => {
    let stderr = ''
    let stdout = ''
    const logger = stderrLogger({ stdout: (text) => { stdout += text }, stderr: (text) => { stderr += text } })
    logger.error('an error')
    logger.warn('a warning')
    logger.info('information')
    logger.debug('detail')
    expect(stderr).toBe('an error\na warning\n')
    expect(stdout).toBe('')
  })
})

describe('the trusted root a run anchors on', { timeout: 30_000 }, () => {
  it('names the root keys of the root it anchored on: the newest shipped root, not an older stored one', async () => {
    const fixture = await home()
    const newRootKey = generateKeyPairSync('ed25519').privateKey
    const entry = publicKeyEntry(newRootKey)
    // Root 2 rotates the root key and keeps every other role, signed by both root keys.
    const second = { ...fixture.root, version: 2, keys: { ...fixture.root.keys, [entry.keyid]: entry.entry }, roles: { ...fixture.root.roles, root: { keyids: [entry.keyid], threshold: 1 } } }
    const secondBytes = Buffer.from(`${JSON.stringify(signEnvelope({ signed: toJsonValue(second), signatures: [] }, [fixture.keys.root, newRootKey]), undefined, 2)}\n`)
    writeFileSync(join(fixture.launcherRoots, '2.root.json'), secondBytes)
    const run = await verify(fixture)
    expect(run.stdout).toContain(`Trusted root: version 2, root keys ${String(entry.keyid).slice(0, 16)}, anchored on the shipped roots`)
  })

  it('holds a root to its own signatures only without the launcher\'s roots, and does not call that a pass', async () => {
    const fixture = await home()
    const run = await verify(fixture, [], {}, {})
    expect(run.exit).toBe(EXIT.failed)
    expect(run.stdout).toContain('Trusted root: version 1, root keys')
    expect(run.stdout).toContain('anchored on the stored root only.')
    expect(line(run, 'release-signature')).toMatch(/^not run\s+release-signature\s+trusted root 1 is checked against its own signatures only, because the launcher that started this runtime named no shipped roots$/u)
    expect(run.stderr).toContain('warning: the trusted root was anchored on the stored root only')
    const unreadable = await verify(fixture, [], {}, { DELO_LAUNCHER_ROOTS: join(fixture.launcherRoots, 'missing') })
    expect(line(unreadable, 'release-signature')).toContain('the launcher\'s roots at')
    rmSync(join(fixture.launcherRoots, '1.root.json'))
    writeFileSync(join(fixture.launcherRoots, 'README'), 'not a root')
    expect(line(await verify(fixture), 'release-signature')).toContain('holds no <n>.root.json file')
  })

  it('fails a stored root that the launcher\'s shipped roots do not lead to, though it signs itself and everything else', async () => {
    const fixture = await home()
    // Another self-signed root under the launcher's roots: the home's root, re-signed releases and all, is not it.
    const other = await installedHome()
    homes.push(other.home)
    writeFileSync(join(fixture.launcherRoots, '1.root.json'), other.rootBytes)
    const run = await verify(fixture)
    expect(run.exit).toBe(EXIT.failed)
    expect(line(run, 'release-signature')).toContain('is not one the launcher\'s shipped roots lead to')
    expect(line(run, 'runtime-files')).toMatch(/^not run/u)
  })

  it('fails a root past its expiry, naming the expiry and the local clock', async () => {
    const fixture = await home()
    const later = Date.parse('2027-10-02T00:00:00Z') / 1000
    const run = await verify(fixture, ['--offline'], { now: () => later })
    expect(run.exit).toBe(EXIT.failed)
    expect(line(run, 'release-signature')).toContain('trusted root 1 expired at 2027-10-01T00:00:00Z; this machine\'s clock reads 2027-10-02T00:00:00Z')
  })
})

describe('how long the release has not been checked against the log', { timeout: 30_000 }, () => {
  it('says since when the release has stayed unchecked, across runs, and records it for doctor and status', async () => {
    const fixture = await home()
    fixture.tiles.answers.set(`${fixture.tiles.prefix}/checkpoint`, () => new Response('down', { status: 503 }))
    await verify(fixture)
    const later = await verify(fixture, [], { now: () => NOW + 3 * 3600 })
    expect(later.exit).toBe(EXIT.ok)
    expect(later.stderr).toContain(`It has stayed unchecked since ${utcText(NOW)} (3 hours)`)
    const state = JSON.parse(readFileSync(checkStatePath(fixture.home), 'utf8')) as { releases: Record<string, { uncheckedSince: number, detail: string }> }
    expect(state.releases[RELEASE]).toMatchObject({ uncheckedSince: NOW, detail: expect.stringContaining('answered 503') })
    const json = JSON.parse((await verify(fixture, ['--json'], { now: () => NOW + 3 * 3600 })).stdout) as { releaseLog: { uncheckedSince: number }, root: { anchored: string } }
    expect(json.releaseLog.uncheckedSince).toBe(NOW)
    expect(json.root.anchored).toBe('shipped')
  })

  it('names durations in the largest whole unit', () => {
    expect(durationText(30)).toBe('under a minute')
    expect(durationText(60)).toBe('1 minute')
    expect(durationText(7200)).toBe('2 hours')
    expect(durationText(86_400)).toBe('1 day')
  })

  it('prints what the check noticed, such as a stored checkpoint that does not read', async () => {
    const fixture = await home()
    writeTrustFile(fixture.home, TRUST_FILES.checkpoint, Buffer.from('not a record'))
    const run = await verify(fixture)
    expect(run.exit).toBe(EXIT.ok)
    expect(run.stderr).toContain('notice: the stored checkpoint does not read')
  })
})
