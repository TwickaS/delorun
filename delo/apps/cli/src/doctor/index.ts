/**
 * `delorun doctor [--port <n>]`: runs four checks in order, on Linux the
 * sandbox check, then reads the running release's release-log check state and
 * the profile's last update check, and prints one line per check.
 * `pass` lines go to standard output; `warn` and `fail` lines go to standard
 * error. The checks are described in [checks](./checks.ts) and the record
 * lines in [records](./records.ts). The stock-home import line is printed only
 * when the command is built with a reader of the import record. The shipped
 * command is built without one: this build has no stock-home import, so
 * nothing writes the record, and a line about it would report a check that
 * reads nothing.
 *
 * Without `--port`, the port check looks at the port the CLI profile's studio
 * uses: the port its own `cordis.patch.yml` sets on the web server row, or
 * upstream's default when it sets none. A port in use is reported as Delo's
 * when this home's home process for the profile answers its `status` request
 * over the update channel with a studio address on that port.
 *
 * The command contacts no model, starts no container and runs no command
 * except the read-only `docker version` probe and, on Linux, `bwrap --ro-bind / / true`, which starts `true` in an
 * empty sandbox, and it creates no file. It reads
 * the DeepSeek key in the order the CLI profile's credential provider resolves
 * it: the reference stored in the home's `.credentials.yaml` first, then the
 * environment, the invoking directory's `.env` and the home's `.env`. The
 * `.env` layers are loaded the way `delorun start` loads them, so this process
 * first gets the launch variables that `delorun start` sets. The `update` check
 * reports the profile's last update check from its record ([update](./update.ts))
 * and sends no request.
 *
 * @module @delo/cli/doctor
 */
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { HOME_STATUS_TIMEOUT_MS } from '@delo/contract-home-layout'
import type { HomeStatus } from '@delo/contract-home-process'
import { processExists, readHomeLock, readProtectedFile, resolveDeloHome, runDirectory } from '@delo/home'
import { queryHomeStatus } from '@delo/home-process'
import { parseDocument } from 'yaml'
import { parseOptions, type CliCommand, type CommandContext } from '../command.ts'
import { CliError, EXIT } from '../exit.ts'
import { applyLaunchEnvironment, loadDeloEnvironment } from '../launch-environment.ts'
import { profileDirectory, selectProfile } from '../profile.ts'
import { isSetupProviderId, profileModelSelection, routeKeyReference, SETUP_PROVIDERS } from '../setup/providers.ts'
import { dangerousModeState, dangerousStateLine } from '../setup/dangerous.ts'
import { profileStudioPort } from '../setup/sections.ts'
import { CREDENTIALS_FILENAME } from '../setup/writes.ts'
import { studioAddress } from '../status.ts'
import { escapeDirectories } from '../sandbox-protection.ts'
import { deloVersion } from '../version.ts'
import { appArmorRestrictsUserNamespaces, checkSandbox, firstExisting, runBwrapProbe } from './sandbox.ts'
import { checkDocker, checkHome, checkKey, checkPort, dockerProbeEnvironment, resolveStudioPort, runDockerVersion, STUDIO_DEFAULT_PORT, type CheckName, type CheckResult, type KeySubject } from './checks.ts'
import { checkImportRecord, checkReleaseLog, type DshImportRecordReader } from './records.ts'
import { checkUpdate } from './update.ts'
import { runtimePlatformOf } from '../update/channel.ts'
import { runtimeOfFile } from '../update/runtime.ts'
import { launcherAnchor } from '../update/trusted-root.ts'

