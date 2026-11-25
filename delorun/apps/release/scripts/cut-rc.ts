/**
 * Cuts the next release candidate in one command: checks the tree, assembles the changelog, builds the runtime closure,
 * signs and logs the release into the local channel with `local-release.ts`, and verifies the channel as a client does.
 * See "Cutting a preview or release candidate" in `delorun/apps/release/README.md`.
 *
 * `tsx delorun/apps/release/scripts/cut-rc.ts --version <0.1.0-preview.N[.M]|0.1.0-rc.N[.M]> --channel <dir> --state <signer state file> --keys <dir>
 * --root <root file>... --commit <sha> [--highlights <file>] [--summary <text>] [--work <dir>] [--closures-from <dir>]
 * [--artifacts build|existing] [--platform <platform>]... [--log-submit <url> --log-checkpoint <url> --log-tiles <url>]
 * [--log-poll-seconds <n>] [--smoke-minutes <n>] [--smoke-previous <version>] [--no-smoke] [--allow-builder-paths] [--dry-run]`
 *
 * `--root` repeats, oldest first, and the whole chain goes to `local-release.ts` and to the channel verification: the
 * signer's state trusts the root it was initialised with until a release under the next root is signed, so a cut after a
 * rotation passes both. Only the newest root goes to the log probe, which probes the log that root names.
 *
 * `--keys` is a directory holding `targets.pem` and `timestamp.pem`, and `log-entry-ecdsa.pem` when the root lists an
 * ECDSA P-256 log-entry key; their contents are passed to no log and no output, only their paths reach the signing
 * command, which signs the log entry with the root's listed keys in order and moves to the next only when the log refuses
 * the entry's key type. `--highlights` is where the release-notes file is written (default
 * `<work>/notes-<version>.txt`); every candidate signs it into the manifest as `notes`.
 * `--work` (default: the channel's parent directory) holds the closure, the build cache and `cut-rc-<version>.log`, to
 * which every step's output goes; a step that fails names the log. The log endpoints default to the public Rekor v2
 * instance the release runbook names. Before anything is built, `probe-log.ts` submits one throwaway entry over random
 * bytes for each entry key type the root lists to that log and reports which it accepts; the cut stops when it accepts
 * none. `--closures-from` signs closure files an earlier run built and skips the build,
 * which is also how to rerun after a timestamp or logging failure without rebuilding.
 *
 * Signing refuses closure or pack files that name the building user's home directory, user name as a folder or a unique
 * build root. A public cut uses `--artifacts build`, which embeds none of them. `--artifacts existing` (the default) embeds
 * the worktree's paths, so it is refused too unless `--allow-builder-paths` is given, for a local iteration candidate;
 * the signing step then prints each offending file as a warning.
 *
 * The last step is the installed-release smoke (`installed-smoke.ts`): it installs the candidate from the channel into a
 * scratch home with a launcher built for a scratch origin, adds every pack, restarts twice and creates a chat, within
 * `--smoke-minutes` (default 30). Its upgrade step starts from the newest older release in the channel; `--smoke-previous <version>` names another (one the channel holds that is older than the candidate), such as the release a person is on when a later candidate failed. It runs after the candidate is published into the channel directory, so a failure
 * means: do not tag, and do not give the candidate to anyone. `--no-smoke` leaves it out, for a channel of closures that
 * are not real runtimes.
 *
 * A private test build `<x.y.z>-preview.<n>.<m>` (M from 1) sits between `preview.<n>` and `preview.<n+1>`. It updates from
 * `preview.<n>` for M = 1, and from `preview.<n>.<m-1>` otherwise; the next candidate `preview.<n+1>` updates from the
 * newest lower candidate of its series in the channel.
 *
 * The command stops, exit 3, when assembling the changelog changed tracked files: commit them and run it again with the
 * new `--commit`. It never tags, pushes or touches an installed home; it prints those commands for the lead.
 * `--dry-run` prints the plan and runs nothing.
 *
 * @module cut-rc
 */
import { spawn } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { RUNTIME_PLATFORMS, type RuntimePlatform } from '@delorun/contract-release-manifest'
import { createHash } from 'node:crypto'
import { packsLogName, packsName, readBundle, verifyBundle } from '@delorun/release-formats/log/bundle'
import { checkFileRef, readRoot, trustRootChain, verifyChannelManifest, verifyPacks, verifySignedManifest, verifyTimestamp } from '@delorun/release-formats/sign/verify'
import { repositoryRoot } from '@delorun/tools/src/git.ts'
import { parseData } from '../src/changelog/data.ts'
import { DATA_PATH } from '../src/changelog/paths.ts'
import { BUILD_ROOT_MARKER } from '../src/closure/build-root.ts'
import { readRecipe } from '../src/closure/config.ts'
import { compareVersions } from '../src/changelog/version.ts'

