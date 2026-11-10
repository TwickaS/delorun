/**
 * The journey's parts on this computer: the throwaway trust, the runtime closures and the releases signed from them,
 * the fixture plugin, and the launcher.
 *
 * Every release comes from one closure that `build-closure.ts --artifacts existing` builds from the worktree's built
 * artifacts at its commit, as release 1. The other releases are that closure extracted, given another version with the
 * recipe's own `stampDeloVersion` step, changed where the release needs a change, and archived again with the recipe's
 * own `archiveClosure`, so each has a file list that describes it; `local-release.ts --closures-from` then signs and
 * logs each one into the channel. Building the same commit again under each version would give the same files for many
 * minutes more.
 */
import { execFile, execFileSync } from 'node:child_process'
import { chmod, copyFile, cp, mkdir, open, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { archiveClosure } from '../../src/closure/archive-closure.ts'
import { stampDeloVersion } from '../../src/closure/delo.ts'
import { closureFileNames } from '../../src/closure/tree.ts'
import { buildLauncher, type BuiltLauncher } from '../../../npm-launcher/src/build.ts'
import { keyFile, runEntryAsync, trust, type Trust } from '../local/support.ts'
import { REPO } from '../support.ts'
import type { JourneyLog } from './servers.ts'

/** The only platform the journey's machine runs. */
const PLATFORM = 'linux-x64'

/** The pinned toolchain and image base the release tooling reads, for the journey's image. */
interface Pins {
  readonly nodeTarball: string
  /** The pinned pnpm package, which the runtime closure carries too. */
  readonly pnpmTarball: string
  readonly base: string
}

/**
 * The pinned Node distribution and pnpm package, from the release tooling's download cache, and the pinned Debian base
 * of the images.
 * @param cache - the release tooling's cache, which the closure build fills.
 * @returns the tarballs' paths and the base reference.
 * @throws Error when the cache lacks a tarball.
 */
export function pins(cache: string): Pins {
  const toolchain = JSON.parse(readFileSync(join(REPO, 'delo/apps/release/toolchain.json'), 'utf8')) as { node: { distributions: Record<string, { sha256: string }> }, pnpm: { integrity: string } }
  const images = JSON.parse(readFileSync(join(REPO, 'delo/apps/release/images.json'), 'utf8')) as { base: string }
  const nodeTarball = join(cache, `sha256-${toolchain.node.distributions[PLATFORM]!.sha256}`)
  const pnpmTarball = join(cache, `sha512-${Buffer.from(toolchain.pnpm.integrity.replace(/^sha512-/u, ''), 'base64').toString('hex')}`)
  for (const [what, path] of [['Node for linux-x64', nodeTarball], ['pnpm', pnpmTarball]] as const) {
    if (!existsSync(path)) throw new Error(`the release cache ${cache} holds no pinned ${what}; the closure build downloads it`)
  }
  return { nodeTarball, pnpmTarball, base: images.base }
}

/** Where the release tooling caches its pinned downloads. */
export const RELEASE_CACHE = join(homedir(), '.cache', 'delo-release')

/**
 * Run a release entry point with its output in a log file, and fail with the log's end when it fails.
 * @param entry - the path under `delo/apps/release/src/`.
 * @param args - its arguments.
 * @param log - the log file.
 */
function runLogged(entry: string, args: readonly string[], log: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(join(REPO, 'node_modules/.bin/tsx'), [join(REPO, 'delo/apps/release/src', entry), ...args], { cwd: REPO, maxBuffer: 256 * 1024 * 1024, env: { ...process.env, CI: '', GITHUB_ACTIONS: '' } }, (error, stdout, stderr) => {
      void writeFile(log, `${stdout}\n${stderr}`).then(() => {
        if (error === null) resolve()
        else reject(new Error(`${entry} failed (${String(error.code ?? error.signal)}); the end of ${log}:\n${`${stdout}\n${stderr}`.trim().split('\n').slice(-25).join('\n')}`))
      })
    })
  })
}

/** The closure release 1 is built from, and the facts every release made from it shares. */
export interface BaseClosure {
  /** The directory holding the archive and its unsigned file list. */
  readonly directory: string
  readonly version: string
  /** The commit's committer time, every archive entry's mtime. */
  readonly epoch: number
}

/**
 * Build the Linux x64 closure of the worktree's commit from its built artifacts. The build refuses, naming the cause,
 * when the worktree is not clean at its commit or a package's built output is missing or older than its sources.
 * @param scratch - the run's directory.
 * @param version - release 1's version.
 * @param reused - a directory that already holds this version's archive and file list, which is used instead of a build.
 * @returns the closure.
 */
