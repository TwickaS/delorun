/**
 * `delorun` as npm serves it: the launcher's main function, its argument line and the composition of the store, the
 * release channel and the process it starts. `entry.ts` is the published `bin`, which checks the Node version and then
 * calls {@link main}. The launcher's own options are `--profile`, `--release` and `--help`, and `delorun repair` (see
 * `repair.ts`) is the launcher's own command;
 * every other argument is passed to the runtime unchanged, because the runtime owns `delorun`'s commands.
 *
 * @module @delorun/npm-launcher/bin
 */
import { spawn as startProcess } from 'node:child_process'
import { constants as osConstants } from 'node:os'
import { fileURLToPath } from 'node:url'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { CLI_PROFILE, DELORUN_LAUNCHER_ROOTS_ENV, DELORUN_LAUNCHER_VERSION_ENV, DROPPED_LAUNCH_ENV, inheritableEnvironment, type RuntimeVersion } from '@delorun/contract-home-layout'
import type { RootMetadata, RuntimePlatform } from '@delorun/contract-release-manifest'
import type { VerificationMode } from '@delorun/contract-verification-checks'
import { ensureHomeTree, resolveDelorunHome } from '@delorun/home'
import { Downloader, LauncherChannel, manualSource, writeChannelRecord, type ChannelOrigins, type LauncherChannelOptions } from '@delorun/install'
import type { ReleaseLogTransport } from '@delorun/release-verify/online'
import { checkAndRecord } from '@delorun/release-verify/record'
import { tilesTransport } from '@delorun/release-verify/transport'
import type { DelorunLogger } from '@delorun/logs'
import { FULL_CHECK_DAYS_ENV, parseRuntimeVersion, resolveFullCheckDays, RuntimeStore, StorePaths, type ChannelRelease, type LaunchCommand } from '@delorun/runtime-store'
import { createInterface } from 'node:readline/promises'
import { REPAIR_MARK_GRACE_ENV, resolveRepairMarkGraceSeconds } from './repair-record.ts'
import { installedChannel, parseRepairLine, repairUnconfirmed, runRepair, type RepairLine } from './repair.ts'
import { runLauncher, launcherProfile, runtimeCommand, type LauncherOutput, type LauncherStartCheck, type SpawnRuntime } from './launcher.ts'
import { createRenderer, type LauncherProgress, type RenderStream } from './progress.ts'
import { LAUNCHER_EXIT, refusalFor } from './refusals.ts'
import { readEmbeddedRoots, ROOTS_DIRECTORY } from './root.ts'
import { BUILD_CONSTANTS, channelPlan, hostRefusal, logPlan, platformOf, type BuildConstants } from './platform.ts'

/** The launcher's own flag for the CLI profile, which it also passes to the runtime. */
export const PROFILE_FLAG = '--profile'

/** The launcher's own flag for the release to install, which it keeps. */
export const RELEASE_FLAG = '--release'

/** The argument that ends the launcher's own options: every argument after it is the runtime's. */
export const TERMINATOR = '--'

/**
 * The variables a launch never inherits, matched without regard to case because a Windows environment is case
 * insensitive: Node's own module hooks and caches (`NODE_OPTIONS`, `NODE_PATH`, `NODE_COMPILE_CACHE`, `NODE_V8_COVERAGE`,
 * `NODE_ICU_DATA`), its trust settings (`NODE_EXTRA_CA_CERTS`, `NODE_TLS_REJECT_UNAUTHORIZED`), OpenSSL's configuration
 * and module directories (`OPENSSL_CONF`, `OPENSSL_MODULES`, `OPENSSL_ENGINES`, which load code), and the dynamic loader's
 * and C library's (`LD_*`, `DYLD_*`, `GCONV_PATH`, `LOCPATH`). A process could use any of them to install code into the
 * runtime's Node before it starts or to stand between it and every HTTPS connection. The rest of the environment passes:
 * the runtime runs the person's commands and tools, which need `PATH`, credentials, agents and toolchain variables that
 * an allowlist would remove. None of the dropped variables is a launch protocol variable, except `DELORUN_LAUNCHER_*`: an
 * inherited value of those is dropped too, so the runtime sees only what this launcher sets, and a variable this
 * launcher has no value for, such as `DELORUN_LAUNCHER_VERSION` when its own version does not read, is absent. The same
 * names are refused from a discovered `.env` by upstream's `loadLayeredEnv` (`BOOTSTRAP_NAMES` and
 * `BOOTSTRAP_PREFIXES` in `@deepseek-ai/dsh-app-boot`), so no file that arrives with a repository sets one inside the
 * runtime either; `tests/environment-denylist.integration.spec.ts` holds the two lists together.
 */
