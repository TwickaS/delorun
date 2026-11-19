/**
 * Service Definition for the subprocess capability seam (`ctx.subprocess`): execution-world executable lookup,
 * fully specified provider-managed process ranges with raw or
 * collected stdio, and one terminal-process primitive. Command defaulting,
 * shell semantics, deadlines, protocol framing, terminal readiness, and
 * presentation belong to consumers. The local implementation lives in
 * `@deepseek-ai/dsh-subprocess-local`.
 * @module @deepseek-ai/dsh-subprocess
 */

import { delimiter } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import { proxyEnvironmentForChild } from '@deepseek-ai/dsh-http-proxy'
import { DSH_ENV_PREFIX } from './types.ts'
import type { SubprocessHandle, SubprocessSpawnSpec } from './types.ts'
import type { SubprocessTerminalEnvironment, SubprocessTerminalHandle, SubprocessTerminalSpawnSpec } from './types.ts'

export { DSH_ENV_PREFIX } from './types.ts'
export {
  SUBPROCESS_ERROR_CODES,
  SubprocessError,
  SubprocessExecutableNotFoundError,
  subprocessSpawnFailure,
  type SubprocessErrorCode,
} from './error.ts'
export type {
  CollectedOutput,
  DshEnvironment,
  DshEnvironmentKey,
  SubprocessCollect,
  SubprocessCollectedOutputs,
  SubprocessHandle,
  SubprocessOutcome,
  SubprocessOutputMode,
  SubprocessOutputRead,
  SubprocessOutputReader,
  SubprocessSpawnSpec,
  SubprocessStdinMode,
  SubprocessStdio,
  SubprocessTerminalForeground,
  SubprocessTerminalActivity,
  SubprocessTerminalEnvironment,
  SubprocessTerminalHandle,
  SubprocessTerminalSignal,
  SubprocessTerminalSpawnSpec,
} from './types.ts'

/**
 * Credential-shaped environment names are NOT forwarded to children (the
 * harness's own `DEEPSEEK_API_KEY`/secrets must not leak into a spawned
 * process implicitly). One heuristic for every in-repo spawner; a
 * deliberately supplied entry survives because explicit env layers merge
 * after the scrub.
 */
export const SENSITIVE_ENV_PATTERN = /KEY|PASSWORD|SECRET|TOKEN/i

/**
 * Ambient names that are never forwarded implicitly, whatever their value
 * looks like: the ones that hand a child ambient authority (an agent socket
 * that signs as the user, a container endpoint, a cluster configuration, a
 * Kerberos ticket cache, a cloud or tool credential file), the ones whose
 * value is an endpoint that carries its own secret (a chat workspace or any
 * webhook), passphrases and passwords under names the name heuristic misses,
 * and an alternate passwd database. Each entry is matched case-insensitively
 * against the whole name, `*` matching any run of characters. A name outside
 * this list is still dropped when its value has a credential shape; see
 * `CREDENTIAL_VALUE_SHAPES` below. A deliberately supplied entry survives
 * either way, because explicit env layers merge after the scrub.
 */
const DENIED_ENV_NAMES: readonly string[] = [
  'SSH_AUTH_SOCK',
  'DOCKER_HOST',
  'KUBECONFIG',
  'KRB5CCNAME',
  '*_CREDENTIALS',
  'AWS_*',
  'AZURE_*',
  'SLACK_*',
  'DISCORD_*',
  '*_WEBHOOK*',
  '*PASSPHRASE*',
  'MYSQL_PWD',
  '*_PASSWD',
]

/**
 * Compile one denylist glob into an anchored, case-insensitive matcher.
 * @param pattern - a name, or a glob whose `*` matches any run of characters.
 * @returns a matcher for whole environment names.
 */
function globMatcher(pattern: string): RegExp {
  const source = pattern.split('*').map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')
  return new RegExp(`^${source}$`, 'i')
}

const DENIED_ENV_MATCHERS = DENIED_ENV_NAMES.map(globMatcher)

/**
 * The file names a value ends with when the value names a file that holds
 * credentials, joined for the value-shape matcher below.
 */
const CREDENTIAL_FILE_NAMES = [
  String.raw`\.aws[/\\]credentials`,
  String.raw`\.netrc`,
  String.raw`\.npmrc`,
  String.raw`\.pgpass`,
  String.raw`\.git-credentials`,
  String.raw`\.docker[/\\]config\.json`,
  String.raw`application_default_credentials\.json`,
  String.raw`id_(?:rsa|dsa|ecdsa|ed25519)`,
  String.raw`[^\s"'/\\]*service[_-]?account[^\s"'/\\]*\.json`,
].join('|')

