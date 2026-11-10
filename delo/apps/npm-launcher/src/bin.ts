/**
 * `delorun` as npm serves it: the launcher's main function, its argument line and the composition of the store, the
 * release channel and the process it starts. `entry.ts` is the published `bin`, which checks the Node version and then
 * calls {@link main}. The launcher's own options are `--profile`, `--release` and `--help`;
 * every other argument is passed to the runtime unchanged, because the runtime owns `delorun`'s commands.
 *
 * @module @delo/npm-launcher/bin
 */
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { CLI_PROFILE, DELO_LAUNCHER_ROOTS_ENV, type RuntimeVersion } from '@delo/contract-home-layout'
import type { RootMetadata, RuntimePlatform } from '@delo/contract-release-manifest'
import type { VerificationMode } from '@delo/contract-verification-checks'
import { ensureHomeTree, resolveDeloHome } from '@delo/home'
import { Downloader, LauncherChannel, writeChannelRecord, type ChannelOrigins, type LauncherChannelOptions } from '@delo/install'
import type { ReleaseLogTransport } from '@delo/release-verify/online'
import { checkAndRecord } from '@delo/release-verify/record'
import type { StartCheckResult } from '@delo/release-verify/start'
import { tilesTransport } from '@delo/release-verify/transport'
import type { DeloLogger } from '@delo/logs'
import { parseRuntimeVersion, RuntimeStore, StorePaths, type ChannelRelease, type LaunchCommand } from '@delo/runtime-store'
import { runLauncher, launcherProfile, type LauncherOutput, type SpawnRuntime } from './launcher.ts'
import { progressLines, type LauncherProgress } from './progress.ts'
import { LAUNCHER_EXIT, refusalFor } from './refusals.ts'
import { readEmbeddedRoots, ROOTS_DIRECTORY } from './root.ts'
import { BUILD_CONSTANTS, channelPlan, logPlan, platformOf, type BuildConstants } from './platform.ts'

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
 * an allowlist would remove. None of the dropped variables is a launch protocol variable.
 */
const DROPPED_ENV = /^(?:NODE_OPTIONS|NODE_PATH|NODE_EXTRA_CA_CERTS|NODE_TLS_REJECT_UNAUTHORIZED|NODE_COMPILE_CACHE|NODE_V8_COVERAGE|NODE_ICU_DATA|OPENSSL_CONF|OPENSSL_MODULES|OPENSSL_ENGINES|GCONV_PATH|LOCPATH|LD_.*|DYLD_.*)$/iu

/**
 * The environment a runtime starts with: this process's, without the variables that would load code into the
 * runtime's Node or its dynamic loader, and with the launch protocol's own variables in place of any inherited value.
 * @param inherited - the environment this process was given.
 * @param set - the variables launch protocol 1 sets.
 * @returns the variables to start the runtime with, each a string.
 */
