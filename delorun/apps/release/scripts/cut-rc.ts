/**
 * Cuts the next release candidate in one command: checks the tree, assembles the changelog, builds the runtime closure,
 * signs and logs the release into the local channel with `local-release.ts`, and verifies the channel as a client does.
 * See "Cutting a release candidate" in `delo/apps/release/README.md`.
 *
 * `tsx delo/apps/release/scripts/cut-rc.ts --version <0.1.0-rc.N> --channel <dir> --state <signer state file> --keys <dir>
 * --root <root file> --commit <sha> [--highlights <file>] [--summary <text>] [--work <dir>] [--closures-from <dir>]
 * [--artifacts build|existing] [--platform <platform>]... [--log-submit <url> --log-checkpoint <url> --log-tiles <url>]
 * [--log-poll-seconds <n>] [--dry-run]`
 *
 * `--keys` is a directory holding `targets.pem` and `timestamp.pem`; their contents are passed to no log and no output,
 * only their paths reach the signing command. `--highlights` is where the release-notes file is written (default
 * `<work>/notes-<version>.txt`); candidates from rc.2 on sign it into the manifest as `notes`, rc.1 carries none.
 * `--work` (default: the channel's parent directory) holds the closure, the build cache and `cut-rc-<version>.log`, to
 * which every step's output goes; a step that fails names the log. The log endpoints default to the public Rekor v2
 * instance the release runbook names. `--closures-from` signs closure files an earlier run built and skips the build,
 * which is also how to rerun after a timestamp or logging failure without rebuilding.
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
import { RUNTIME_PLATFORMS, type RuntimePlatform } from '@delo/contract-release-manifest'
import { checkFileRef, trustRootChain, verifyChannelManifest, verifySignedManifest, verifyTimestamp } from '@delo/release-formats/sign/verify'
import { repositoryRoot } from '@delo/tools/src/git.ts'
import { parseData } from '../src/changelog/data.ts'
import { DATA_PATH } from '../src/changelog/paths.ts'
import { BUILD_ROOT_MARKER } from '../src/closure/build-root.ts'
import { readRecipe } from '../src/closure/config.ts'

/** The log endpoints the release runbook names, used when no `--log-*` flag is given. */
const REKOR = {
  submit: 'https://log2025-1.rekor.sigstore.dev/api/v2/log/entries',
  checkpoint: 'https://log2025-1.rekor.sigstore.dev/api/v2/checkpoint',
  tiles: 'https://log2025-1.rekor.sigstore.dev/api/v2/',
} as const

/** A release candidate version and its number. */
const CANDIDATE = /^(\d+\.\d+\.\d+)-rc\.([1-9]\d*)$/u

/** What the command needs. */
export interface CutRequest {
  /** The candidate's version, `<x.y.z>-rc.<n>`. */
  readonly version: string
  /** The candidate's number. */
  readonly number: number
  /** The channel directory `local-release.ts` writes. */
  readonly channel: string
  /** The timestamp signer's state file. */
  readonly state: string
  /** The directory holding `targets.pem` and `timestamp.pem`. */
  readonly keys: string
  /** The signed root file. */
  readonly root: string
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
  /** The platforms to carry. */
  readonly platforms: readonly RuntimePlatform[]
  /** The release log endpoints. */
  readonly log: { readonly submit: string, readonly checkpoint: string, readonly tiles: string }
  /** Seconds between checkpoint polls. */
  readonly logPollSeconds: string
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
      'root': { type: 'string' },
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
      'dry-run': { type: 'boolean', default: false },
    },
  })
  const required = (name: 'version' | 'channel' | 'state' | 'keys' | 'root' | 'commit'): string => {
    const value = values[name]
    if (value === undefined || value === '') throw new Error(`pass --${name}`)
    return value
  }
  const version = required('version')
  const match = CANDIDATE.exec(version)
  if (match === null) throw new Error(`--version ${version} is not a release candidate such as 0.1.0-rc.2`)
  if (values.artifacts !== 'build' && values.artifacts !== 'existing') throw new Error(`--artifacts is build or existing, not ${values.artifacts}`)
  const platforms = [...new Set(values.platform ?? ['linux-x64'])].map((platform) => {
    if (!(RUNTIME_PLATFORMS as readonly string[]).includes(platform)) throw new Error(`--platform ${platform} is not one of ${RUNTIME_PLATFORMS.join(', ')}`)
    return platform as RuntimePlatform
  })
  const channel = resolve(required('channel'))
  const number = Number(match[2])
  const work = resolve(values.work ?? dirname(channel))
  return {
    version,
    number,
    channel,
    state: resolve(required('state')),
    keys: resolve(required('keys')),
    root: resolve(required('root')),
    commit: required('commit'),
    highlights: resolve(values.highlights ?? join(work, `notes-${version}.txt`)),
    summary: values.summary ?? `Release candidate ${String(number)}.`,
    work,
    closuresFrom: values['closures-from'] === undefined ? undefined : resolve(values['closures-from']),
    artifacts: values.artifacts,
    platforms,
    log: { submit: values['log-submit']!, checkpoint: values['log-checkpoint']!, tiles: values['log-tiles']! },
    logPollSeconds: values['log-poll-seconds']!,
    dryRun: values['dry-run'],
  }
}