/**
 * Value shapes that identify a credential carrier without any help from its
 * name, because a name-only rule cannot see
 * `CI_JOB_ENDPOINT=https://robot:<secret>@ci.invalid/`. An ambient entry whose
 * whole value has one of these shapes is dropped whatever it is called.
 *
 * Any user information after `scheme://` counts, including a user name with no
 * password and a password with an empty user name (`redis://:<secret>@host`):
 * `https://<token>@host` and a Sentry DSN carry the secret as the
 * user name, and a token cannot be told apart from a plain login such as the
 * `git` of `ssh://git@host/repo`, so both are dropped. A scp-style
 * `git@host:org/repo` has no scheme and is not a URL with user information.
 */
const CREDENTIAL_VALUE_SHAPES: readonly RegExp[] = [
  // `scheme://user@host`, `scheme://user:secret@host` or `scheme://:secret@host`: the user information is the credential.
  /[a-z][a-z0-9+.-]*:\/\/[^\s/?#@:]*(?::[^\s/?#@]*)?@/i,
  // A webhook endpoint — a `hooks.` host or a `/webhook(s)` path — whose path is the secret.
  /[a-z][a-z0-9+.-]*:\/\/(?:hooks\.[^\s"'<>]+|[^\s"'<>]*[/.]webhooks?[/.][^\s"'<>]*)/i,
  // A PEM private key block, however the value was spelled.
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/,
]

/**
 * Shapes of one path that names a credential carrier. They are matched against
 * the whole value of an ordinary entry, which is then dropped, and against each
 * element of a search-path list (see `SEARCH_PATH_LIST_NAME`), which loses only
 * the matching elements.
 */
const CREDENTIAL_PATH_SHAPES: readonly RegExp[] = [
  // The path of a file that holds credentials.
  new RegExp(String.raw`(?:^|[\s"'=(])[^\s"'=]*?(?:${CREDENTIAL_FILE_NAMES})`, 'i'),
  // An agent socket: the SSH agent's per-session socket, the GnuPG agent's, a keyring's, or a docker socket.
  // The runs exclude `:` and `;`, so the shape never spans two elements of a list such as `PATH`.
  /(?:^|[\s"'=:;])[^\s"':;]*(?:[/\\]agent\.\d+|S\.gpg-agent[^\s"':;]*|[/\\]keyring[/\\][^\s"':;]*|(?:ssh|gpg)[^\s"':;]*\.sock)/i,
]

/**
 * Names whose value is a list of search paths joined by the platform path
 * delimiter (`PATH`, `Path`, `LD_LIBRARY_PATH`, `PYTHONPATH`, ...). One
 * credential-shaped element removes that element only, so the child keeps the
 * rest of its search path.
 */
const SEARCH_PATH_LIST_NAME = globMatcher('*PATH')

/**
 * Whether one path, or one element of a search-path list, names a credential carrier.
 * @param value - the path text.
 * @returns `true` when the text matches a credential path shape.
 */
function isCredentialPath(value: string): boolean {
  return CREDENTIAL_PATH_SHAPES.some(shape => shape.test(value))
}

/**
 * The value one ambient entry may pass to a child implicitly.
 * @param name - the environment name.
 * @param value - the value the parent process holds for it.
 * @returns `undefined` for a credential-shaped or `DSH_*` name, a denylisted name, a value with a credential shape, or a
 * search-path list with no element left; otherwise the value, minus credential-path elements for a search-path list.
 */
function forwardableEnvValue(name: string, value: string): string | undefined {
  if (
    SENSITIVE_ENV_PATTERN.test(name)
    || name.toUpperCase().startsWith(DSH_ENV_PREFIX)
    || DENIED_ENV_MATCHERS.some(matcher => matcher.test(name))
    || CREDENTIAL_VALUE_SHAPES.some(shape => shape.test(value))
  ) return undefined
  if (!SEARCH_PATH_LIST_NAME.test(name)) return isCredentialPath(value) ? undefined : value
  const elements = value.split(delimiter).filter(element => !isCredentialPath(element))
  return elements.length === 0 ? undefined : elements.join(delimiter)
}

/**
 * The ambient parent environment minus credential-shaped names, minus the
 * denylisted ambient authorities and credential carriers, minus any entry
 * whose value has a credential shape, and minus all `DSH_*` names — the
 * canonical base every harness child starts from. `PATH`, `HOME`, locale, and
 * proxy variables survive, so child CLIs run normally; harness identity never
 * leaks implicitly (a deliberately forwarded credential or current `DSH_*`
 * fact goes through the spec's explicit `env`, which merges after this scrub).
 * Every scrub matches case-insensitively:
 * Windows environment names are case-insensitive, so a parent `dsh_*` entry
 * would otherwise survive and read back as `$env:DSH_*` in the child;
 * deliberate lowercase `dsh_*` names on POSIX are implausible. Exported as a plain function so spawners
 * that cannot route through the service (node-pty backends, SDK-managed
 * transports) share the one scrub definition.
 *
 * When a proxy is active the result also carries the resolved proxy names and the flag a child Node
 * needs to honor them, so a child inherits the same routing as its parent.
 * @returns a fresh environment object safe to hand to a child spawn.
 */
export function scrubbedParentEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    const forwarded = value === undefined ? undefined : forwardableEnvValue(key, value)
    if (forwarded !== undefined) env[key] = forwarded
  }
  // A child Node ignores the inherited proxy variables unless the flag this adds is set, so an MCP
  // stdio server or subagent CLI would connect directly while its parent proxies. The same overlay
  // restores each proxy name to what the user exported, undoing this process's own normalization —
  // `undefined` removes a name the user never set.
  for (const [name, value] of Object.entries(proxyEnvironmentForChild())) {
    if (value === undefined) Reflect.deleteProperty(env, name)
    else env[name] = value
  }
  return env
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    subprocess: SubprocessRuntime
  }
}