/** The `delorun doctor --help` text. */
const DOCTOR_USAGE = [
  'Usage: delorun doctor [--port <n>]',
  '',
  'Checks the Delo home (home), the Docker engine (docker), the DeepSeek API key\'s format (key), the studio\'s port (port) and,',
  'on Linux, whether bubblewrap can sandbox commands (sandbox),',
  'then reads the running release\'s recorded release-log check (release-log): verified, unchecked since when and why, or refused,',
  'and the last check for a newer release (update), which sends no request.',
  'Prints one line per check: pass on standard output, warn or fail on standard error.',
  'Exit codes: 0 when no check fails, 1 when one fails, 2 for a wrong command line. Warnings do not change the exit code.',
  '',
  'No model is contacted, no request is sent and no command runs, except the read-only probe `docker version` of the Docker',
  'engine and, on Linux, `bwrap --ro-bind / / true`, which runs `true` in an empty sandbox; no container starts. The update line reports the last check delorun made; delorun update --check makes one now.',
  'The key is checked by its format alone, and it is never printed.',
  '',
  `  --port <n>  the loopback port to check, from 1 to 65535 (default: the profile's studio port, or ${String(STUDIO_DEFAULT_PORT)} when the profile sets none)`,
  '',
].join('\n')

/** The layers `delorun start` loads after the stored reference, in the order the credential provider ranks them. */
const ENVIRONMENT_LAYERS = ['process', 'project-env', 'user-env'] as const

/**
 * @param value - a parsed YAML value.
 * @returns whether it is a plain mapping.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * The model key stored in the home's credentials document under a reference. The
 * file is read under C1's protected-file rule. A YAML error is reported by its
 * code only, because the parser's message quotes the source line, which holds the key.
 * @param home - the resolved Delo home.
 * @param variable - the credential reference.
 * @returns the stored value, or `undefined` when the file or its reference is absent or empty.
 * @throws {HomeLayoutError} `SECRET_FILE_MODE` when the file is laxer than 0600.
 * @throws {Error} when the file is not a YAML document.
 */
