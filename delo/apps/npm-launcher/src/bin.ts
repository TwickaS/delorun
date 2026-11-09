/**
 * `delorun` as npm serves it: the launcher's entry point, its argument line and the composition of the store, the
 * release channel and the process it starts. The launcher's own options are `--profile`, `--release` and `--help`;
 * every other argument is passed to the runtime unchanged, because the runtime owns `delorun`'s commands.
 *
 * @module @delo/npm-launcher/bin
 */
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'
import { CLI_PROFILE, type RuntimeVersion } from '@delo/contract-home-layout'
import type { VerificationMode } from '@delo/contract-verification-checks'
import { ensureHomeTree, resolveDeloHome } from '@delo/home'
import { Downloader, createTilesLogService, LauncherChannel } from '@delo/install'
import type { DeloLogger } from '@delo/logs'
import { parseRuntimeVersion, RuntimeStore, type LaunchCommand } from '@delo/runtime-store'
import { runLauncher, launcherProfile, type LauncherOutput } from './launcher.ts'
import { LAUNCHER_EXIT, refusalFor } from './refusals.ts'
import { readEmbeddedRoots } from './root.ts'
import { platformOf, RELEASE_LOG_TILES_ORIGIN } from './platform.ts'

/** The launcher's own flag for the CLI profile, which it also passes to the runtime. */
export const PROFILE_FLAG = '--profile'

/** The launcher's own flag for the release to install, which it keeps. */
export const RELEASE_FLAG = '--release'

/** The argument that ends the launcher's own options: every argument after it is the runtime's. */
export const TERMINATOR = '--'

/**
 * The variables a launch never inherits: Node's own module hooks and the dynamic loader's, which a process could use
 * to install code into the runtime's Node before it starts. None of them is a launch protocol variable, so the
 * runtime's environment is the inherited one without these.
 */
const DROPPED_ENV = /^(?:NODE_OPTIONS|NODE_PATH|LD_.*|DYLD_.*)$/u

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
  for (let at = 0; at < argv.length; at++) {
    const argument = argv[at]!
    if (argument === TERMINATOR) {
      runtimeArgs.push(...argv.slice(at + 1))
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
  return { runtimeArgs, help, ...profile === undefined ? {} : { profile }, ...release === undefined ? {} : { release } }
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
function stderrLogger(output: LauncherOutput): DeloLogger {
  return {
    error: message => output.stderr(`${message}\n`),
    warn: message => output.stderr(`${message}\n`),
    info: () => undefined,
    debug: () => undefined,
  }
}

/**
 * Run one launcher invocation.
 * @param argv - the arguments after the script.
 * @param context - the environment and output; this process's by default.
 * @returns the exit code: the runtime's own status, `1` for a refusal the launcher printed, `2` for a wrong command line.
 */
export async function main(argv: readonly string[], context: { readonly env: NodeJS.ProcessEnv, readonly output: LauncherOutput } = {
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
  try {
    const home = await resolveDeloHome(context.env)
    await ensureHomeTree(home.path, profile)
    const downloader = new Downloader()
    // The roots this launcher ships anchor both halves of a run: an install walks from them, and a start trusts the
    // root this home stored only when it is one of them.
    const roots = await readEmbeddedRoots(dirname(dirname(fileURLToPath(import.meta.url))))
    return await runLauncher({
      home: home.path,
      profile,
      platform,
      args: line.runtimeArgs,
      mode: LAUNCHER_MODE,
      store: new RuntimeStore({ home: home.path, platform, logger }),
      channel: new LauncherChannel({
        home: home.path,
        platform,
        roots,
        channel: 'stable',
        log: createTilesLogService({ origin: RELEASE_LOG_TILES_ORIGIN, downloader }),
        downloader,
      }),
      roots,
      logger,
      spawn: spawnRuntime,
      output: context.output,
      ...target === undefined ? {} : { target },
    })
  } catch (error) {
    const refusal = refusalFor(error, { home: '~/.delo', profile })
    context.output.stderr(refusal.text)
    return refusal.exit
  }
}

// The npm package's bin runs this file; importing the module from a spec runs nothing.
if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2))
}