export async function buildBaseClosure(scratch: string, version: string, reused?: string): Promise<BaseClosure> {
  const epoch = Number(execFileSync('git', ['log', '-1', '--format=%ct', 'HEAD'], { cwd: REPO, encoding: 'utf8', timeout: 30_000 }).trim())
  if (reused !== undefined) {
    const names = closureFileNames(version, PLATFORM)
    for (const name of [names.archive, names.files]) if (!existsSync(join(reused, name))) throw new Error(`${reused} holds no ${name}`)
    return { directory: reused, version, epoch }
  }
  const directory = join(scratch, `closure-${version}`)
  await mkdir(directory, { recursive: true })
  await runLogged('build-closure.ts', ['--version', version, '--platform', PLATFORM, '--artifacts', 'existing', '--out', directory, '--cache', RELEASE_CACHE], join(scratch, 'build-closure.log'))
  return { directory, version, epoch }
}

/** A change a derived release makes to the extracted closure before it is archived. */
export type ClosureChange = (stage: string) => Promise<void>

/**
 * Make another release's closure from the base: extract it, stamp the version, apply the change, and archive it.
 * @param base - the base closure.
 * @param scratch - the run's directory.
 * @param version - the derived release's version.
 * @param change - what the release changes, if anything.
 * @param out - the directory to write the archive and file list to.
 * @returns the directory.
 */
export async function deriveClosure(base: BaseClosure, scratch: string, version: string, change?: ClosureChange, out = join(scratch, `closure-${version}`)): Promise<string> {
  const stage = join(scratch, `stage-${version}-${String(Date.now())}`)
  await mkdir(stage, { recursive: true })
  execFileSync('tar', ['-x', '-z', '-f', join(base.directory, closureFileNames(base.version, PLATFORM).archive), '-C', stage], { timeout: 600_000 })
  execFileSync('chmod', ['-R', 'u+w', stage], { timeout: 120_000 })
  await stampDeloVersion(join(stage, 'app', 'node_modules'), version)
  await change?.(stage)
  await mkdir(out, { recursive: true })
  await archiveClosure({ stage, outDir: out, version, platform: PLATFORM, epoch: base.epoch, pins: undefined, requireLaunchFiles: true })
  await rm(stage, { recursive: true, force: true })
  return out
}

/**
 * Replace one match in a file of an extracted closure, failing when the pattern does not match exactly once: a fixture
 * change that no longer applies stops the journey with that message rather than releasing an unchanged closure.
 * @param stage - the extracted closure.
 * @param path - the file, relative to the closure's root.
 * @param from - the pattern, without the global flag.
 * @param to - its replacement, which may name the pattern's groups as `$1`.
 */
export async function replaceInClosure(stage: string, path: string, from: RegExp, to: string): Promise<void> {
  const file = join(stage, path)
  const text = await readFile(file, 'utf8')
  const found = [...text.matchAll(new RegExp(from.source, `${from.flags}g`))].length
  if (found !== 1) throw new Error(`the journey's fixture change no longer applies: ${path} matches ${String(from)} ${String(found)} times, not once`)
  await chmod(file, 0o644)
  await writeFile(file, text.replace(from, to))
}

/** The run's trust: throwaway keys, the root file and the signer's state. */
export interface RunTrust {
  readonly trusted: Trust
  readonly rootPath: string
  readonly targetsKey: string
  readonly timestampKey: string
  readonly state: string
}

/**
 * New throwaway keys of every role, a root over them, and the files the signing tools read.
 * @param scratch - the run's directory; the keys are written there, readable by their owner only.
 * @returns the trust.
 */
export async function runTrust(scratch: string): Promise<RunTrust> {
  const trusted = trust()
  const directory = join(scratch, 'keys')
  await mkdir(directory, { mode: 0o700 })
  const rootPath = join(directory, 'root.json')
  await writeFile(rootPath, trusted.root)
  return {
    trusted,
    rootPath,
    targetsKey: keyFile(directory, 'targets.pem', trusted.keys.targets),
    timestampKey: keyFile(directory, 'timestamp.pem', trusted.keys.timestamp),
    state: join(directory, 'timestamp-state.json'),
  }
}

/**
 * Sign, log and publish one release into the channel with `local-release.ts`, which makes it the version both of the
 * channel's names point at.
 * @param trust - the run's trust.
 * @param log - the release log, which must agree while a release is submitted.
 * @param channel - the channel directory.
 * @param version - the release's version.
 * @param closures - the directory holding its archive and unsigned file list.
 */
