/**
 * `delorun doctor [--port <n>]`: runs four checks in order, on Linux the
 * sandbox check, then the `changes` lines of [changes](./changes.ts), then reads the running release's release-log check state and
 * the profile's last update check, then the CLI profile's plugins ([plugins](./plugins.ts),
 * [last-start](./last-start.ts); they read manifests, the exemption file, the safe-mode
 * marker and the home process's log, and import and run no plugin code), and prints one
 * line per check, or per plugin. `pass` lines go to standard output; `warn` and `fail`
 * lines go to standard error, with the characters a terminal acts on escaped, because
 * manifests and logs carry text Delo did not write. The checks are described in [checks](./checks.ts) and the record
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
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { HOME_STATUS_TIMEOUT_MS } from '@delo/contract-home-layout'
import type { HomeStatus } from '@delo/contract-home-process'
import { processExists, readHomeLock, resolveDeloHome, runDirectory } from '@delo/home'
import { queryHomeStatus } from '@delo/home-process'
import type { VersionOutput } from '@delo/contract-plugin-versions'
import { parseOptions, type CliCommand, type CommandContext } from '../command.ts'
import { CliError, EXIT } from '../exit.ts'
import { applyLaunchEnvironment } from '../launch-environment.ts'
import { resolveModelKey } from '../model-key.ts'
import { profileDirectory, selectProfile } from '../profile.ts'
import { isSetupProviderId, profileModelSelection, routeKeyReference, SETUP_PROVIDERS } from '../setup/providers.ts'
import { dangerousModeState, dangerousStateLine } from '../setup/dangerous.ts'
import { profileStudioPort } from '../setup/sections.ts'
import { studioAddress } from '../status.ts'
import { escapeDirectories } from '../sandbox-protection.ts'
import { printable } from '../terminal-text.ts'
import { deloVersion, versions } from '../version.ts'
import { checkChanges } from './changes.ts'
import { appArmorRestrictsUserNamespaces, checkSandbox, firstExisting, runBwrapProbe } from './sandbox.ts'
import { checkDocker, checkHome, checkKey, checkPort, dockerProbeEnvironment, resolveStudioPort, runDockerVersion, type CheckName, type CheckResult, type KeySubject } from './checks.ts'
import { checkLastStart } from './last-start.ts'
import { checkPlugins, checkSafeMode } from './plugins.ts'
import { checkImportRecord, checkReleaseLog, type DshImportRecordReader } from './records.ts'
import { checkUpdate } from './update.ts'
import { runtimePlatformOf } from '../update/channel.ts'
import { runtimeOfFile } from '../update/runtime.ts'
import { launcherAnchor } from '../update/trusted-root.ts'

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
  return checkKey(await (applyLaunchEnvironment(home.path, profile), resolveModelKey(context, home.path, subject.variable)), subject)
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
    return incomplete(name, error)
  }
}

/**
 * Run one check that prints several lines, as {@link guarded} runs one that prints one.
 * @param name - the check's name.
 * @param check - the check.
 * @returns the check's results, or one failure line that names the error.
 */
async function guardedLines(name: CheckName, check: () => Promise<readonly CheckResult[]>): Promise<readonly CheckResult[]> {
  try {
    return await check()
  } catch (error) {
    return [incomplete(name, error)]
  }
}

/**
 * The failure line of a check that threw.
 * @param name - the check's name.
 * @param error - what it threw.
 * @returns the line, naming the error on one line.
 */
function incomplete(name: CheckName, error: unknown): CheckResult {
  const reason = error instanceof Error ? error.message : String(error)
  return { name, status: 'fail', message: `the check could not complete: ${reason.replace(/\s*\n\s*/g, ' ')}` }
}

/**
 * The plugin lines of the CLI profile: the installed packages, safe mode, then the load failures of the last start.
 * Each part runs guarded, so a part that throws is one failure line and the others still run.
 * @param context - the command's environment.
 * @param profile - the CLI profile.
 * @param environment - the installation's anchor and the running versions.
 * @returns the lines.
 */
