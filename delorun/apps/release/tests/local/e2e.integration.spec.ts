/**
 * The installable path end to end, on throwaway keys and local servers only: `local-release.ts` signs a release into a
 * channel directory, a server in the spec serves it, the launcher is built with the spec's root and that server as its
 * channel origin and packed, and `npm exec` runs the tarball the way `npx` does. The launcher's log origin is a closed
 * port, so the install continues on the signature, prints the warning and records that the log check did not run.
 *
 * The runtime in the release is a fixture: its Node is a script that hands over to the Node running the spec, and its
 * `delorun` entry file prints the version its package carries. The spec shows that the launcher installs, verifies and
 * starts the runtime that launch protocol 1 names and that the version stamped by the release build reaches it; it does
 * not start the Host, which `tests/closure/boot.closure.integration.spec.ts` does for a closure built from the real tree.
 */
import { execFile, execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { describe, expect, it, type TestContext } from 'vitest'
import { buildLauncher } from '../../../npm-launcher/src/build.ts'
import { copyClosureFiles } from '../../src/local/release.ts'
import { scratch } from '../support.ts'
import { LogStandIn } from '../log/standin.ts'
import { closedPort, fixtureClosure, keyFile, runEntryAsync, serveChannel, serveLog, trust, type Trust } from './support.ts'

/** The progress lines for an install that could not reach the log. */
const VERSION = '0.1.0'

/** What a release served from a channel directory needs. */
interface Served {
  readonly directory: string
  readonly channel: string
  readonly origin: string
  readonly rootPath: string
  readonly trusted: Trust
}

/**
 * Build version 0.1.0 with `local-release.ts` into a channel directory and serve it.
 * @param test - the running test.
 * @returns the served channel.
 */
async function servedRelease(test: TestContext, closureFiles?: string): Promise<Served> {
  const directory = scratch(test)
  // An installed runtime is read-only (contract C1), so the home is made writable again before the directory is removed.
  test.onTestFinished(() => { execFileSync('chmod', ['-R', 'u+rwX', directory], { timeout: 30_000 }) })
  const trusted = trust()
  const log = await serveLog(test, trusted)
  const closures = join(directory, 'closures')
  mkdirSync(closures)
  if (closureFiles === undefined) await fixtureClosure(test, VERSION)(closures)
  else await copyClosureFiles(closureFiles, VERSION, ['linux-x64'], closures)
  const rootPath = join(directory, 'root.json')
  writeFileSync(rootPath, trusted.root)
  const channel = join(directory, 'channel')
  const built = await runEntryAsync('local-release.ts', [
    '--version', VERSION, '--summary', 'A local fixture release.', '--out', channel, '--root', rootPath,
    '--targets-key', keyFile(directory, 'targets.pem', trusted.keys.targets),
    '--timestamp-key', keyFile(directory, 'timestamp.pem', trusted.keys.timestamp),
    '--state', join(directory, 'state.json'),
    '--log-submit', log.endpoints.submit, '--log-checkpoint', log.endpoints.checkpoint, '--log-tiles', log.endpoints.tiles,
    '--closures-from', closures, '--allow-builder-paths',
  ])
  // The fixture closure names this process's Node, so the allowed builder paths print their warning and nothing else.
  expect(built.stderr.replaceAll(/^warning: the closure files name the building user's paths.*\n/gmu, '')).toBe('')
  expect(built.status).toBe(0)
  return { directory, channel, origin: await serveChannel(test, channel), rootPath, trusted }
}

/** A finished child process. */
interface Finished {
  readonly status: number | null
  readonly stdout: string
  readonly stderr: string
}

/**
 * Run a command without blocking this process, because the servers the command talks to run in it.
 * @param command - the executable.
 * @param args - its arguments.
 * @param env - its whole environment.
 * @returns its exit status and output.
 */
function run(command: string, args: readonly string[], env: NodeJS.ProcessEnv): Promise<Finished> {
  return new Promise((resolve) => {
    execFile(command, [...args], { encoding: 'utf8', timeout: 120_000, env }, (error, stdout, stderr) => {
      resolve({ status: error === null ? 0 : typeof error.code === 'number' ? error.code : null, stdout, stderr })
    })
  })
}

/**
 * Run the packed launcher as `npx` does, in an environment that holds only a path, a home for npm and the Delorun home.
 * @param tarball - the packed launcher.
 * @param home - the Delorun home the run installs into.
 * @param args - the arguments after the command name.
 * @param scratchDirectory - a directory for npm's cache and home.
 * @returns the run's status and output.
 */
function npx(tarball: string, home: string, args: readonly string[], scratchDirectory: string): Promise<Finished> {
  return run('npm', ['exec', '--yes', `--package=${tarball}`, '--', 'delorun', ...args], {
    PATH: process.env.PATH ?? '',
    HOME: scratchDirectory,
    DELORUN_HOME: home,
    npm_config_cache: join(scratchDirectory, 'npm-cache'),
    npm_config_offline: 'true',
    npm_config_update_notifier: 'false',
    npm_config_audit: 'false',
    npm_config_fund: 'false',
  })
}

/** The build, the pack and `npm exec` take seconds each, so the specs of this file get a longer limit. */
const LIMIT = { timeout: 180_000 }

/**
 * Run the packed launcher's `bin` with Node directly, from the tarball's unpacked content.
 * @param tarball - the packed launcher.
 * @param home - the Delorun home the run installs into.
 * @param args - the arguments after the command name.
 * @param scratchDirectory - a directory to unpack into.
 * @returns the run's status and output.
 */
function node(tarball: string, home: string, args: readonly string[], scratchDirectory: string): Promise<Finished> {
  const unpacked = join(scratchDirectory, 'unpacked')
  if (!existsSync(unpacked)) {
    mkdirSync(unpacked)
    execFileSync('tar', ['-xzf', tarball, '-C', unpacked], { timeout: 30_000 })
  }
  return run(process.execPath, [join(unpacked, 'package', 'dist', 'bin.js'), ...args], { PATH: process.env.PATH ?? '', DELORUN_HOME: home })
}

describe('the built launcher against a local release', LIMIT, () => {
  it('installs it with the log unreachable: prints each step and the warning, records the check, and starts the runtime', async (test) => {
    const served = await servedRelease(test)
    const port = await closedPort()
    const built = await buildLauncher({ roots: [served.rootPath], out: join(served.directory, 'launcher'), constants: { channelOrigin: served.origin, logOrigin: `http://127.0.0.1:${String(port)}` }, version: '0.0.1-e2e' })
    const home = join(served.directory, 'home')
    const first = await npx(built.tarball, home, ['--version'], served.directory)
    // The durations and the percentage lines depend on the machine's speed.
    const checklist = first.stderr.split('\n').filter(line => line !== '' && !line.startsWith('npm ') && !/^ {2}\d+%/u.test(line)).map(line => line.replace(/ {2}\d+(\.\d)?s$/u, ''))
    expect(checklist).toEqual([
      '✔ Found release 0.1.0 on the stable channel',
      '✔ Signature checked (release root 1)',
      expect.stringMatching(/^! Release log not checked \(the release log gave no checkpoint \(.+ could not be fetched: .+\)\)$/u),
      '  Warning: Release 0.1.0 has not been checked against the release log; Delorun checks it at the next connection.',
      'Downloading delorun-0.1.0-linux-x64.tar.gz…',
      expect.stringMatching(/^✔ Downloaded \d+(\.\d)? (kB|MB)/u),
      '✔ Download matches its signed hash',
      'Unpacking the runtime…',
      expect.stringMatching(/^✔ Unpacked the runtime \([\d,]+ files\)$/u),
      '✔ Installed release 0.1.0',
      '✔ Starting Delorun',
    ])
    expect(first.stdout).toBe('Delorun 0.1.0\n')
    expect(first.status).toBe(0)
    expect(readdirSync(join(home, 'runtimes'))).toEqual(expect.arrayContaining([VERSION, 'current', 'store.json', `delorun-${VERSION}.manifest.json`, `delorun-${VERSION}.manifest.log.json`]))
    const state = JSON.parse(readFileSync(join(home, 'trust', 'release-log.json'), 'utf8')) as { releases: Record<string, { state: string, detail?: string }> }
    expect(state.releases[VERSION]?.state).toBe('unchecked')
    expect(state.releases[VERSION]?.detail).toContain('could not be fetched')
    // A start needs no network: it prints none of the install lines, only the start check's warning, and starts.
    const second = await node(built.tarball, home, ['--version'], served.directory)
    expect(second.stdout).toBe('Delorun 0.1.0\n')
    expect(second.stderr.split('\n').filter(line => line !== '' && !line.startsWith('npm '))).toEqual([
      expect.stringMatching(/^Release 0\.1\.0 has not been checked against the release log; Delorun checks it at the next connection\. \(the release log gave no checkpoint \(.+\)\)$/u),
    ])
    expect(second.status).toBe(0)
  })

  it('refuses an archive with one changed byte before anything is written to the store', async (test) => {
    const served = await servedRelease(test)
    const built = await buildLauncher({ roots: [served.rootPath], out: join(served.directory, 'launcher'), constants: { channelOrigin: served.origin, logOrigin: `http://127.0.0.1:${String(await closedPort())}` }, version: '0.0.1-e2e' })
    const archive = join(served.channel, 'releases', 'download', `v${VERSION}`, `delorun-${VERSION}-linux-x64.tar.gz`)
    const bytes = readFileSync(archive)
    bytes[bytes.byteLength - 1] = bytes[bytes.byteLength - 1]! ^ 0xff
    chmodSync(archive, 0o644)
    writeFileSync(archive, bytes)
    const home = join(served.directory, 'home')
    const finished = await node(built.tarball, home, ['--version'], served.directory)
    expect(finished.status).toBe(1)
    expect(finished.stderr).toContain('Delorun refused release delorun-0.1.0-linux-x64.tar.gz, which did not verify')
    expect(finished.stdout).toBe('')
    expect(readdirSync(join(home, 'runtimes'))).toEqual([])
    expect(readdirSync(join(home, 'staging'))).toEqual([])
  })

  it('installs on the signature with the warning when the log answers with no checkpoint its key signed, as an answer before any signed data', async (test) => {
    const served = await servedRelease(test)
    const unsigned = createServer((_, response) => response.writeHead(200).end('not a signed checkpoint\n'))
    await new Promise<void>(resolve => unsigned.listen(0, '127.0.0.1', resolve))
    test.onTestFinished(() => new Promise<void>(resolve => unsigned.close(() => resolve())))
    const logOrigin = `http://127.0.0.1:${String((unsigned.address() as AddressInfo).port)}`
    const built = await buildLauncher({ roots: [served.rootPath], out: join(served.directory, 'launcher'), constants: { channelOrigin: served.origin, logOrigin }, version: '0.0.1-e2e' })
    const home = join(served.directory, 'home')
    const finished = await node(built.tarball, home, ['--version'], served.directory)
    expect(finished.status).toBe(0)
    expect(finished.stderr).toContain('Warning: Release 0.1.0 has not been checked against the release log')
    expect(finished.stderr).not.toContain('release-log check failed')
    const state = JSON.parse(readFileSync(join(home, 'trust', 'release-log.json'), 'utf8')) as { releases: Record<string, { state: string }> }
    expect(state.releases[VERSION]?.state).toBe('unchecked')
  })

  it('verifies the release against a log that has grown since, computing the consistency proof from its tiles', async (test) => {
    const served = await servedRelease(test)
    served.trusted.log.grow(5)
    const log = await serveLog(test, served.trusted)
    const built = await buildLauncher({ roots: [served.rootPath], out: join(served.directory, 'launcher'), constants: { channelOrigin: served.origin, logOrigin: log.origin }, version: '0.0.1-e2e' })
    const home = join(served.directory, 'home')
    const finished = await node(built.tarball, home, ['--version'], served.directory)
    expect(finished.stderr).toContain('✔ Release log checked')
    expect(finished.stderr).not.toContain('Warning:')
    expect(finished.status).toBe(0)
    const state = JSON.parse(readFileSync(join(home, 'trust', 'release-log.json'), 'utf8')) as { releases: Record<string, { state: string }> }
    expect(state.releases[VERSION]?.state).toBe('verified')
    expect(JSON.parse(readFileSync(join(home, 'trust', 'checkpoint.json'), 'utf8'))).toMatchObject({ treeSize: 6 })
  })

  it('refuses a well-formed, signed and cosigned checkpoint of a log that never held the release', async (test) => {
    const served = await servedRelease(test)
    // A fork of the log: the same key signs a tree whose first entry is not the release's.
    const fork = Object.assign(new LogStandIn(), { key: served.trusted.log.key })
    fork.append(Buffer.from('another entry'))
    fork.append(Buffer.from('and one more'))
    const log = await serveLog(test, { ...served.trusted, log: fork })
    const built = await buildLauncher({ roots: [served.rootPath], out: join(served.directory, 'launcher'), constants: { channelOrigin: served.origin, logOrigin: log.origin }, version: '0.0.1-e2e' })
    const home = join(served.directory, 'home')
    const finished = await node(built.tarball, home, ['--version'], served.directory)
    expect(finished.status).toBe(1)
    expect(finished.stderr).toContain('because its release-log check failed')
    expect(finished.stderr).toContain('the consistency proof from tree size 1 to 2 does not verify')
    expect(readdirSync(join(home, 'runtimes'))).toEqual([])
    expect(() => readFileSync(join(home, 'trust', 'release-log.json'))).toThrow('ENOENT')
  })

  it('installs on the signature with the warning when the log answers 404 for its checkpoint, as an answer before any signed data', async (test) => {
    const served = await servedRelease(test)
    const missing = createServer((_, response) => response.writeHead(404).end())
    await new Promise<void>(resolve => missing.listen(0, '127.0.0.1', resolve))
    test.onTestFinished(() => new Promise<void>(resolve => missing.close(() => resolve())))
    const built = await buildLauncher({ roots: [served.rootPath], out: join(served.directory, 'launcher'), constants: { channelOrigin: served.origin, logOrigin: `http://127.0.0.1:${String((missing.address() as AddressInfo).port)}` }, version: '0.0.1-e2e' })
    const finished = await node(built.tarball, join(served.directory, 'home'), ['--version'], served.directory)
    expect(finished.status).toBe(0)
    expect(finished.stderr).toContain('the log does not serve its checkpoint at')
    expect(finished.stderr).toContain('Warning: Release 0.1.0 has not been checked against the release log')
    expect(finished.stderr).not.toContain('release-log check failed')
  })

  it('refuses an archive whose file content differs from the signed file list by one byte, before anything is installed', async (test) => {
    const directory = scratch(test)
    test.onTestFinished(() => { execFileSync('chmod', ['-R', 'u+rwX', directory], { timeout: 30_000 }) })
    const trusted = trust()
    const log = await serveLog(test, trusted)
    const closures = join(directory, 'closures')
    mkdirSync(closures)
    // The archive is built from a tree whose entry file differs by one byte; the file list is the original tree's.
    const original = join(directory, 'original')
    const altered = join(directory, 'altered')
    mkdirSync(original)
    mkdirSync(altered)
    await fixtureClosure(test, VERSION)(original)
    await fixtureClosure(test, VERSION, { entrySuffix: ' ' })(altered)
    for (const name of readdirSync(original)) writeFileSync(join(closures, name), readFileSync(join(name.endsWith('.json') ? original : altered, name)))
    const rootPath = join(directory, 'root.json')
    writeFileSync(rootPath, trusted.root)
    const channel = join(directory, 'channel')
    const signed = await runEntryAsync('local-release.ts', [
      '--version', VERSION, '--summary', 'A local fixture release.', '--out', channel, '--root', rootPath,
      '--targets-key', keyFile(directory, 'targets.pem', trusted.keys.targets),
      '--timestamp-key', keyFile(directory, 'timestamp.pem', trusted.keys.timestamp),
      '--state', join(directory, 'state.json'),
      '--log-submit', log.endpoints.submit, '--log-checkpoint', log.endpoints.checkpoint, '--log-tiles', log.endpoints.tiles,
      '--closures-from', closures, '--allow-builder-paths',
    ])
    expect(signed.status).toBe(0)
    const origin = await serveChannel(test, channel)
    const built = await buildLauncher({ roots: [rootPath], out: join(directory, 'launcher'), constants: { channelOrigin: origin, logOrigin: `http://127.0.0.1:${String(await closedPort())}` }, version: '0.0.1-e2e' })
    const home = join(directory, 'home')
    const finished = await node(built.tarball, home, ['--version'], directory)
    expect(finished.status).toBe(1)
    expect(finished.stderr).toMatch(/bin\.js .*(length|SHA-256|differs)|refused the runtime archive/u)
    expect(readdirSync(join(home, 'runtimes'))).toEqual([])
  })

  it('refuses every install when the package ships no root', async (test) => {
    const served = await servedRelease(test)
    const built = await buildLauncher({ roots: [served.rootPath], out: join(served.directory, 'launcher'), constants: { channelOrigin: served.origin, logOrigin: `http://127.0.0.1:${String(await closedPort())}` }, version: '0.0.1-e2e' })
    rmSync(join(built.directory, 'roots'), { recursive: true })
    const finished = await run(process.execPath, [join(built.directory, 'dist', 'bin.js'), '--version'], { PATH: process.env.PATH ?? '', DELORUN_HOME: join(served.directory, 'home') })
    expect(finished.status).toBe(1)
    expect(finished.stderr).toContain('This launcher cannot verify any release')
    expect(finished.stderr).toContain('run npx delorun@latest, which ships the current release roots, instead')
    expect(readdirSync(join(served.directory, 'home', 'runtimes'))).toEqual([])
  })
})

/** A directory holding the `linux-x64` archive and file list that `build-closure.ts --version 0.1.0` built from the real tree. */
const REAL_CLOSURE = process.env.DELORUN_CLOSURE_FILES

describe.skipIf(REAL_CLOSURE === undefined)('the built launcher against a closure built from the real tree', LIMIT, () => {
  it('installs it and starts delorun, which reports the release’s version and upstream’s', async (test) => {
    const served = await servedRelease(test, REAL_CLOSURE)
    const built = await buildLauncher({ roots: [served.rootPath], out: join(served.directory, 'launcher'), constants: { channelOrigin: served.origin, logOrigin: `http://127.0.0.1:${String(await closedPort())}` }, version: '0.0.1-e2e' })
    const home = join(served.directory, 'home')
    const first = await node(built.tarball, home, ['--version'], served.directory)
    expect(first.stderr).toContain('✔ Installed release 0.1.0')
    expect(first.stdout).toMatch(/^Delorun 0\.1\.0\nDSH \d+\.\d+\.\d+/u)
    expect(first.status).toBe(0)
    const second = await node(built.tarball, home, ['--version', '--json'], served.directory)
    expect(JSON.parse(second.stdout)).toMatchObject({ delorun: '0.1.0' })
  })
})