/** The log endpoints the release runbook names, used when no `--log-*` flag is given. */
const REKOR = {
  submit: 'https://log2025-1.rekor.sigstore.dev/api/v2/log/entries',
  checkpoint: 'https://log2025-1.rekor.sigstore.dev/api/v2/checkpoint',
  tiles: 'https://log2025-1.rekor.sigstore.dev/api/v2/',
} as const

/**
 * A preview or release candidate version: group 1 the core, group 2 `preview` or `rc`, group 3 the number, group 4 the
 * iteration of a private test build.
 */
const CANDIDATE = /^(\d+\.\d+\.\d+)-(preview|rc)\.([1-9]\d*)(?:\.([1-9]\d*))?$/u

/** What the command needs. */
export interface CutRequest {
  /** The candidate's version, `<x.y.z>-preview.<n>[.<m>]` or `<x.y.z>-rc.<n>[.<m>]`. */
  readonly version: string
  /** Which series the version belongs to. */
  readonly kind: 'preview' | 'rc'
  /** The candidate's number within its series. */
  readonly number: number
  /** The private test build's iteration `m` in `<n>.<m>`; undefined for a candidate without one. */
  readonly iteration: number | undefined
  /** The channel directory `local-release.ts` writes. */
  readonly channel: string
  /** The timestamp signer's state file. */
  readonly state: string
  /** The directory holding `targets.pem` and `timestamp.pem`. */
  readonly keys: string
  /** The signed root files, oldest first: the chain a client walks. */
  readonly roots: readonly string[]
  /** The commit to release. */
  readonly commit: string
  /** Where the release notes are written. */
  readonly highlights: string
  /** The release's one-line summary. */
  readonly summary: string
  /** The directory for the closure, cache and log. */
  readonly work: string
  /** Closure files to sign instead of building. */
  readonly closuresFrom: string | undefined
  /** `build-closure.ts`'s artifact source. */
  readonly artifacts: 'build' | 'existing'
  /** Whether signing may take closure files that name the building user's paths (`--allow-builder-paths`). */
  readonly allowBuilderPaths: boolean
  /** The platforms to carry. */
  readonly platforms: readonly RuntimePlatform[]
  /** The release log endpoints. */
  readonly log: { readonly submit: string, readonly checkpoint: string, readonly tiles: string }
  /** Seconds between checkpoint polls. */
  readonly logPollSeconds: string
  /** The installed-release smoke's time budget in minutes; undefined with `--no-smoke`. */
  readonly smokeMinutes: number | undefined
  /** The release the smoke's upgrade step starts from (`--smoke-previous`); the smoke picks the newest older release in the channel when undefined. */
  readonly smokePrevious: string | undefined
  /** Print the plan and run nothing. */
  readonly dryRun: boolean
}

/**
 * Parse the command line.
 * @param argv - the arguments after the script.
 * @returns the request.
 * @throws Error naming the first wrong or missing flag.
 */