async function pluginLines(context: CommandContext, profile: string, environment: DoctorEnvironment): Promise<readonly CheckResult[]> {
  const home = async (): Promise<string> => (await resolveDeloHome(context.env)).path
  return [
    ...await guardedLines('plugins', async () => checkPlugins({ home: await home(), profile, installAnchor: environment.installAnchor, versions: environment.versions })),
    ...await guardedLines('plugins', async () => {
      const line = checkSafeMode(await home(), profile)
      return line === undefined ? [] : [line]
    }),
    ...await guardedLines('plugins', async () => checkLastStart(await home(), profile)),
  ]
}

/**
 * The printed line of one result, with the characters a terminal acts on escaped.
 * @param result - the result.
 * @returns the line with its newline.
 */
function resultLine(result: CheckResult): string {
  return `${printable(`${result.status} ${result.name}${result.subject === undefined ? '' : ` ${result.subject}`}: ${result.message}`)}\n`
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
  /**
   * The running Delo and DSH versions, which the plugin lines check each installed package's version ranges against.
   * @returns both versions.
   */
  readonly versions: () => VersionOutput
  /**
   * The dsh installation's `package.json`, from which upstream resolves the bundles the installation ships.
   * @returns the absolute path.
   */
  readonly installAnchor: () => string
  /** Reads the stock-home import record; without it the command prints no `import` line. */
  readonly importRecord?: DshImportRecordReader
}

/**
 * `delorun doctor` over an environment.
 * @param environment - the clock, the running versions, the installation's anchor and the optional import-record reader.
 * @returns the command.
 */
export function createDoctorCommand(environment: DoctorEnvironment): CliCommand {
  return {
    name: 'doctor',
    summary: 'Check Docker, the DeepSeek API key format, the home, the studio port, the sandbox, the release-log check, the last update check, your changes and the plugins',
    async run(args, context) {
      const values = parseOptions('doctor', args, { port: { type: 'string' } })
      const option = values.port === undefined ? undefined : parsePort(values.port)
      const profile = selectProfile(undefined, context.env)
      const results = [
        await guarded('home', () => checkHome(context.env, profile)),
        await guarded('docker', () => checkDocker(() => runDockerVersion(dockerProbeEnvironment(context.env)))),
        await guarded('key', () => keyCheck(context, profile)),
        await guarded('port', () => portCheck(context, profile, option)),
        ...process.platform === 'linux' ? [await guarded('sandbox', () => sandboxCheck(context))] : [],
        ...await guardedLines('changes', () => checkChanges(context.env, profile)),
        await guarded('release-log', async () => checkReleaseLog((await resolveDeloHome(context.env)).path, environment.running(), environment.now())),
        await guarded('update', async () => updateCheck(context, profile)),
        ...await pluginLines(context, profile, environment),
      ]
      const dangerous = await dangerousModeCheck(context, profile).catch((error: unknown): CheckResult => ({ name: 'dangerous-mode', status: 'fail', message: `the check could not complete: ${error instanceof Error ? error.message.replace(/\s*\n\s*/g, ' ') : String(error)}` }))
      if (dangerous !== undefined) results.push(dangerous)
      const { importRecord } = environment
      if (importRecord !== undefined) results.push(await guarded('import', async () => checkImportRecord((await resolveDeloHome(context.env)).path, importRecord)))
      for (const result of results) {
        if (result.status === 'pass') context.stdout(resultLine(result))
        else context.stderr(resultLine(result))
      }
      return results.some(result => result.status === 'fail') ? EXIT.failed : EXIT.ok
    },
  }
}

/** `delorun doctor [--port <n>]`, over this process's clock, versions and dsh installation, with no import-record reader. */
export const doctorCommand: CliCommand = createDoctorCommand({
  now: () => Math.floor(Date.now() / 1000),
  running: deloVersion,
  versions,
  installAnchor: () => fileURLToPath(import.meta.resolve('@deepseek-ai/dsh/package.json')),
})
