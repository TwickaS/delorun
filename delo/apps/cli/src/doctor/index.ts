/**
 * `delorun doctor [--port <n>]`: runs four checks in order and prints one line
 * per check. `pass` lines go to standard output; `warn` and `fail` lines go to
 * standard error. The checks are described in [checks](./checks.ts).
 *
 * The command contacts no model, starts no container and runs no command
 * except the read-only `docker version` probe, and it creates no file. It reads
 * the DeepSeek key in the order the CLI profile's credential provider resolves
 * it: the reference stored in the home's `.credentials.yaml` first, then the
 * environment, the invoking directory's `.env` and the home's `.env`. The
 * `.env` layers are loaded the way `delorun start` loads them, so this process
 * first gets the launch variables that `delorun start` sets.
 *
 * @module @delo/cli/doctor
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { loadLayeredEnv } from '@deepseek-ai/dsh-app-boot'
import { SETUP_DEFAULT_CREDENTIAL_VARIABLE } from '@delo/contract-setup-answers'
import { readProtectedFile, resolveDeloHome } from '@delo/home'
import { parseDocument } from 'yaml'
import { parseOptions, type CliCommand, type CommandContext } from '../command.ts'
import { CliError, EXIT } from '../exit.ts'
import { applyLaunchEnvironment } from '../launch-environment.ts'
import { selectProfile } from '../profile.ts'
import { CREDENTIALS_FILENAME } from '../setup/writes.ts'
import { checkDocker, checkHome, checkKey, checkPort, dockerProbeEnvironment, runDockerVersion, STUDIO_DEFAULT_PORT, type CheckName, type CheckResult } from './checks.ts'

/** The `delorun doctor --help` text. */
const DOCTOR_USAGE = [
  'Usage: delorun doctor [--port <n>]',
  '',
  'Checks the Delo home (home), the Docker engine (docker), the DeepSeek API key\'s format (key) and the studio\'s port (port),',
  'and prints one line per check: pass on standard output, warn or fail on standard error.',
  'Exit codes: 0 when no check fails, 1 when one fails, 2 for a wrong command line. Warnings do not change the exit code.',
  '',
  'No model is contacted and no command runs, except the read-only probe `docker version` of the Docker engine; no container starts.',
  'The key is checked by its format alone, and it is never printed.',
  '',
  '  --port <n>  the loopback port to check, from 1 to 65535 (default 3080, the studio\'s port)',
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
 * The DeepSeek key stored in the home's credentials document. The file is read
 * under C1's protected-file rule. A YAML error is reported by its code only,
 * because the parser's message quotes the source line, which holds the key.
 * @param home - the resolved Delo home.
 * @returns the stored value, or `undefined` when the file or its reference is absent or empty.
 * @throws {HomeLayoutError} `SECRET_FILE_MODE` when the file is laxer than 0600.
 * @throws {Error} when the file is not a YAML document.
 */
async function storedKey(home: string): Promise<string | undefined> {
  const path = join(home, CREDENTIALS_FILENAME)
  if (!existsSync(path)) return undefined
  const document = parseDocument((await readProtectedFile(path)).toString('utf8'), { uniqueKeys: true })
  const [first] = document.errors
  if (first !== undefined) throw new Error(`${path} is not a readable credentials document (${first.code})`)
  const data: unknown = document.toJS()
  const refs: unknown = isRecord(data) ? data['refs'] : undefined
  const value: unknown = isRecord(refs) ? refs[SETUP_DEFAULT_CREDENTIAL_VARIABLE] : undefined
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/**
 * The DeepSeek key the model would use. The stored reference wins; otherwise
 * the first non-empty value from the environment layers wins. The launch
 * variables are set first because upstream's `.env` loader resolves the Delo
 * home from `DSH_HOME`.
 * @param context - the command's environment and output.
 * @param home - the resolved Delo home.
 * @param profile - the CLI profile, for the launch variables.
 * @returns the key, or `undefined` when no source sets it.
 * @throws {Error} with the loader's message when a `.env` file sets a name only the launching environment may set.
 * @throws {HomeLayoutError} `SECRET_FILE_MODE` when the credentials document is laxer than 0600.
 */
async function resolveKey(context: CommandContext, home: string, profile: string): Promise<string | undefined> {
  applyLaunchEnvironment(home, profile)
  const layered = loadLayeredEnv('delorun', process.cwd(), line => { context.stderr(line) })
  const stored = await storedKey(home)
  if (stored !== undefined) return stored
  for (const source of ENVIRONMENT_LAYERS) {
    const value = layered.getFrom(SETUP_DEFAULT_CREDENTIAL_VARIABLE, [source])?.value
    if (value !== undefined && value.length > 0) return value
  }
  return undefined
}

/**
 * The key check: resolve the home, then the key, then check its format.
 * @param context - the command's environment and output.
 * @param profile - the CLI profile.
 * @returns the check's result.
 */
async function keyCheck(context: CommandContext, profile: string): Promise<CheckResult> {
  const home = await resolveDeloHome(context.env)
  return checkKey(await resolveKey(context, home.path, profile))
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
 * The `--port` value, or the studio's default port when none is given.
 * @param text - the option's value, if given.
 * @returns the port, from 1 to 65535.
 * @throws {CliError} with the usage code for anything but an integer in that range.
 */
export function parsePort(text: string | undefined): number {
  if (text === undefined) return STUDIO_DEFAULT_PORT
  const port = /^\d+$/.test(text) ? Number(text) : Number.NaN
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new CliError(EXIT.usage, `delorun doctor: --port must be an integer from 1 to 65535, got ${JSON.stringify(text)}`)
  }
  return port
}

/** `delorun doctor [--port <n>]`. */
export const doctorCommand: CliCommand = {
  name: 'doctor',
  summary: 'Check Docker, the DeepSeek API key format, the home and the studio port',
  async run(args, context) {
    if (args.includes('--help') || args.includes('-h')) {
      context.stdout(DOCTOR_USAGE)
      return EXIT.ok
    }
    const values = parseOptions('doctor', args, { port: { type: 'string' } })
    const port = parsePort(values.port)
    const profile = selectProfile(undefined, context.env)
    const results = [
      await guarded('home', () => checkHome(context.env, profile)),
      await guarded('docker', () => checkDocker(() => runDockerVersion(dockerProbeEnvironment(context.env)))),
      await guarded('key', () => keyCheck(context, profile)),
      await guarded('port', () => checkPort(port)),
    ]
    for (const result of results) {
      const line = `${result.status} ${result.name}: ${result.message}\n`
      if (result.status === 'pass') context.stdout(line)
      else context.stderr(line)
    }
    return results.some(result => result.status === 'fail') ? EXIT.failed : EXIT.ok
  },
}