export function parseCutArgs(argv: readonly string[]): CutRequest {
  const { values } = parseArgs({
    args: [...argv],
    strict: true,
    options: {
      'version': { type: 'string' },
      'channel': { type: 'string' },
      'state': { type: 'string' },
      'keys': { type: 'string' },
      'root': { type: 'string', multiple: true },
      'commit': { type: 'string' },
      'highlights': { type: 'string' },
      'summary': { type: 'string' },
      'work': { type: 'string' },
      'closures-from': { type: 'string' },
      'artifacts': { type: 'string', default: 'existing' },
      'platform': { type: 'string', multiple: true },
      'log-submit': { type: 'string', default: REKOR.submit },
      'log-checkpoint': { type: 'string', default: REKOR.checkpoint },
      'log-tiles': { type: 'string', default: REKOR.tiles },
      'log-poll-seconds': { type: 'string', default: '30' },
      'smoke-minutes': { type: 'string', default: '30' },
      'smoke-previous': { type: 'string' },
      'no-smoke': { type: 'boolean', default: false },
      'allow-builder-paths': { type: 'boolean', default: false },
      'dry-run': { type: 'boolean', default: false },
    },
  })
  const required = (name: 'version' | 'channel' | 'state' | 'keys' | 'commit'): string => {
    const value = values[name]
    if (value === undefined || value === '') throw new Error(`pass --${name}`)
    return value
  }
  const roots = values.root ?? []
  if (roots.length === 0 || roots.some(root => root === '')) throw new Error('pass --root')
  const version = required('version')
  const match = CANDIDATE.exec(version)
  if (match === null) throw new Error(`--version ${version} is not a preview or release candidate such as 0.1.0-preview.2 or 0.1.0-rc.2`)
  if (values.artifacts !== 'build' && values.artifacts !== 'existing') throw new Error(`--artifacts is build or existing, not ${values.artifacts}`)
  const platforms = [...new Set(values.platform ?? ['linux-x64'])].map((platform) => {
    if (!(RUNTIME_PLATFORMS as readonly string[]).includes(platform)) throw new Error(`--platform ${platform} is not one of ${RUNTIME_PLATFORMS.join(', ')}`)
    return platform as RuntimePlatform
  })
  const channel = resolve(required('channel'))
  const kind = match[2] as 'preview' | 'rc'
  const number = Number(match[3])
  const iteration = match[4] === undefined ? undefined : Number(match[4])
  const work = resolve(values.work ?? dirname(channel))
  const smokeMinutes = Number(values['smoke-minutes'])
  if (!Number.isInteger(smokeMinutes) || smokeMinutes < 1 || smokeMinutes > 240) throw new Error(`--smoke-minutes is a whole number from 1 to 240, not ${values['smoke-minutes']!}`)
  return {
    version,
    kind,
    number,
    iteration,
    channel,
    state: resolve(required('state')),
    keys: resolve(required('keys')),
    roots: roots.map(root => resolve(root)),
    commit: required('commit'),
    highlights: resolve(values.highlights ?? join(work, `notes-${version}.txt`)),
    summary: values.summary ?? `${kind === 'preview' ? 'Preview' : 'Release candidate'} ${match[3]}${iteration === undefined ? '' : `.${String(iteration)}`}.`,
    work,
    closuresFrom: values['closures-from'] === undefined ? undefined : resolve(values['closures-from']),
    artifacts: values.artifacts,
    allowBuilderPaths: values['allow-builder-paths'],
    platforms,
    log: { submit: values['log-submit']!, checkpoint: values['log-checkpoint']!, tiles: values['log-tiles']! },
    logPollSeconds: values['log-poll-seconds']!,
    smokeMinutes: values['no-smoke'] ? undefined : smokeMinutes,
    smokePrevious: values['smoke-previous'],
    dryRun: values['dry-run'],
  }
}

/** One step of the plan. */
export interface PlannedStep {
  /** A short name, stable for specs. */
  readonly id: 'tree' | 'probe' | 'changelog' | 'highlights' | 'clear-stages' | 'closure' | 'sign' | 'verify' | 'smoke'
  /** What the step does, for the log. */
  readonly title: string
  /** The commands it runs, as printable lines; key files appear by path only. */
  readonly commands: readonly string[]
}

/**
 * The candidate a request updates from. An iteration `N.M` updates from `N.M-1`, or from `N` when M is 1. A plain
 * candidate `N` updates from the newest candidate of its core and series below it in the channel; `N = 1` has none.
 * @param request - the request.
 * @param released - the versions the channel holds, without the leading `v`.
 * @returns the previous candidate; undefined for `N = 1`, and for a plain `N > 1` when the channel holds no lower candidate.
 */
export function previousCandidate(request: CutRequest, released: readonly string[]): string | undefined {
  const core = CANDIDATE.exec(request.version)![1]!
  const prefix = `${core}-${request.kind}.${String(request.number)}`
  if (request.iteration !== undefined) return request.iteration > 1 ? `${prefix}.${String(request.iteration - 1)}` : prefix
  if (request.number === 1) return undefined
  const lower = released.filter((version) => {
    const match = CANDIDATE.exec(version)
    return match !== null && match[1] === core && match[2] === request.kind && compareVersions(version, request.version) < 0
  })
  return lower.sort(compareVersions).at(-1)
}

/**
 * The versions the channel holds.
 * @param channel - the channel directory.
 * @returns the versions with a release directory, without the leading `v`.
 */
function releasedVersions(channel: string): string[] {
  const directory = join(channel, 'releases', 'download')
  if (!existsSync(directory)) return []
  return readdirSync(directory).filter(name => name.startsWith('v')).map(name => name.slice(1))
}

/** The closure directory of a candidate. */
function closureDirectory(request: CutRequest): string {
  return request.closuresFrom ?? join(request.work, `closure-${request.version}`)
}