export const DROPPED_ENV = new RegExp(`${DROPPED_LAUNCH_ENV.source.slice(0, -2)}|DELORUN_LAUNCHER_.*)$`, 'iu')

/**
 * The environment a runtime starts with: this process's, without the variables that would load code into the
 * runtime's Node or its dynamic loader (`DROPPED_LAUNCH_ENV`), and with the launch protocol's own variables in place of any inherited value.
 * @param inherited - the environment this process was given.
 * @param set - the variables launch protocol 1 sets.
 * @returns the variables to start the runtime with, each a string.
 */
export function launchEnvironment(inherited: NodeJS.ProcessEnv, set: Readonly<Record<string, string>>): Record<string, string> {
  const environment: Record<string, string> = {}
  for (const [name, value] of Object.entries(inheritableEnvironment(inherited))) {
    if (!DROPPED_ENV.test(name)) environment[name] = value
  }
  return { ...environment, ...set }
}

/** The version check the launcher runs until the person's `integrity.mode` is read here; the check stops a start in every mode. */
export const LAUNCHER_MODE: VerificationMode = 'enforce'

/** A parsed launcher command line. */
export interface LauncherCommandLine {
  /** The `--profile` value, when one was given. */
  readonly profile?: string
  /** The `--release` value, when one was given. */
  readonly release?: string
  /** Everything the runtime receives, `--profile` included. */
  readonly runtimeArgs: readonly string[]
  /** The arguments after the first `--`, which the launcher did not read; also at the end of {@link runtimeArgs}. */
  readonly passedThrough: readonly string[]
  /** Whether `--help` was asked for. */
  readonly help: boolean
}

/**
 * Split the launcher's own options from the runtime's arguments. The launcher reads `--release` and `--help` only before
 * the runtime's command word (or after `repair`, the launcher's own command), so `delorun verify --release <version>`
 * and `delorun start --help` reach the runtime. The first `--` ends the launcher's options: every argument after it
 * reaches the runtime unchanged, so a runtime option that shares a name with one of the launcher's (`--release`,
 * `--profile`) is the runtime's. The `--` itself is the launcher's and is not passed on.
 * @param argv - the arguments after the script.
 * @returns the parsed line.
 * @throws {Error} when a flag that takes a value has none.
 */