export function launchEnvironment(inherited: NodeJS.ProcessEnv, set: Readonly<Record<string, string>>): Record<string, string> {
  const environment: Record<string, string> = {}
  for (const [name, value] of Object.entries(inherited)) {
    if (value !== undefined && !DROPPED_ENV.test(name)) environment[name] = value
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
 * Split the launcher's own options from the runtime's arguments. The first `--` ends the launcher's options: every
 * argument after it reaches the runtime unchanged, so a runtime option that shares a name with one of the launcher's
 * (`--release`, `--profile`) is the runtime's. The `--` itself is the launcher's and is not passed on.
 * @param argv - the arguments after the script.
 * @returns the parsed line.
 * @throws {Error} when a flag that takes a value has none.
 */
export function parseCommandLine(argv: readonly string[]): LauncherCommandLine {
  let profile: string | undefined
  let release: string | undefined
  let help = false
  const runtimeArgs: string[] = []
  let passedThrough: string[] = []
  for (let at = 0; at < argv.length; at++) {
    const argument = argv[at]!
    if (argument === TERMINATOR) {
      passedThrough = argv.slice(at + 1)
      runtimeArgs.push(...passedThrough)
      break
    }
    if (argument === '--help' || argument === '-h') {
      help = true
    } else if (argument === RELEASE_FLAG || argument.startsWith(`${RELEASE_FLAG}=`)) {
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
    'Usage: delorun [--profile <name>] [--release <version>] [--] [arguments for delorun]',
    '',
    'Runs Delo from the runtime this computer has installed, or installs the release your channel',
    'publishes first. An install checks the release against its signed manifest and the release log',
    'and installs nothing when either check fails; a start with a runtime installed needs no network.',
    '',
    '  --profile <name>   the CLI profile; default is profiles/default',
    '  --release <version>  install this release instead of the channel\'s current one, when no runtime is installed',
    '  --help             this text',
    '  --                 end the launcher\'s options; everything after it is passed to delorun',
    '',
    'Every other argument is passed to delorun unchanged.',
    '',
  ].join('\n')
}

/**
 * Start a runtime and share this process's standard streams with it, with the environment
 * {@link launchEnvironment} builds.
 * @param command - the command the store built for launch protocol 1.
 * @returns the runtime's exit status, or `1` when it ended without one.
 */
export function spawnRuntime(command: LaunchCommand): Promise<number> {
  const child = spawnSync(command.command, [...command.args], { stdio: 'inherit', env: launchEnvironment(process.env, command.env) })
  return Promise.resolve(child.status ?? LAUNCHER_EXIT.failed)
}

/**
 * The logger an early failure is reported through; the launcher's refusals go to standard error itself.
 * @param output - where the launcher writes.
 * @returns the logger.
 */
export function stderrLogger(output: LauncherOutput): DeloLogger {
  return {
    error: message => output.stderr(`${message}\n`),
    warn: message => output.stderr(`${message}\n`),
    info: () => undefined,
    debug: () => undefined,
  }
}

/** What one launcher invocation runs in. */
export interface LauncherContext {
  /** The environment: `DELO_HOME` and `DELO_PROFILE` are read from it. */
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
}

/** What a start check reads. */
export interface StartCheckRequest {
  /** The resolved Delo home. */
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
 * Contract C18's start check of an installed release ("Behaviour per client", the CLI launcher): its stored bundle
 * offline, then the online check, with the checkpoint and the state recorded under `trust/`. The manifest was already
 * verified by the store's start check under the same root.
 * @param request - the home, the platform, the release, the root, the transport and the clock.
 * @returns what the start does: go on, go on with the warning, or stop.
 */
export async function startCheck(request: StartCheckRequest): Promise<StartCheckResult> {
  const files = new StorePaths(request.home, request.platform).releaseFiles(request.version)
  const manifest = await readFile(files.manifest)
  const bundle = await readFile(files.bundle).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  })
  return checkAndRecord(request.home, { root: request.root, version: request.version, manifest, bundle, now: request.now, transport: request.transport, mode: LAUNCHER_MODE })
}

/**
 * The launcher's release channel, which records under `trust/channel.json` the origins this launcher was built with
 * once the store has installed a release from it, so the runtime's own updates fetch from the channel its
 * installation used ([C1](../../../docs/contracts/c01-home-layout.md)). Delo records it only here; a runtime's update
 * reads it and never writes it.
 */
class RecordingChannel extends LauncherChannel {
  /**
   * @param origins - this launcher's build origins.
   * @param options - the channel's options.
   */
  constructor(private readonly origins: ChannelOrigins, private readonly channelOptions: LauncherChannelOptions) {
    super(channelOptions)
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
  let platform: ReturnType<typeof platformOf>
  let target: RuntimeVersion | undefined
  try {
    line = parseCommandLine(argv)
    if (line.help) {
      context.output.stdout(usage())
      return LAUNCHER_EXIT.ok
    }
    profile = launcherProfile(line.profile, context.env)
    platform = platformOf(process.platform, process.arch)
    target = line.release === undefined ? undefined : parseRuntimeVersion(line.release)
    if (line.release !== undefined && target === undefined) throw new Error(`--release names ${line.release}, which is not a Delo release version`)
  } catch (error) {
    const refusal = refusalFor(error, { home: '~/.delo', profile: CLI_PROFILE })
    context.output.stderr(`${refusal.text}\n${usage()}`)
    return LAUNCHER_EXIT.usage
  }
  const logger = stderrLogger(context.output)
  const report = (event: LauncherProgress): void => {
    for (const line of progressLines(event)) context.output.stderr(line)
  }
  try {
    const home = await resolveDeloHome(context.env)
    await ensureHomeTree(home.path, profile)
    const channel = channelPlan(context.constants)
    const downloader = new Downloader({ hosts: channel.rule })
    // The roots this launcher ships anchor both halves of a run: an install walks from them, and a start trusts the
    // root this home stored only when it is one of them.
    const packageDirectory = context.packageDirectory ?? dirname(dirname(fileURLToPath(import.meta.url)))
    const roots = await readEmbeddedRoots(packageDirectory)
    const fetch = context.fetch ?? globalThis.fetch.bind(globalThis)
    // The log is the one the trusted root names, read through `@delo/release-verify`'s transport; a build for a local
    // log names its own origin instead (`logPlan`).
    const transportFor = (root: RootMetadata): ReleaseLogTransport => {
      const log = logPlan(root.log.origin, context.constants)
      return tilesTransport({ fetch, checkpoint: `${log.origin}/checkpoint`, tiles: log.origin })
    }
    const spawn = context.spawn ?? spawnRuntime
    return await runLauncher({
      home: home.path,
      profile,
      platform,
      args: line.runtimeArgs,
      passedThrough: line.passedThrough,
      mode: LAUNCHER_MODE,
      store: new RuntimeStore({ home: home.path, platform, logger }),
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
      // The runtime anchors `delorun verify` on the roots this launcher ships, as this launcher's start does.
      spawn: command => spawn({ ...command, env: { ...command.env, [DELO_LAUNCHER_ROOTS_ENV]: join(packageDirectory, ROOTS_DIRECTORY) } }),
      startCheck: (version, root) => startCheck({ home: home.path, platform, version, root, transport: transportFor(root), now: Math.floor((context.now ?? Date.now)() / 1000) }),
      output: context.output,
      report,
      ...target === undefined ? {} : { target },
    })
  } catch (error) {
    const refusal = refusalFor(error, { home: '~/.delo', profile })
    context.output.stderr(refusal.text)
    return refusal.exit
  }
}