/**
 * The commands of the signing step, as an argument list for `tsx`.
 * @param request - the request.
 * @returns the arguments of `local-release.ts`.
 */
export function localReleaseArgs(request: CutRequest): string[] {
  return [
    'delorun/apps/release/src/local-release.ts', '--version', request.version, '--commit', request.commit, '--summary', request.summary,
    '--out', request.channel, ...request.roots.flatMap(root => ['--root', root]), '--targets-key', join(request.keys, 'targets.pem'), '--timestamp-key', join(request.keys, 'timestamp.pem'),
    '--state', request.state, '--closures-from', closureDirectory(request),
    ...request.platforms.flatMap(platform => ['--platform', platform]),
    '--log-submit', request.log.submit, '--log-checkpoint', request.log.checkpoint, '--log-tiles', request.log.tiles, '--log-poll-seconds', request.logPollSeconds,
    ...existsSync(join(request.keys, LOG_ENTRY_ECDSA_KEY)) ? ['--log-entry-key', `PKIX_ECDSA_P256_SHA_256=${join(request.keys, LOG_ENTRY_ECDSA_KEY)}`] : [],
    '--notes', request.highlights,
    ...request.allowBuilderPaths ? ['--allow-builder-paths'] : [],
  ]
}

/** The file in `--keys` that holds the ECDSA P-256 log-entry key, when the root lists one. */
export const LOG_ENTRY_ECDSA_KEY = 'log-entry-ecdsa.pem'

/**
 * The arguments of the probe step for `tsx`.
 * @param request - the request.
 * @returns the arguments of `probe-log.ts`.
 */
export function probeArgs(request: CutRequest): string[] {
  // The probe asks the log the newest root names, so it takes that root alone; the chain is for signing and verification.
  return ['delorun/apps/release/scripts/probe-log.ts', '--root', newestRoot(request), '--log-submit', request.log.submit]
}

/**
 * The newest root of the chain, which names the log a release is logged to and the keys it is signed with.
 * @param request - the request.
 * @returns the last root file passed.
 */
export function newestRoot(request: CutRequest): string {
  return request.roots.at(-1)!
}

/**
 * The plan for a request.
 * @param request - the request.
 * @returns the steps in order; the clearing and building steps only without `--closures-from`.
 */
export function planSteps(request: CutRequest): PlannedStep[] {
  const tsx = 'node_modules/.bin/tsx'
  const buildArgs = ['delorun/apps/release/src/build-closure.ts', '--version', request.version, '--commit', request.commit, '--out', closureDirectory(request), '--cache', join(request.work, 'cache'), '--artifacts', request.artifacts, ...request.platforms.flatMap(platform => ['--platform', platform])]
  return [
    { id: 'tree', title: `check a clean tracked tree at ${request.commit}`, commands: [`git rev-parse --verify ${request.commit}^{commit}`, 'git rev-parse HEAD', 'git status --porcelain --untracked-files=no'] },
    { id: 'probe', title: `ask ${request.log.submit} which entry key types it accepts`, commands: [`${tsx} ${probeArgs(request).join(' ')}`] },
    { id: 'changelog', title: `assemble the changelog for ${request.version} when it has no entry`, commands: [`${tsx} delorun/apps/release/src/changelog/assemble.ts --version ${request.version}`] },
    { id: 'highlights', title: `write the release notes to ${request.highlights}`, commands: [`${tsx} delorun/apps/release/src/changelog/assemble.ts --version ${request.version} --highlights ${request.highlights}`] },
    ...request.closuresFrom === undefined
      ? [
          { id: 'clear-stages', title: 'clear stale closure build stages', commands: [`remove <build root>-* directories that carry ${BUILD_ROOT_MARKER}, and a build-root lock whose process no longer runs`] } as const,
          { id: 'closure', title: 'build the runtime closure', commands: [`${tsx} ${buildArgs.join(' ')}`] } as const,
        ]
      : [],
    { id: 'sign', title: `sign, log and publish ${request.version} into ${request.channel}`, commands: [`${tsx} ${localReleaseArgs(request).join(' ')}`] },
    { id: 'verify', title: 'verify the channel as a client does', commands: ['timestamp, root chain, manifest, notes and every other release in the channel'] },
    ...request.smokeMinutes === undefined ? [] : [{ id: 'smoke', title: `install ${request.version} from the channel with every pack, restart twice and create a chat (at most ${String(request.smokeMinutes)} min)`, commands: [`${tsx} ${smokeArgs(request).join(' ')}`] } as const],
  ]
}