/**
 * Abstract subprocess service. Subclass, implement {@link spawn}, and load the
 * subclass as a plugin — it registers as `ctx.subprocess` (one implementation
 * per context; loading a second throws, which is cordis' standard
 * duplicate-service behavior).
 *
 * Implementations must honor these semantics:
 * - Executable paths belong to one execution world shared with the mounted
 *   filesystem provider.
 * - {@link spawn} returns a live handle synchronously. The handle names the
 *   managed range's leader (`pid`) and systemd scope (`unit`) only when the
 *   provider has them, for a caller that records a process's identity; signals
 *   and teardown stay with the provider. `done` resolves with the spawned
 *   command's exit facts and may reject for spawn or provider failures.
 * - Collect-mode readers are offset-based and non-consuming, so independent
 *   readers never consume one another's output; lossy reads report truncation
 *   and the spill file holding the complete stream when one exists. Piped
 *   streams are handed to the caller raw and never buffered here.
 * - {@link SubprocessHandle.terminate} (and the spec's abort signal) starts the
 *   provider's documented procedure against its managed range.
 *   {@link SubprocessHandle.waitForExit} observes that same range so a
 *   consumer-owned teardown ladder can hold each tier on real quiescence; each
 *   provider documents its signalling and observability limits.
 * - Disposal of the service terminates all still-running managed processes
 *   and awaits their exit.
 * - {@link spawnTerminal} owns terminal allocation, text transport,
 *   foreground groups, signalling, and whole-session quiescence behind one
 *   awaited termination method; readiness and persistent-shell policy stay
 *   in the PTY consumer. Its output stream ends after queued terminal output
 *   when the top-level process exits.
 */
export abstract class SubprocessRuntime extends Service {
  constructor(ctx: Context) {
    super(ctx, 'subprocess')
  }

  /**
   * Resolve one configured executable in this provider's execution world.
   * Absolute paths are verified; bare names use the provider's scrubbed PATH
   * plus explicit environment overrides. Relative paths containing separators
   * are rejected: the resolution base is undefined, so providers fail loud
   * instead of guessing.
   * @param command - absolute executable path or bare PATH name.
   * @param env - explicit environment entries used for lookup.
   * @param signal - aborts remote or local lookup.
   * @returns a canonical executable path.
   */
  abstract resolveExecutable(
    command: string,
    env?: Readonly<Record<string, string>>,
    signal?: AbortSignal,
  ): Promise<string>

  /**
   * Inspect shell-selection facts in the provider's execution environment.
   * @param signal - cancellation of remote environment inspection.
   * @returns platform and preferred shell; executable lookup and allocation remain separate operations.
   */
  abstract terminalEnvironment(signal?: AbortSignal): Promise<SubprocessTerminalEnvironment>

  /**
   * Start one managed child process from a fully-specified spec; this seam
   * applies no defaults.
   * @param spec - argv, directory, stdio dispositions, grace, cancellation, and environment.
   * @returns the live process handle (streams/readers, signalling, outcome promise).
   * @throws synchronously when pre-aborted or when argv, cwd, environment, or grace is invalid before handle creation.
   */
  abstract spawn(spec: SubprocessSpawnSpec): SubprocessHandle

  /**
   * Allocate a real terminal and start one owned process session. This is the
   * only non-pipe process primitive: implementations own terminal byte I/O,
   * foreground groups, signals, and whole-session quiescence.
   * @param spec - fully specified argv, cwd, environment, dimensions, grace, and allocation cancellation.
   * @returns the live terminal handle after allocation succeeds.
   */
  abstract spawnTerminal(spec: SubprocessTerminalSpawnSpec): Promise<SubprocessTerminalHandle>
}

export default SubprocessRuntime