async function storedKey(home: string, variable: string): Promise<string | undefined> {
  const path = join(home, CREDENTIALS_FILENAME)
  if (!existsSync(path)) return undefined
  const document = parseDocument((await readProtectedFile(path)).toString('utf8'), { uniqueKeys: true })
  const [first] = document.errors
  if (first !== undefined) throw new Error(`${path} is not a readable credentials document (${first.code})`)
  const data: unknown = document.toJS()
  const refs: unknown = isRecord(data) ? data['refs'] : undefined
  const value: unknown = isRecord(refs) ? refs[variable] : undefined
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/**
 * The model key the model would use. The stored reference wins; otherwise
 * the first non-empty value from the environment layers wins. The launch
 * variables are set first because upstream's `.env` loader resolves the Delo
 * home from `DSH_HOME`.
 * @param context - the command's environment and output.
 * @param home - the resolved Delo home.
 * @param profile - the CLI profile, for the launch variables.
 * @param variable - the credential reference the provider reads.
 * @returns the key, or `undefined` when no source sets it.
 * @throws {Error} with the loader's message when a `.env` file sets a name only the launching environment may set, a
 *   `DELO_` name among them.
 * @throws {HomeLayoutError} `SECRET_FILE_MODE` when the credentials document is laxer than 0600.
 */
async function resolveKey(context: CommandContext, home: string, profile: string, variable: string): Promise<string | undefined> {
  applyLaunchEnvironment(home, profile)
  const layered = loadDeloEnvironment(process.cwd(), line => { context.stderr(line) })
  const stored = await storedKey(home, variable)
  if (stored !== undefined) return stored
  for (const source of ENVIRONMENT_LAYERS) {
    const value = layered.getFrom(variable, [source])?.value
    if (value !== undefined && value.length > 0) return value
  }
  return undefined
}

/**
 * The provider whose key new chats need: the route of the profile's `agent-default-model` row, which setup, Settings →
 * Models and the model picker write, or DeepSeek's, the base bundle's, when the profile sets none. The variable is the
 * `apiKeyEnv` the route's row names, or the provider's own.
 * @param home - the resolved Delo home.
 * @param profile - the CLI profile.
 * @returns the key check's subject, or the route's name when the route names no variable, so its adapter finds the key itself.
 * @throws {CliError} `EXIT.failed` when the profile's patch is not a YAML patch list.
 */
function keySubject(home: string, profile: string): KeySubject | string {
  const patchPath = join(profileDirectory(home, profile), 'cordis.patch.yml')
  const { provider } = profileModelSelection(patchPath, 'delorun doctor')
  const variable = routeKeyReference(patchPath, provider, 'delorun doctor')
  if (variable === undefined) return provider
  if (!isSetupProviderId(provider)) return { label: provider, variable, format: 'provider' }
  const known = SETUP_PROVIDERS[provider]
  return { label: known.label, variable, format: known.adapter === 'deepseek' ? 'deepseek' : known.adapter === 'custom' ? 'endpoint' : 'provider' }
}

/**
 * The key check: resolve the home, the provider and its key, then check the key's format.
 * @param context - the command's environment and output.
 * @param profile - the CLI profile.
 * @returns the check's result.
 */
async function keyCheck(context: CommandContext, profile: string): Promise<CheckResult> {
  const home = await resolveDeloHome(context.env)
  const subject = keySubject(home.path, profile)
  if (typeof subject === 'string') {
    return { name: 'key', status: 'warn', message: `new chats start on ${subject}, whose row names no key variable, so its adapter finds the key itself; doctor checks only a key in a named variable.` }
  }
  return checkKey(await resolveKey(context, home.path, profile, subject.variable), subject)
}

/**
 * The update check: resolve the home and this command's runtime, then report the profile's last update check.
 * @param context - the command's environment.
 * @param profile - the CLI profile.
 * @returns the check's result.
 */
async function updateCheck(context: CommandContext, profile: string): Promise<CheckResult> {
  const home = (await resolveDeloHome(context.env)).path
  return checkUpdate(home, profile, runtimeOfFile(home, fileURLToPath(import.meta.url)), () => runtimePlatformOf(process.platform, process.arch), launcherAnchor(home, context.env).root)
}

/**
 * The dangerous-mode check, shown only while the profile's prompts answer is `dangerous`.
 * @param context - the command's environment.
 * @param profile - the CLI profile.
 * @returns a warning that states the mode, or `undefined` while it is off.
 */
export async function dangerousModeCheck(context: CommandContext, profile: string): Promise<CheckResult | undefined> {
  const home = (await resolveDeloHome(context.env)).path
  const line = dangerousStateLine(await dangerousModeState(home, profileDirectory(home, profile)))
  return line === undefined ? undefined : { name: 'dangerous-mode', status: 'warn', message: line }
}

/**
 * Run one check. A failure inside the check becomes that check's failure
 * line, so the remaining checks still run.
 * @param name - the check's name.
 * @param check - the check.
 * @returns the check's result, or a failure line that names the error.
 */
async function guarded(name: CheckName, check: () => Promise<CheckResult>): Promise<CheckResult> {
  try {
    return await check()
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    return { name, status: 'fail', message: `the check could not complete: ${reason.replace(/\s*\n\s*/g, ' ')}` }
  }
}

/**
 * The `--port` value.
 * @param text - the option's value.
 * @returns the port, from 1 to 65535.
 * @throws {CliError} with the usage code for anything but an integer in that range.
 */
export function parsePort(text: string): number {
  const port = /^\d+$/.test(text) ? Number(text) : Number.NaN
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new CliError(EXIT.usage, `delorun doctor: --port must be an integer from 1 to 65535, got ${JSON.stringify(text)}`)
  }
  return port
}

/**
 * The port of the studio this home's home process for a profile serves, from its `status` answer over the update
 * channel, as `delorun status` asks for it.
 * @param home - the resolved Delo home.
 * @param profile - the CLI profile.
 * @returns the port, or `undefined` when no home process runs, it does not answer or refuses, or it serves no studio.
 */
export async function homeStudioPort(home: string, profile: string): Promise<number | undefined> {
  const record = readHomeLock(runDirectory(home, profile))
  if (record === undefined || !processExists(record.pid)) return undefined
  let answer
  try {
    answer = await queryHomeStatus(home, profile, HOME_STATUS_TIMEOUT_MS)
  } catch {
    // No token file, no socket, a refused connection or no line in time: the holder did not answer, so the port is not shown to be Delo's.
    return undefined
  }
  if (!('state' in answer)) return undefined
  const address = studioAddress((answer as HomeStatus).studio)
  if (address === undefined) return undefined
  // URL leaves the port empty when it is the scheme's default.
  return address.port !== '' ? Number(address.port) : address.protocol === 'https:' ? 443 : 80
}