/**
 * The arguments of the smoke step for `tsx`.
 * @param request - the request.
 * @returns the arguments of `installed-smoke.ts`.
 */
export function smokeArgs(request: CutRequest): string[] {
  return ['delorun/apps/release/scripts/installed-smoke.ts', '--channel', request.channel, '--version', request.version, '--keys', request.keys, '--budget-minutes', String(request.smokeMinutes ?? 30), '--log', join(request.work, `installed-smoke-${request.version}.log`), ...request.smokePrevious === undefined ? [] : ['--previous', request.smokePrevious]]
}

/** The result of one command. */
export interface RunResult {
  /** The exit status; null when killed. */
  readonly status: number | null
  /** Standard output. */
  readonly stdout: string
}

/** What the command runs through, so a spec can stand in for git, the closure build and the log. */
export interface CutDeps {
  /** The repository root, the working directory of every command. */
  readonly repository: string
  /** Run a command; its output is appended to `logFile`. No timeout: a log wait can take half an hour. */
  readonly run: (command: string, args: readonly string[], logFile: string) => Promise<RunResult>
  /** Whether the changelog data file already has an entry for the version. */
  readonly hasChangelogEntry: (version: string) => boolean
  /** Prints one line. */
  readonly say: (line: string) => void
  /** The clock, in milliseconds. */
  readonly now: () => number
}

/** How a finished cut ended. */
export interface CutOutcome {
  /** 0 done, 1 a step failed, 3 stopped for a changelog commit. */
  readonly code: 0 | 1 | 3
  /** What the channel's verification found; present when it ran. */
  readonly verified?: VerifiedChannel
}

/** What {@link verifyChannel} found. */
export interface VerifiedChannel {
  /** The release the stable timestamp names. */
  readonly release: string
  /** The timestamp's version. */
  readonly timestampVersion: number
  /** The notes file's bytes when the manifest names notes. */
  readonly notes: Buffer | undefined
  /** The other releases in the channel, each with a valid manifest signature. */
  readonly others: readonly string[]
  /** How many pack archives the release's signed, logged packs file names; 0 when the release publishes no packs file. */
  readonly packs: number
}

/**
 * Verify a channel directory as a client does, at the current time.
 * @param channel - the channel directory.
 * @param version - the release the timestamp must name.
 * @param now - the clock in Unix seconds.
 * @param chain - the root files the cut was given, oldest first; the channel must serve each of them and the timestamp
 *   must verify under the newest. Without it, the channel's own roots are walked, newest last.
 * @returns what the channel offers.
 * @throws Error naming the first check that fails.
 */
export function verifyChannel(channel: string, version: string, now: number, chain?: readonly string[]): VerifiedChannel {
  const rootFiles = readdirSync(join(channel, 'root')).filter(name => /^\d+\.root\.json$/u.test(name)).sort((left, right) => parseInt(left, 10) - parseInt(right, 10))
  const served = new Map(rootFiles.map(name => [name, readFileSync(join(channel, 'root', name))]))
  const files = chain === undefined ? [...served.values()] : chain.map((path) => {
    const bytes = readFileSync(path)
    const name = `${String(readRoot(bytes).metadata.version)}.root.json`
    const stored = served.get(name)
    if (stored === undefined) throw new Error(`the channel serves no root/${name}, which --root names`)
    if (!stored.equals(bytes)) throw new Error(`the channel's root/${name} is not the file --root names`)
    return bytes
  })
  const roots = trustRootChain(files, now)
  const root = roots.at(-1)!
  const timestampBytes = readFileSync(join(channel, 'timestamp.json'))
  const timestamp = verifyTimestamp(root, timestampBytes, now)
  const pointer = timestamp.channels.stable
  if (pointer.release !== version) throw new Error(`the timestamp names ${pointer.release} as the stable release, not ${version}`)
  const directory = join(channel, 'releases', 'download')
  const manifestBytes = readFileSync(join(directory, `v${version}`, pointer.manifest.name))
  const manifest = verifyChannelManifest(root.metadata, timestamp, 'stable', manifestBytes)
  let notes: Buffer | undefined
  if (manifest.notes !== undefined) {
    notes = readFileSync(join(directory, `v${version}`, manifest.notes.name))
    checkFileRef(manifest.notes, notes)
  }
  const others = readdirSync(directory).filter(name => name.startsWith('v') && name !== `v${version}`).map(name => name.slice(1)).sort()
  for (const other of others) verifySignedManifest(root.metadata, readFileSync(join(directory, `v${other}`, `delorun-${other}.manifest.json`)))
  return { release: pointer.release, timestampVersion: timestamp.version, notes, others, packs: verifyChannelPacks(root.metadata, join(directory, `v${version}`), version, manifestBytes) }
}