export function parseCommandLine(argv: readonly string[]): LauncherCommandLine {
  let profile: string | undefined
  let release: string | undefined
  let help = false
  let command: string | undefined
  const runtimeArgs: string[] = []
  let passedThrough: string[] = []
  for (let at = 0; at < argv.length; at++) {
    const argument = argv[at]!
    if (argument === TERMINATOR) {
      passedThrough = argv.slice(at + 1)
      runtimeArgs.push(...passedThrough)
      break
    }
    // After the runtime's command word, `--help` and `--release` are that command's own options; `repair` is the
    // launcher's command and keeps reading them.
    const launcherOptions = command === undefined || command === 'repair'
    if (launcherOptions && (argument === '--help' || argument === '-h')) {
      help = true
    } else if (launcherOptions && (argument === RELEASE_FLAG || argument.startsWith(`${RELEASE_FLAG}=`))) {
      const inline = argument.startsWith(`${RELEASE_FLAG}=`) ? argument.slice(RELEASE_FLAG.length + 1) : undefined
      if (inline !== undefined) {
        release = inline
      } else {
        const value = argv[++at]
        if (value === undefined) throw new Error(`${RELEASE_FLAG} needs a release version`)
        release = value
      }
    } else {
      if (argument === PROFILE_FLAG) {
        const value = argv[++at]
        if (value === undefined) throw new Error(`${PROFILE_FLAG} needs a profile name`)
        profile = value
      } else if (argument.startsWith(`${PROFILE_FLAG}=`)) {
        profile = argument.slice(PROFILE_FLAG.length + 1)
      } else if (command === undefined && !argument.startsWith('-')) {
        command = argument
      }
      runtimeArgs.push(argument, ...argument === PROFILE_FLAG ? [profile!] : [])
    }
  }
  return { runtimeArgs, passedThrough, help, ...profile === undefined ? {} : { profile }, ...release === undefined ? {} : { release } }
}

/**
 * The usage text.
 * @returns the lines describing the launcher's own options.
 */
export function usage(): string {
  return [
    'Usage: delorun [--profile <name>] [--release <version>] [--] [command and arguments for delorun]',
    '',
    'Runs Delorun from the runtime this computer has installed, or installs the release your channel',
    'publishes first. An install checks the release against its signed manifest and the release log',
    'and installs nothing when either check fails; a start with a runtime installed needs no network.',
    '',
    '  --profile <name>   the CLI profile; default is profiles/default',
    '  --release <version>  install this release instead of the channel\'s current one, when no runtime is installed',
    '  --help             this text',
    '',
    'delorun repair [--release <version>] [--from <folder|https-address>] [--restore-copy] [--reset-trust]',
    '  Replaces the installed program with a verified release and keeps your chats, settings and keys.',
    '  It asks you first, in a terminal; the old program is set aside, never deleted.',
    '  --                 end the launcher\'s options; everything after it is passed to delorun',
    '',
    'The launcher reads --release and --help only before the command word; after it they are the command\'s own.',
    '',
    'Every other argument is passed to delorun unchanged.',
    '',
    'Every start checks the installed runtime against its signed file list. It hashes every file before',
    'delorun verify runs, and otherwise once the last full check its record names is 7 days old;',
    `${FULL_CHECK_DAYS_ENV} sets that interval from 0 (every start) to 30 days.`,
    `A repair mark that does not parse counts as a running repair for 5 seconds; ${REPAIR_MARK_GRACE_ENV} sets that from 1 to 60.`,
    '',
  ].join('\n')
}

/**
 * The signals the launcher passes on to the runtime. SIGINT is not one: the terminal sends Ctrl-C to the whole foreground
 * process group, so the runtime already has it, and a second SIGINT would make its stop abrupt (a second one ends it at once).
 */
const FORWARDED_SIGNALS = ['SIGTERM', 'SIGHUP'] as const

/**
 * Start a runtime and share this process's standard streams with it, with the environment
 * {@link launchEnvironment} builds. While the runtime runs, a SIGTERM or SIGHUP this process receives is passed on to it,
 * and a SIGINT is left to the terminal, which sends it to the runtime too; the launcher stays until the runtime has ended.
 * @param command - the command the store built for launch protocol 1.
 * @returns the runtime's exit status; `128` plus the signal's number when a signal ended it.
 * @throws {Error} when the runtime cannot be started.
 */