/** One step of the plan. */
export interface PlannedStep {
  /** A short name, stable for specs. */
  readonly id: 'tree' | 'changelog' | 'highlights' | 'clear-stages' | 'closure' | 'sign' | 'verify'
  /** What the step does, for the log. */
  readonly title: string
  /** The commands it runs, as printable lines; key files appear by path only. */
  readonly commands: readonly string[]
}

/** Whether a candidate signs release notes: rc.2 onward (A360). */
export function signsNotes(request: Pick<CutRequest, 'number'>): boolean {
  return request.number >= 2
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
    'delo/apps/release/src/local-release.ts', '--version', request.version, '--commit', request.commit, '--summary', request.summary,
    '--out', request.channel, '--root', request.root, '--targets-key', join(request.keys, 'targets.pem'), '--timestamp-key', join(request.keys, 'timestamp.pem'),
    '--state', request.state, '--closures-from', closureDirectory(request),
    ...request.platforms.flatMap(platform => ['--platform', platform]),
    '--log-submit', request.log.submit, '--log-checkpoint', request.log.checkpoint, '--log-tiles', request.log.tiles, '--log-poll-seconds', request.logPollSeconds,
    ...signsNotes(request) ? ['--notes', request.highlights] : [],
  ]
}

/**
 * The plan for a request.
 * @param request - the request.
 * @returns the steps in order; the highlights step exists from rc.2, the clearing and building steps only without `--closures-from`.
 */
export function planSteps(request: CutRequest): PlannedStep[] {
  const tsx = 'node_modules/.bin/tsx'
  const buildArgs = ['delo/apps/release/src/build-closure.ts', '--version', request.version, '--commit', request.commit, '--out', closureDirectory(request), '--cache', join(request.work, 'cache'), '--artifacts', request.artifacts, ...request.platforms.flatMap(platform => ['--platform', platform])]
  return [
    { id: 'tree', title: `check a clean tracked tree at ${request.commit}`, commands: [`git rev-parse --verify ${request.commit}^{commit}`, 'git rev-parse HEAD', 'git status --porcelain --untracked-files=no'] },
    { id: 'changelog', title: `assemble the changelog for ${request.version} when it has no entry`, commands: [`${tsx} delo/apps/release/src/changelog/assemble.ts --version ${request.version}`] },
    ...signsNotes(request) ? [{ id: 'highlights', title: `write the release notes to ${request.highlights}`, commands: [`${tsx} delo/apps/release/src/changelog/assemble.ts --version ${request.version} --highlights ${request.highlights}`] } as const] : [],
    ...request.closuresFrom === undefined
      ? [
          { id: 'clear-stages', title: 'clear stale closure build stages', commands: [`remove <build root>-* directories that carry ${BUILD_ROOT_MARKER}, and a build-root lock whose process no longer runs`] } as const,
          { id: 'closure', title: 'build the runtime closure', commands: [`${tsx} ${buildArgs.join(' ')}`] } as const,
        ]
      : [],
    { id: 'sign', title: `sign, log and publish ${request.version} into ${request.channel}`, commands: [`${tsx} ${localReleaseArgs(request).join(' ')}`] },
    { id: 'verify', title: 'verify the channel as a client does', commands: ['timestamp, root chain, manifest, notes and every other release in the channel'] },
  ]
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
}

/**
 * Verify a channel directory as a client does, at the current time.
 * @param channel - the channel directory.
 * @param version - the release the timestamp must name.
 * @param now - the clock in Unix seconds.
 * @returns what the channel offers.
 * @throws Error naming the first check that fails.
 */