/**
 * Verify the packs file of a release directory as the client does: signed by a targets key, bound to the manifest,
 * covered by a verified release-log bundle, and every archive it names present with its length and digests.
 * @param root - the newest trusted root's metadata.
 * @param directory - the release's directory.
 * @param version - the release version.
 * @param manifestBytes - the verified manifest file's bytes.
 * @returns how many distinct pack archives the file names; 0 when the release has no packs file.
 * @throws Error naming the first check that fails.
 */
function verifyChannelPacks(root: Parameters<typeof verifyPacks>[0], directory: string, version: string, manifestBytes: Uint8Array): number {
  const path = join(directory, packsName(version))
  if (!existsSync(path)) return 0
  const packsBytes = readFileSync(path)
  const signed = verifyPacks(root, manifestBytes, packsBytes)
  const bundlePath = join(directory, packsLogName(version))
  if (!existsSync(bundlePath)) throw new Error(`${packsName(version)} has no ${packsLogName(version)}`)
  verifyBundle(root, packsBytes, version, readBundle(readFileSync(bundlePath)), 'packs')
  const archives = new Map(signed.packs.flatMap(pack => Object.values(pack.variants).map(variant => [variant.archive.name, variant.archive] as const)))
  for (const [name, archive] of archives) {
    const bytes = readFileSync(join(directory, name))
    if (bytes.byteLength !== archive.length || createHash('sha256').update(bytes).digest('hex') !== archive.sha256) throw new Error(`${name} does not match the signed packs file`)
  }
  return archives.size
}

/**
 * Remove stale closure build stages: unique build directories next to the fixed root that carry the build-root marker,
 * and the fixed root's lock when the process it records no longer runs.
 * @param buildRoot - the fixed build root `closure.json` names.
 * @returns the paths removed.
 */
export function clearStaleStages(buildRoot: string): string[] {
  const removed: string[] = []
  const parent = dirname(buildRoot)
  if (!existsSync(parent)) return removed
  for (const name of readdirSync(parent)) {
    const path = join(parent, name)
    const mine = path === buildRoot || name.startsWith(`${basename(buildRoot)}-`)
    if (mine && name.endsWith('.lock')) {
      const pid = Number.parseInt(readFileSync(path, 'utf8'), 10)
      if (Number.isSafeInteger(pid) && pid > 0 && processRuns(pid)) throw new Error(`${path} belongs to the running process ${String(pid)}; another build holds the build root`)
      rmSync(path, { force: true })
      removed.push(path)
    } else if (mine && statSync(path).isDirectory() && existsSync(join(path, BUILD_ROOT_MARKER))) {
      rmSync(path, { recursive: true, force: true })
      removed.push(path)
    }
  }
  return removed
}