export function spawnRuntime(command: LaunchCommand): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const child = startProcess(command.command, [...command.args], { stdio: 'inherit', env: launchEnvironment(process.env, command.env) })
    const forwards = FORWARDED_SIGNALS.map(signal => [signal, () => { child.kill(signal) }] as const)
    // Listening for SIGINT replaces Node's default, which would end the launcher while the runtime stops.
    const interrupt = (): void => undefined
    for (const [signal, forward] of forwards) process.on(signal, forward)
    process.on('SIGINT', interrupt)
    const settle = (): void => {
      for (const [signal, forward] of forwards) process.off(signal, forward)
      process.off('SIGINT', interrupt)
    }
    child.once('error', (error) => { settle(); reject(error) })
    child.once('close', (status, signal) => {
      settle()
      resolve(status ?? (signal === null ? LAUNCHER_EXIT.failed : 128 + osConstants.signals[signal]))
    })
  })
}

/**
 * The logger an early failure is reported through; the launcher's refusals go to standard error itself.
 * @param output - where the launcher writes.
 * @returns the logger.
 */
export function stderrLogger(output: LauncherOutput): DelorunLogger {
  return {
    error: message => output.stderr(`${message}\n`),
    warn: message => output.stderr(`${message}\n`),
    info: () => undefined,
    debug: () => undefined,
  }
}

/** What one launcher invocation runs in. */
export interface LauncherContext {
  /** The environment: `DELORUN_HOME` and `DELORUN_PROFILE` are read from it. */
  readonly env: NodeJS.ProcessEnv
  /** Where the launcher writes. */
  readonly output: LauncherOutput
  /** The package directory whose `roots/` the launcher trusts; this package's own by default. */
  readonly packageDirectory?: string | undefined
  /** The origins to read the channel and the log from; this build's by default. */
  readonly constants?: BuildConstants | undefined
  /** Starts the installed runtime; {@link spawnRuntime} by default. */
  readonly spawn?: SpawnRuntime | undefined
  /** The fetch the release-log check reads through; this process's by default. */
  readonly fetch?: typeof globalThis.fetch | undefined
  /** The clock, in milliseconds; `Date.now` by default. */
  readonly now?: (() => number) | undefined
  /** The host's `process.platform`, which native Windows and macOS refuse before any download, and which names the runtime closure; this process's by default. */
  readonly hostPlatform?: string | undefined
  /** The host's `process.arch`, which Linux on arm64 refuses before any download, and which names the runtime closure; this process's by default. */
  readonly hostArch?: string | undefined
  /** Asks `delorun repair`'s yes/no question; `undefined` answers when there is no terminal. This process's terminal by default. */
  readonly confirm?: ((question: string) => Promise<boolean | undefined>) | undefined
  /** The stream the install's progress is drawn on, for its terminal flag and width; standard error by default. */
  readonly progressStream?: RenderStream | undefined
}

/**
 * Whether the arguments are those of a bare `delorun`: nothing but `--profile` with its value and the two start options,
 * so `delorun --version` is not.
 * @param args - the runtime's arguments.
 * @returns true when no other argument is given.
 */
function isBare(args: readonly string[]): boolean {
  for (let at = 0; at < args.length; at++) {
    if (args[at] === '--profile') at++
    else if (args[at] !== '--foreground' && args[at] !== '--background') return false
  }
  return true
}

/**
 * What a first install tells the person comes next, or nothing when the command they gave says it already: a bare
 * `delorun` starts setup on a home without the CLI profile (its `package.json` under `profiles/<profile>`) and the
 * studio on one that has it, and `setup` and `start` name theirs.
 * @param line - the parsed command line.
 * @param home - the resolved Delorun home.
 * @param profile - the CLI profile.
 * @returns the line without its `Next:`, or `undefined` for any other command.
 */
export function installedNext(line: LauncherCommandLine, home: string, profile: string): string | undefined {
  const command = runtimeCommand(line.runtimeArgs)
  if (command === 'setup') return 'a few setup questions'
  if (command === 'start') return 'opening the studio'
  if (command !== undefined || !isBare(line.runtimeArgs)) return undefined
  return existsSync(join(home, 'profiles', profile, 'package.json')) ? 'opening the studio' : 'a few setup questions'
}

