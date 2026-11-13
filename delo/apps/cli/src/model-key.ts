/**
 * The model key a command finds the way the model would: the home's credentials document first, then the environment
 * layers. `delorun doctor` checks its format and `delorun headless` refuses to boot without one.
 *
 * @module @delo/cli/model-key
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { readProtectedFile } from '@delo/home'
import { parseDocument } from 'yaml'
import type { CommandContext } from './command.ts'
import { loadDeloEnvironment } from './launch-environment.ts'
import { profileDirectory } from './profile.ts'
import { profileModelSelection, routeKeyReference, SETUP_PROVIDERS, isSetupProviderId } from './setup/providers.ts'
import { CREDENTIALS_FILENAME } from './setup/writes.ts'

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
 * the first non-empty value from the environment layers wins. The caller has
 * set the launch variables, because upstream's `.env` loader resolves the Delorun
 * home from `DSH_HOME`.
 * @param context - the command's environment and output.
 * @param home - the resolved Delorun home.
 * @param variable - the credential reference the provider reads.
 * @returns the key, or `undefined` when no source sets it.
 * @throws {Error} with the loader's message when a `.env` file sets a name only the launching environment may set, a
 *   `DELO_` name among them.
 * @throws {HomeLayoutError} `SECRET_FILE_MODE` when the credentials document is laxer than 0600.
 */
export async function resolveModelKey(context: CommandContext, home: string, variable: string): Promise<string | undefined> {
  const layered = loadDeloEnvironment(process.cwd(), line => { context.stderr(line) })
  const stored = await storedKey(home, variable)
  if (stored !== undefined) return stored
  for (const source of ENVIRONMENT_LAYERS) {
    const value = layered.getFrom(variable, [source])?.value
    if (value !== undefined && value.length > 0) return value
  }
  return undefined
}

/** The key a profile's default model needs before it can answer. */
export interface RequiredModelKey {
  /** The provider's name as the person knows it. */
  readonly label: string
  /** The variable, or credential reference, the key is read from. */
  readonly variable: string
}

/**
 * The key the profile's default model needs: the route of its `agent-default-model` row and that route's key variable.
 * A route whose row names no key variable needs none from the CLI (a mock or keyless route finds its own).
 * @param home - the resolved Delorun home.
 * @param profile - the profile.
 * @param command - the command that starts a refusal's message.
 * @returns the required key, or `undefined` when the CLI cannot name one.
 * @throws {CliError} `EXIT.failed` when the profile's patch is not a YAML patch list.
 */
export function requiredModelKey(home: string, profile: string, command: string): RequiredModelKey | undefined {
  const patchPath = join(profileDirectory(home, profile), 'cordis.patch.yml')
  const { provider } = profileModelSelection(patchPath, command)
  const variable = routeKeyReference(patchPath, provider, command)
  if (variable === undefined) return undefined
  return { label: isSetupProviderId(provider) ? SETUP_PROVIDERS[provider].label : provider, variable }
}