export async function publish(trust: RunTrust, log: JourneyLog, channel: string, version: string, closures: string): Promise<void> {
  const signed = await runEntryAsync('local-release.ts', [
    '--version', version, '--out', channel, '--root', trust.rootPath,
    '--targets-key', trust.targetsKey, '--timestamp-key', trust.timestampKey, '--state', trust.state,
    '--log-submit', log.endpoints.submit, '--log-checkpoint', log.endpoints.checkpoint, '--log-tiles', log.endpoints.tiles,
    '--log-poll-seconds', '0', '--closures-from', closures,
  ])
  if (signed.status !== 0) throw new Error(`local-release.ts --version ${version} failed: ${signed.stderr}`)
}

/**
 * Build and pack the launcher with the run's root and the spec's channel and log origins as its build constants.
 * @param trust - the run's trust.
 * @param scratch - the run's directory.
 * @param channelOrigin - the channel server's loopback origin.
 * @param logOrigin - the log server's loopback origin.
 * @returns the packed launcher.
 */
export function launcher(trust: RunTrust, scratch: string, channelOrigin: string, logOrigin: string): Promise<BuiltLauncher> {
  return buildLauncher({ roots: [trust.rootPath], out: join(scratch, 'launcher'), constants: { channelOrigin, logOrigin }, version: '0.0.1-journey' })
}

/**
 * Pack a fixture package directory with `npm pack`.
 * @param source - the package directory, under this spec's `fixtures/`.
 * @param destination - the directory the tarball is written to.
 * @returns the tarball's file name.
 */
export async function packFixture(source: string, destination: string): Promise<string> {
  const copy = join(destination, `.pack-${String(Date.now())}`)
  await cp(source, copy, { recursive: true })
  const name = execFileSync('npm', ['pack', '--silent', '--pack-destination', destination], { cwd: copy, encoding: 'utf8', timeout: 120_000 }).trim().split('\n').at(-1)!
  await rm(copy, { recursive: true, force: true })
  return name
}

/** The size of a tar block, which holds one header or a part of one entry's content. */
const TAR_BLOCK = 512

/**
 * Change one byte of one file's content inside a closure archive and keep the signed file list that describes the file
 * unchanged, as a release whose archive was altered after it was built would be. The archive is decompressed, the
 * file's last content byte is changed in place, so every length and every tar header stays as it was, and the tar is
 * compressed again with `gzip`.
 * @param honest - the directory holding the release's archive and file list.
 * @param version - the release's version.
 * @param path - the file inside the archive, such as `data-formats.json`.
 * @param out - the directory to write the changed archive and the unchanged file list to.
 * @returns the directory.
 * @throws Error when the archive holds no such file.
 */
export async function tamperedArchive(honest: string, version: string, path: string, out: string): Promise<string> {
  const names = closureFileNames(version, PLATFORM)
  await mkdir(out, { recursive: true })
  const tar = join(out, 'archive.tar')
  execFileSync('sh', ['-c', 'gzip -dc "$1" > "$2"', 'sh', join(honest, names.archive), tar], { timeout: 600_000 })
  const file = await open(tar, 'r+')
  try {
    const header = Buffer.alloc(TAR_BLOCK)
    for (let offset = 0; ; ) {
      const { bytesRead } = await file.read(header, 0, TAR_BLOCK, offset)
      if (bytesRead < TAR_BLOCK || header.every(byte => byte === 0)) throw new Error(`the archive ${names.archive} holds no ${path}`)
      const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/su, '')
      const size = Number.parseInt(header.subarray(124, 136).toString('ascii').replace(/\0.*$/su, '').trim() || '0', 8)
      if (name === path && size > 0) {
        const last = Buffer.alloc(1)
        await file.read(last, 0, 1, offset + TAR_BLOCK + size - 1)
        await file.write(Buffer.from([last[0]! ^ 0x01]), 0, 1, offset + TAR_BLOCK + size - 1)
        break
      }
      offset += TAR_BLOCK + Math.ceil(size / TAR_BLOCK) * TAR_BLOCK
    }
  } finally {
    await file.close()
  }
  execFileSync('sh', ['-c', 'gzip -c "$1" > "$2"', 'sh', tar, join(out, names.archive)], { timeout: 600_000 })
  await rm(tar)
  await copyFile(join(honest, names.files), join(out, names.files))
  return out
}

/**
 * Make one derived release with `derive.ts` in a process of its own.
 * @param base - the base closure.
 * @param scratch - the run's directory.
 * @param version - the release's version.
 * @param change - the name of the change, one of `derive.ts`'s changes.
 * @returns the directory holding the release's archive and file list.
 */
export function deriveInChild(base: BaseClosure, scratch: string, version: string, change: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(join(REPO, 'node_modules/.bin/tsx'), [join(REPO, 'delo/apps/release/tests/journey/derive.ts'), base.directory, base.version, String(base.epoch), scratch, version, change], { cwd: REPO, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error === null) resolve(stdout.trim())
      else reject(new Error(`making release ${version} (${change}) failed: ${stderr.trim() || String(error)}`))
    })
  })
}