/**
 * Ask a yes/no question on this process's terminal.
 * @param question - the question.
 * @returns whether the person typed `y` or `yes`, or `undefined` when standard input or output is not a terminal.
 */
export async function terminalConfirm(question: string): Promise<boolean | undefined> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return undefined
  const lines = createInterface({ input: process.stdin, output: process.stdout })
  try {
    return /^y(?:es)?$/iu.test((await lines.question(`${question} `)).trim())
  } finally {
    lines.close()
  }
}

/** What a start check reads. */
export interface StartCheckRequest {
  /** The resolved Delorun home. */
  readonly home: string
  /** The platform whose release files the store keeps. */
  readonly platform: RuntimePlatform
  /** The installed release `current` names. */
  readonly version: RuntimeVersion
  /** The root the store's start check verified the release with. */
  readonly root: RootMetadata
  /** The transport to the log the root names. */
  readonly transport: ReleaseLogTransport
  /** The clock, in Unix seconds. */
  readonly now: number
}

/**
 * This launcher package's own version, the `version` its `package.json` names, which the runtime pins `delorun setup`'s
 * install to and `delorun verify` compares with the release's signed `npm` entries.
 * @param packageDirectory - the launcher package's directory.
 * @returns the version; `undefined` when the file does not read or names no version, so the runtime is told none.
 */
export async function launcherVersion(packageDirectory: string): Promise<string | undefined> {
  let manifest: unknown
  try {
    manifest = JSON.parse(await readFile(join(packageDirectory, 'package.json'), 'utf8'))
  } catch (_unreadable) {
    // A launcher whose own package.json does not read tells the runtime no version; setup then offers no install.
    return undefined
  }
  const version = typeof manifest === 'object' && manifest !== null && 'version' in manifest ? manifest.version : undefined
  return typeof version === 'string' && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(version) ? version : undefined
}

/**
 * Contract C18's start check of an installed release ("Behaviour per client", the CLI launcher): its stored bundle
 * offline, then the online check, with the checkpoint and the state recorded under `trust/`. The manifest was already
 * verified by the store's start check under the same root. A missing bundle stops the start: the store installed the
 * release with the bundle it verified.
 * @param request - the home, the platform, the release, the root, the transport and the clock.
 * @returns what the start does: go on, go on with the warning, or stop; with the bundle's path when none is stored.
 */
export async function startCheck(request: StartCheckRequest): Promise<LauncherStartCheck> {
  const files = new StorePaths(request.home, request.platform).releaseFiles(request.version)
  const manifest = await readFile(files.manifest)
  const bundle = await readFile(files.bundle).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  })
  const result = await checkAndRecord(request.home, { root: request.root, version: request.version, manifest, bundle, missingBundle: 'failed', now: request.now, transport: request.transport, mode: LAUNCHER_MODE })
  return bundle === undefined ? { ...result, missingBundle: files.bundle } : result
}

/**
 * The launcher's release channel, which records under `trust/channel.json` the origins this launcher was built with
 * once the store has installed a release from it, so the runtime's own updates fetch from the channel its
 * installation used ([C1](../../../docs/contracts/c01-home-layout.md)). Delorun records it only here; a runtime's update
 * reads it and never writes it.
 */
class RecordingChannel extends LauncherChannel {
  /** This launcher's build origins, which the channel record names. */
  private readonly origins: ChannelOrigins
  /** The channel's options, whose home receives the record. */
  private readonly channelOptions: LauncherChannelOptions

  /**
   * @param origins - this launcher's build origins.
   * @param channelOptions - the channel's options.
   */
  constructor(origins: ChannelOrigins, channelOptions: LauncherChannelOptions) {
    super(channelOptions)
    this.origins = origins
    this.channelOptions = channelOptions
  }

  override async recordInstalled(release: ChannelRelease): Promise<void> {
    await super.recordInstalled(release)
    await writeChannelRecord(this.channelOptions.home, this.origins)
  }
}