/**
 * The port check: choose the port, then check it.
 * @param context - the command's environment.
 * @param profile - the CLI profile.
 * @param option - the `--port` value, if given.
 * @returns the check's result.
 */
async function portCheck(context: CommandContext, profile: string, option: number | undefined): Promise<CheckResult> {
  const home = async (): Promise<string> => (await resolveDeloHome(context.env)).path
  // With --port the profile is not read, so a port can be checked while the home or its patch is unreadable.
  const configured = option === undefined ? profileStudioPort(profileDirectory(await home(), profile), 'delorun doctor') : undefined
  return checkPort(resolveStudioPort(option, configured, profile), async () => homeStudioPort(await home(), profile))
}

/**
 * The sandbox check, on Linux: bwrap's probe, the AppArmor setting, and the first escape socket directory the start
 * would name that exists.
 * @param context - the command's environment, whose `PATH` finds `bwrap`.
 * @returns the check's result.
 */
async function sandboxCheck(context: CommandContext): Promise<CheckResult> {
  return checkSandbox({
    probe: await runBwrapProbe(context.env.PATH),
    appArmorRestricts: appArmorRestrictsUserNamespaces(),
    escapeDirectory: firstExisting(escapeDirectories(process.getuid?.(), homedir())),
  })
}

/** What the command reads besides the home and the environment. */
export interface DoctorEnvironment {
  /**
   * The clock.
   * @returns Unix seconds.
   */
  readonly now: () => number
  /**
   * The running release's version.
   * @returns the version.
   */
  readonly running: () => string
  /** Reads the stock-home import record; without it the command prints no `import` line. */
  readonly importRecord?: DshImportRecordReader
}

/**
 * `delorun doctor` over an environment.
 * @param environment - the clock, the running version and the optional import-record reader.
 * @returns the command.
 */
export function createDoctorCommand(environment: DoctorEnvironment): CliCommand {
  return {
    name: 'doctor',
    summary: 'Check Docker, the DeepSeek API key format, the home, the studio port, the sandbox, the release-log check and the last update check',
    async run(args, context) {
      if (args.includes('--help') || args.includes('-h')) {
        context.stdout(DOCTOR_USAGE)
        return EXIT.ok
      }
      const values = parseOptions('doctor', args, { port: { type: 'string' } })
      const option = values.port === undefined ? undefined : parsePort(values.port)
      const profile = selectProfile(undefined, context.env)
      const results = [
        await guarded('home', () => checkHome(context.env, profile)),
        await guarded('docker', () => checkDocker(() => runDockerVersion(dockerProbeEnvironment(context.env)))),
        await guarded('key', () => keyCheck(context, profile)),
        await guarded('port', () => portCheck(context, profile, option)),
        ...process.platform === 'linux' ? [await guarded('sandbox', () => sandboxCheck(context))] : [],
        await guarded('release-log', async () => checkReleaseLog((await resolveDeloHome(context.env)).path, environment.running(), environment.now())),
        await guarded('update', async () => updateCheck(context, profile)),
      ]
      const dangerous = await dangerousModeCheck(context, profile).catch((error: unknown): CheckResult => ({ name: 'dangerous-mode', status: 'fail', message: `the check could not complete: ${error instanceof Error ? error.message.replace(/\s*\n\s*/g, ' ') : String(error)}` }))
      if (dangerous !== undefined) results.push(dangerous)
      const { importRecord } = environment
      if (importRecord !== undefined) results.push(await guarded('import', async () => checkImportRecord((await resolveDeloHome(context.env)).path, importRecord)))
      for (const result of results) {
        const line = `${result.status} ${result.name}: ${result.message}\n`
        if (result.status === 'pass') context.stdout(line)
        else context.stderr(line)
      }
      return results.some(result => result.status === 'fail') ? EXIT.failed : EXIT.ok
    },
  }
}

/** `delorun doctor [--port <n>]`, over this process's clock and version, with no import-record reader. */
export const doctorCommand: CliCommand = createDoctorCommand({ now: () => Math.floor(Date.now() / 1000), running: deloVersion })