export function verifyChannel(channel: string, version: string, now: number): VerifiedChannel {
  const rootFiles = readdirSync(join(channel, 'root')).filter(name => /^\d+\.root\.json$/u.test(name)).sort((left, right) => parseInt(left, 10) - parseInt(right, 10))
  const roots = trustRootChain(rootFiles.map(name => readFileSync(join(channel, 'root', name))), now)
  const root = roots.at(-1)!
  const timestampBytes = readFileSync(join(channel, 'timestamp.json'))
  const timestamp = verifyTimestamp(root, timestampBytes, now)
  const pointer = timestamp.channels.stable
  if (pointer.release !== version) throw new Error(`the timestamp names ${pointer.release} as the stable release, not ${version}`)
  const directory = join(channel, 'releases', 'download')
  const manifest = verifyChannelManifest(root.metadata, timestamp, 'stable', readFileSync(join(directory, `v${version}`, pointer.manifest.name)))
  let notes: Buffer | undefined
  if (manifest.notes !== undefined) {
    notes = readFileSync(join(directory, `v${version}`, manifest.notes.name))
    checkFileRef(manifest.notes, notes)
  }
  const others = readdirSync(directory).filter(name => name.startsWith('v') && name !== `v${version}`).map(name => name.slice(1)).sort()
  for (const other of others) verifySignedManifest(root.metadata, readFileSync(join(directory, `v${other}`, `delorun-${other}.manifest.json`)))
  return { release: pointer.release, timestampVersion: timestamp.version, notes, others }
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
  const previous = `${CANDIDATE.exec(request.version)![1]}-rc.${String(request.number - 1)}`
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

  const released = existsSync(join(request.channel, 'releases', 'download', `v${previous}`))
  if (request.number > 1 && !released) return failed(`the channel has no ${previous} to update from; cut candidates in order`, 'check --channel')
  if (existsSync(join(request.channel, 'releases', 'download', `v${request.version}`))) return failed(`the channel already holds ${request.version}`, 'pick the next candidate; a published version is never replaced')
  for (const key of ['targets.pem', 'timestamp.pem']) if (!existsSync(join(request.keys, key))) return failed(`${join(request.keys, key)} does not exist`, 'check --keys')
  if (!existsSync(request.root)) return failed(`${request.root} does not exist`, 'check --root')
  say(`cut-rc ${request.version}: log in ${logFile}`)

  let started = begin('tree')
  const resolved = (await command('git', ['rev-parse', '--verify', `${request.commit}^{commit}`])).stdout.trim()
  const head = (await command('git', ['rev-parse', 'HEAD'])).stdout.trim()
  if (resolved === '' || resolved !== head) return failed(`HEAD (${head}) is not ${request.commit}`, `check out ${request.commit} (detached) in a worktree and run again`)
  const dirty = (await command('git', ['status', '--porcelain', '--untracked-files=no'])).stdout.trim()
  if (dirty !== '') return failed(`tracked files are modified:\n${dirty}`, 'commit or revert them, then run again')
  done(started)

  started = begin('changelog')
  if (deps.hasChangelogEntry(request.version)) {
    done(started, ' (the entry exists)')
  } else {
    const assembled = await command(tsx, ['delo/apps/release/src/changelog/assemble.ts', '--version', request.version])
    if (assembled.status !== 0) return failed('assembling the changelog was refused', `read ${logFile}, fix the fragments, commit, and run again with the new --commit`)
    const changed = (await command('git', ['status', '--porcelain', '--untracked-files=no'])).stdout.trim()
    return failed(`the assembly changed:\n${changed}`, 'review and commit these files (git add delo/changelog CHANGELOG.md), then run again with --commit <new sha>', 3)
  }

  if (signsNotes(request)) {
    started = begin('highlights')
    const written = await command(tsx, ['delo/apps/release/src/changelog/assemble.ts', '--version', request.version, '--highlights', request.highlights])
    if (written.status !== 0) return failed('the release notes were not written', `read ${logFile}`)
    done(started)
  }

  if (request.closuresFrom === undefined) {
    started = begin('clear-stages')
    try {
      const removed = clearStaleStages(readRecipe().closure.buildRoot)
      done(started, removed.length === 0 ? ' (none)' : ` (${String(removed.length)} removed)`)
    } catch (error) {
      return failed((error as Error).message, 'wait for that build or stop it yourself, then run again')
    }
    started = begin('closure')
    const built = await command(tsx, ['delo/apps/release/src/build-closure.ts', '--version', request.version, '--commit', request.commit, '--out', closureDirectory(request), '--cache', join(request.work, 'cache'), '--artifacts', request.artifacts, ...request.platforms.flatMap(platform => ['--platform', platform])])
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
    verified = verifyChannel(request.channel, request.version, Math.floor(deps.now() / 1000))
    if (signsNotes(request) && (verified.notes === undefined || !verified.notes.equals(readFileSync(request.highlights)))) throw new Error('the manifest does not sign the release notes written for this candidate')
    if (!verified.others.includes(previous) && request.number > 1) throw new Error(`${previous} is no longer in the channel`)
  } catch (error) {
    return failed((error as Error).message, 'do not tag; inspect the channel and the log')
  }
  done(started, ` (timestamp ${String(verified.timestampVersion)}${verified.notes === undefined ? ', no notes' : ', signed notes'}; also in the channel: ${verified.others.join(', ') || 'nothing'})`)
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