/**
 * Run one launcher invocation.
 * @param argv - the arguments after the script.
 * @param context - the environment and output; this process's by default. The other fields exist for specs: a run
 *   from the published package leaves them out, so the roots are the package's own and the origins are the build's.
 * @returns the exit code: the runtime's own status, `1` for a refusal the launcher printed, `2` for a wrong command line.
 */
export async function main(argv: readonly string[], context: LauncherContext = {
  env: { ...process.env },
  output: { stdout: text => void process.stdout.write(text), stderr: text => void process.stderr.write(text) },
}): Promise<number> {
  let line: LauncherCommandLine
  let profile: string
  let target: RuntimeVersion | undefined
  let fullCheckDays: number
  let repairMarkGraceSeconds: number
  let repairLine: RepairLine | undefined
  try {
    line = parseCommandLine(argv)
    if (line.help) {
      context.output.stdout(usage())
      return LAUNCHER_EXIT.ok
    }
    const host = hostRefusal(context.hostPlatform ?? process.platform, await launcherVersion(context.packageDirectory ?? dirname(dirname(fileURLToPath(import.meta.url)))), context.hostArch ?? process.arch)
    if (host !== undefined) {
      context.output.stderr(`${host}\n`)
      return LAUNCHER_EXIT.failed
    }
    profile = launcherProfile(line.profile, context.env)
    target = line.release === undefined ? undefined : parseRuntimeVersion(line.release)
    if (line.release !== undefined && target === undefined) throw new Error(`--release names ${line.release}, which is not a Delorun release version`)
    fullCheckDays = resolveFullCheckDays(context.env[FULL_CHECK_DAYS_ENV])
    repairMarkGraceSeconds = resolveRepairMarkGraceSeconds(context.env[REPAIR_MARK_GRACE_ENV])
    if (line.passedThrough.length === 0 && runtimeCommand(line.runtimeArgs) === 'repair') repairLine = parseRepairLine(line.runtimeArgs, target)
  } catch (error) {
    const refusal = refusalFor(error, { home: '~/.delorun', profile: CLI_PROFILE })
    context.output.stderr(`${refusal.text}\n${usage()}`)
    return LAUNCHER_EXIT.usage
  }
  let platform: ReturnType<typeof platformOf>
  try {
    platform = platformOf(context.hostPlatform ?? process.platform, context.hostArch ?? process.arch)
  } catch (error) {
    // A host no release publishes a runtime for is a refusal of the host, like native Windows and macOS, not a wrong command line.
    context.output.stderr(`${error instanceof Error ? error.message : String(error)}\n`)
    return LAUNCHER_EXIT.failed
  }
  const logger = stderrLogger(context.output)
  // The home is resolved inside the try below; `starting` comes after it.
  let homePath = ''
  const progress = createRenderer(text => { context.output.stderr(text) }, context.progressStream ?? process.stderr, context.env)
  const report = (event: LauncherProgress): void => {
    progress.handle(event)
    if (event.step === 'starting') progress.finish(installedNext(line, homePath, profile))
  }
  try {
    const home = await resolveDelorunHome(context.env)
    homePath = home.path
    await ensureHomeTree(home.path, profile)
    const channel = channelPlan(context.constants)
    const downloader = new Downloader({ hosts: channel.rule })
    // The roots this launcher ships anchor both halves of a run: an install walks from them, and a start trusts the
    // root this home stored only when it is one of them.
    const packageDirectory = context.packageDirectory ?? dirname(dirname(fileURLToPath(import.meta.url)))
    const roots = await readEmbeddedRoots(packageDirectory)
    const version = await launcherVersion(packageDirectory)
    const fetch = context.fetch ?? globalThis.fetch.bind(globalThis)
    // The log is the one the trusted root names, read through `@delorun/release-verify`'s transport; a build for a local
    // log names its own origin instead (`logPlan`).
    const transportFor = (root: RootMetadata): ReleaseLogTransport => {
      const log = logPlan(root.log.origin, context.constants)
      return tilesTransport({ fetch, checkpoint: `${log.origin}/checkpoint`, tiles: log.origin })
    }
    const spawn = context.spawn ?? spawnRuntime
    const store = new RuntimeStore({ home: home.path, platform, logger })
    if (repairLine !== undefined) {
      const manual = repairLine.from === undefined ? undefined : manualSource(repairLine.from)
      const ask = context.confirm ?? terminalConfirm
      // A question is asked on the terminal the checklist is drawn on, so the checklist waits for the answer.
      const confirm = async (question: string): Promise<boolean | undefined> => {
        progress.suspend()
        try {
          return await ask(question)
        } finally {
          progress.resume()
        }
      }
      const unconfirmed = await repairUnconfirmed(repairLine, confirm)
      const releaseChannel = await installedChannel(home.path, store, roots)
      return await runRepair({
        belowFloorAsked: unconfirmed?.asked ?? (() => false),
        releaseChannel,
        home: home.path,
        profile,
        line: repairLine,
        roots,
        store,
        channel: new RecordingChannel(context.constants ?? BUILD_CONSTANTS, { home: home.path, platform, roots, channel: releaseChannel, productionRoot: (context.constants ?? BUILD_CONSTANTS).channelOrigin === undefined, log: transportFor, source: manual?.source ?? channel.source, downloader: manual?.downloader ?? downloader, progress: report, ...unconfirmed === undefined ? {} : { unconfirmed: unconfirmed.install } }),
        confirm,
        startCheck: async (version, root) => {
          await store.checkRuntime(version, root)
          const check = await startCheck({ home: home.path, platform, version, root, transport: transportFor(root), now: Math.floor((context.now ?? Date.now)() / 1000) })
          if (check.stop) throw new Error(`the release-log check of release ${String(version)} failed (${String(check.refusal)}${check.detail === undefined ? '' : `: ${check.detail}`})`)
        },
        output: context.output,
        now: () => new Date((context.now ?? Date.now)()),
        repairMarkGraceSeconds,
        progress,
      })
    }
    return await runLauncher({
      home: home.path,
      profile,
      platform,
      args: line.runtimeArgs,
      passedThrough: line.passedThrough,
      mode: LAUNCHER_MODE,
      fullCheckDays,
      repairMarkGraceSeconds,
      store,
      channel: new RecordingChannel(context.constants ?? BUILD_CONSTANTS, {
        home: home.path,
        platform,
        roots,
        channel: 'stable',
        // The log is the one the trusted root names, read under a host rule of its own: the downloader keeps contract
        // C1's release-file rule, and neither rule has to name the other's hosts.
        log: transportFor,
        source: channel.source,
        downloader,
        progress: report,
      }),
      roots,
      logger,
      // The runtime anchors `delorun verify` on the roots this launcher ships, as this launcher's start does, and pins
      // setup's install of the delorun command to this launcher's version.
      spawn: command => spawn({ ...command, env: { ...command.env, [DELORUN_LAUNCHER_ROOTS_ENV]: join(packageDirectory, ROOTS_DIRECTORY), ...version === undefined ? {} : { [DELORUN_LAUNCHER_VERSION_ENV]: version } } }),
      startCheck: (version, root) => startCheck({ home: home.path, platform, version, root, transport: transportFor(root), now: Math.floor((context.now ?? Date.now)() / 1000) }),
      identity: { version: version ?? null, path: packageDirectory, now: context.now ?? Date.now },
      output: context.output,
      report,
      ...target === undefined ? {} : { target },
    })
  } catch (error) {
    progress.fail()
    const refusal = refusalFor(error, { home: '~/.delorun', profile })
    context.output.stderr(refusal.text)
    return refusal.exit
  }
}