function processRuns(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // ESRCH means no such process; EPERM means it exists under another user.
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** Format a duration for the log. */
function took(milliseconds: number): string {
  const seconds = Math.round(milliseconds / 1000)
  return seconds < 60 ? `${String(seconds)} s` : `${String(Math.floor(seconds / 60))} min ${String(seconds % 60)} s`
}

/**
 * Print the plan.
 * @param request - the request.
 * @param say - prints one line.
 */
export function printPlan(request: CutRequest, say: (line: string) => void): void {
  say(`cut-rc plan for ${request.version} at ${request.commit} (nothing runs)`)
  planSteps(request).forEach((step, index, all) => {
    say(`[${String(index + 1)}/${String(all.length)}] ${step.title}`)
    for (const command of step.commands) say(`      ${command}`)
  })
  printHandOff(request, say)
}

/**
 * Print the commands the lead runs by hand after a cut.
 * @param request - the request.
 * @param say - prints one line.
 */
function printHandOff(request: CutRequest, say: (line: string) => void): void {
  say('By hand, after the cut:')
  say(`  git tag -a v${request.version} ${request.commit} -m "Delorun ${request.version}" && git push origin v${request.version}`)
  say('  serve the channel (kept running): local-channel.ts serve --channel <dir> --port <n> --state <state> --timestamp-key <timestamp.pem>')
  say('  in the installed home, with the runbook\'s rc wrapper (section 4): rc update --check, rc update --report, rc update')
}

/**
 * Cut one candidate.
 * @param request - the request.
 * @param deps - what the command runs through.
 * @returns how it ended.
 */
export async function cutRelease(request: CutRequest, deps: CutDeps): Promise<CutOutcome> {
  const { say } = deps
  mkdirSync(request.work, { recursive: true })
  const logFile = join(request.work, `cut-rc-${request.version}.log`)
  const steps = planSteps(request)
  const tsx = join(deps.repository, 'node_modules/.bin/tsx')
  const released = releasedVersions(request.channel)
  const previous = previousCandidate(request, released)
  const predecessorRequired = request.iteration !== undefined || request.number > 1
  /** Run a step's command; true when it exits 0. */
  const command = async (executable: string, args: readonly string[]): Promise<RunResult> => deps.run(executable, args, logFile)
  let stepNumber = 0
  const begin = (id: PlannedStep['id']): number => {
    stepNumber = steps.findIndex(step => step.id === id) + 1
    say(`[${String(stepNumber)}/${String(steps.length)}] ${steps[stepNumber - 1]!.title} ...`)
    return deps.now()
  }
  const done = (started: number, note = ''): void => say(`[${String(stepNumber)}/${String(steps.length)}] done in ${took(deps.now() - started)}${note}`)
  function failed(reason: string, next: string, code: 1 | 3 = 1): CutOutcome {
    say(`cut-rc: stopped at step ${String(stepNumber)}: ${reason}`)
    say(`cut-rc: next: ${next}`)
    return { code }
  }

  if (predecessorRequired && (previous === undefined || !released.includes(previous))) {
    const expected = previous ?? `${CANDIDATE.exec(request.version)![1]}-${request.kind}.${String(request.number - 1)}`
    return failed(`the channel has no ${expected} to update from; cut candidates in order`, 'check --channel')
  }
  if (existsSync(join(request.channel, 'releases', 'download', `v${request.version}`))) return failed(`the channel already holds ${request.version}`, 'pick the next candidate; a published version is never replaced')
  for (const key of ['targets.pem', 'timestamp.pem']) if (!existsSync(join(request.keys, key))) return failed(`${join(request.keys, key)} does not exist`, 'check --keys')
  for (const root of request.roots) if (!existsSync(root)) return failed(`${root} does not exist`, 'check --root')
  say(`cut-rc ${request.version}: log in ${logFile}`)

  let started = begin('tree')
  const resolved = (await command('git', ['rev-parse', '--verify', `${request.commit}^{commit}`])).stdout.trim()
  const head = (await command('git', ['rev-parse', 'HEAD'])).stdout.trim()
  if (resolved === '' || resolved !== head) return failed(`HEAD (${head}) is not ${request.commit}`, `check out ${request.commit} (detached) in a worktree and run again`)
  const dirty = (await command('git', ['status', '--porcelain', '--untracked-files=no'])).stdout.trim()
  if (dirty !== '') return failed(`tracked files are modified:\n${dirty}`, 'commit or revert them, then run again')
  done(started)

  started = begin('probe')
  const probed = await command(tsx, probeArgs(request))
  const answers = probed.stdout.trim().split('\n').filter(line => line.startsWith('probe-log:'))
  for (const line of answers) say(`      ${line}`)
  if (probed.status !== 0) return failed('the log accepts none of the entry key types the root lists, so the release could not be logged', `read ${logFile}; a root rotation that lists a type the log accepts is the remedy (release runbook, "Rotate the root to add a log-entry key")`)
  done(started)

  started = begin('changelog')
  if (deps.hasChangelogEntry(request.version)) {
    done(started, ' (the entry exists)')
  } else {
    const assembled = await command(tsx, ['delorun/apps/release/src/changelog/assemble.ts', '--version', request.version])
    if (assembled.status !== 0) return failed('assembling the changelog was refused', `read ${logFile}, fix the fragments, commit, and run again with the new --commit`)
    const changed = (await command('git', ['status', '--porcelain', '--untracked-files=no'])).stdout.trim()
    return failed(`the assembly changed:\n${changed}`, 'review and commit these files (git add delorun/changelog CHANGELOG.md), then run again with --commit <new sha>', 3)
  }

  started = begin('highlights')
  const written = await command(tsx, ['delorun/apps/release/src/changelog/assemble.ts', '--version', request.version, '--highlights', request.highlights])
  if (written.status !== 0) return failed('the release notes were not written', `read ${logFile}`)
  done(started)

  if (request.closuresFrom === undefined) {
    started = begin('clear-stages')
    try {
      const removed = clearStaleStages(readRecipe().closure.buildRoot)
      done(started, removed.length === 0 ? ' (none)' : ` (${String(removed.length)} removed)`)
    } catch (error) {
      return failed((error as Error).message, 'wait for that build or stop it yourself, then run again')
    }
    started = begin('closure')
    const built = await command(tsx, ['delorun/apps/release/src/build-closure.ts', '--version', request.version, '--commit', request.commit, '--out', closureDirectory(request), '--cache', join(request.work, 'cache'), '--artifacts', request.artifacts, ...request.platforms.flatMap(platform => ['--platform', platform])])
    if (built.status !== 0) return failed('the closure build failed', `read ${logFile}; after a fix run again (the build starts clean)`)
    done(started)
  }

  started = begin('sign')
  const signed = await command(tsx, localReleaseArgs(request))
  if (signed.status !== 0) {
    return failed('signing or logging failed; the channel still serves what it served', `read ${logFile}. If the entry reached the log (a checkpoint wait timed out), run log-release.ts with the same endpoints rather than submitting again; otherwise run again with --closures-from ${closureDirectory(request)}`)
  }
  done(started)

  started = begin('verify')
  let verified: VerifiedChannel
  try {
    verified = verifyChannel(request.channel, request.version, Math.floor(deps.now() / 1000), request.roots)
    if ((verified.notes === undefined || !verified.notes.equals(readFileSync(request.highlights)))) throw new Error('the manifest does not sign the release notes written for this candidate')
    if (previous !== undefined && !verified.others.includes(previous)) throw new Error(`${previous} is no longer in the channel`)
  } catch (error) {
    return failed((error as Error).message, 'do not tag; inspect the channel and the log')
  }
  done(started, ` (timestamp ${String(verified.timestampVersion)}${verified.notes === undefined ? ', no notes' : ', signed notes'}; also in the channel: ${verified.others.join(', ') || 'nothing'})`)

  if (request.smokeMinutes !== undefined) {
    started = begin('smoke')
    const smoked = await command(tsx, smokeArgs(request))
    const summary = smoked.stdout.trim().split('\n').filter(line => line.startsWith('installed smoke'))
    for (const line of summary) say(`      ${line}`)
    if (smoked.status !== 0) {
      return failed(`the installed-release smoke failed; ${request.version} is already in the channel directory`, `do not tag or hand it out; read ${join(request.work, `installed-smoke-${request.version}.log`)} and ${logFile}, fix, and cut the next candidate`)
    }
    done(started)
  }
  printHandOff(request, say)
  return { code: 0, verified }
}

/**
 * Run a command with its output appended to a file.
 * @param command - the executable.
 * @param args - its arguments.
 * @param logFile - the log.
 * @param cwd - the working directory.
 * @returns the status and standard output.
 */
function runLogged(command: string, args: readonly string[], logFile: string, cwd: string): Promise<RunResult> {
  return new Promise((done) => {
    appendFileSync(logFile, `$ ${command} ${args.join(' ')}\n`)
    const child = spawn(command, [...args], { cwd, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, CI: '' } })
    let stdout = ''
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); appendFileSync(logFile, chunk) })
    child.stderr.on('data', (chunk: Buffer) => appendFileSync(logFile, chunk))
    child.on('error', (error) => { appendFileSync(logFile, `${error.message}\n`); done({ status: null, stdout }) })
    child.on('close', (status) => { appendFileSync(logFile, `[exit ${String(status)}]\n`); done({ status, stdout }) })
  })
}

/**
 * Run the command.
 * @param argv - the arguments after the script.
 * @returns the exit code: 0 done, 1 a step failed, 2 a wrong command line, 3 stopped for a changelog commit.
 */
export async function main(argv: readonly string[]): Promise<number> {
  let request: CutRequest
  try {
    request = parseCutArgs(argv)
  } catch (error) {
    console.error(`cut-rc: ${error instanceof Error ? error.message : String(error)}`)
    return 2
  }
  if (request.dryRun) {
    printPlan(request, line => console.log(line))
    return 0
  }
  const repository = repositoryRoot(process.cwd())
  const outcome = await cutRelease(request, {
    repository,
    run: (command, args, logFile) => runLogged(command, args, logFile, repository),
    hasChangelogEntry: version => parseData(readFileSync(join(repository, DATA_PATH), 'utf8')).versions.some(entry => entry.version === version),
    say: line => console.log(line),
    now: () => Date.now(),
  })
  return outcome.code
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2))
}
