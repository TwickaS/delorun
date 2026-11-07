/**
 * git's options, environment and credential helper for the workspaces'
 * clones. Every git command runs with no hooks, no file monitor and only
 * `https`, without the environment names that point git at other
 * configuration, traces or askpass programs. A token reaches git only through
 * a credential helper that answers for the clone URL's host and path, so the
 * token is in neither the argument list nor the URL the clone stores.
 *
 * While git runs, the token is in git's environment and in the environment of
 * the processes git starts, so any of those processes can read it.
 * @module @delo/plugin-workspaces/git
 */

/** Names a clone drops from git's environment: repository and index pointers, configuration, certificate overrides and traces. */
const CLEARED = [
  'GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_CONFIG', 'GIT_CONFIG_PARAMETERS', 'GIT_CONFIG_COUNT', 'GIT_CEILING_DIRECTORIES', 'GIT_NAMESPACE',
  'GIT_ASKPASS', 'SSH_ASKPASS', 'GIT_SSL_NO_VERIFY', 'GIT_SSL_CAINFO', 'GIT_SSL_CAPATH', 'GIT_PROXY_SSL_CAINFO',
  'GIT_TRACE', 'GIT_TRACE_CURL', 'GIT_TRACE_CURL_NO_DATA', 'GIT_TRACE_PACKET',
  'GIT_TRACE2', 'GIT_TRACE2_EVENT', 'GIT_TRACE2_PERF', 'GIT_CURL_VERBOSE',
] as const

/** Name prefixes whose every member a clone drops, whatever its suffix. */
const CLEARED_PREFIXES = ['GIT_CONFIG', 'GIT_TRACE', 'GIT_ASKPASS'] as const

/** {@link CLEARED} as a set, for comparison with names in upper case. */
const CLEARED_NAMES: ReadonlySet<string> = new Set<string>(CLEARED)

/**
 * git's credential helper, a shell snippet that git runs with the action as
 * its last argument. For `get` it prints the token, with the user name
 * `x-access-token`, only for an `https` request whose host and path equal
 * `DELO_GIT_HOST` and `DELO_GIT_PATH`; for `store` and `erase` it prints
 * nothing.
 */
const HELPER = [
  '!f() {',
  'test "$1" = get || exit 0;',
  'p= h= r=;',
  'while IFS= read -r line && test -n "$line"; do',
  'case "$line" in protocol=*) p=${line#protocol=} ;; host=*) h=${line#host=} ;; path=*) r=${line#path=} ;; esac;',
  'done;',
  'if test "$p" = https && test "$h" = "$DELO_GIT_HOST" && test "$r" = "$DELO_GIT_PATH"; then printf \'username=x-access-token\\npassword=%s\\n\' "$DELO_GIT_TOKEN"; fi;',
  '}; f',
].join(' ')

/** A token: one non-empty line of at most 4096 printable ASCII characters, with no whitespace. */
const TOKEN = /^[!-~]{1,4096}$/

/**
 * Text a URL parser and git may read differently: whitespace and control
 * characters, non-ASCII characters, backslashes, and the `?` and `#` that
 * start a query or a fragment.
 */
const UNSAFE_URL_TEXT = /[^\x21-\x7e]|[\\?#]/

// git's scp-like remote, `[user@]host:path`, which has no `/` before the colon.
const SCP_REMOTE = /^(?:[^@/:]+@)?([A-Za-z0-9.-]+):(?!\/\/)\/?(.+)$/

/** The options and environment of one git command. */
export interface GitInvocation {
  /** git's options, which come before the subcommand. */
  readonly options: readonly string[]
  /** Entries for the command's environment; an undefined entry removes the name. */
  readonly env: Readonly<Record<string, string | undefined>>
}

/** The options every git command of a workspace takes: no hooks, no file monitor, and only `https`. */
export const GIT_OPTIONS: readonly string[] = [
  '-c', 'core.hooksPath=/dev/null',
  '-c', 'core.fsmonitor=false',
  '-c', 'protocol.allow=never',
  '-c', 'protocol.https.allow=always',
]

/**
 * The environment every git command of a workspace takes: each {@link CLEARED}
 * name set to undefined, which removes it from the child, and no prompt.
 */
export const GIT_ENV: Readonly<Record<string, string | undefined>> = {
  ...Object.fromEntries(CLEARED.map((name): [string, undefined] => [name, undefined])),
  GIT_TERMINAL_PROMPT: '0',
  GCM_INTERACTIVE: 'never',
}

/**
 * Why git may not clone a URL with a token or with the person's own
 * configuration: the URL must be `https` with a host, and it must have no user
 * name, password, query or fragment. Its text must be printable ASCII without
 * spaces, backslashes, `?` or `#`, so the host and path the URL parser reads
 * are the ones git reads.
 * @param cloneUrl - the repository's URL.
 * @returns the reason, which names no part of the URL, or undefined when git may clone it.
 */
export function cloneUrlProblem(cloneUrl: string): string | undefined {
  const url = URL.parse(cloneUrl)
  const accepted = url !== null && url.protocol === 'https:' && url.hostname !== '' && url.username === '' && url.password === ''
    && !UNSAFE_URL_TEXT.test(cloneUrl)
  return accepted ? undefined : 'the repository URL must be an https URL without a user name, password, query or fragment'
}

/**
 * Why a token may not go to git: a token is one non-empty line of at most 4096
 * printable ASCII characters with no whitespace.
 * @param token - the token.
 * @returns the reason, which names no part of the token, or undefined when the token is accepted.
 */
export function tokenProblem(token: string): string | undefined {
  return TOKEN.test(token) ? undefined : 'the token must be one line of at most 4096 printable ASCII characters without whitespace'
}

/**
 * The options and environment that give one git command the token for one
 * clone URL: {@link GIT_OPTIONS}, the credential helpers the person configured
 * replaced by {@link HELPER} (an empty `credential.helper` resets the list),
 * `http.sslVerify=true`, and the token with the URL's host and path in the
 * environment for the helper. The token is in neither the options nor the URL.
 * @param cloneUrl - the `https` clone URL the token applies to; the helper answers only for its host and path.
 * @param token - the token, accepted by {@link tokenProblem}.
 * @returns the options and the environment entries.
 * @throws TypeError when {@link cloneUrlProblem} or {@link tokenProblem} refuses its argument; the message names no part of either.
 */
export function tokenGit(cloneUrl: string, token: string): GitInvocation {
  const problem = cloneUrlProblem(cloneUrl) ?? tokenProblem(token)
  if (problem !== undefined) throw new TypeError(problem)
  const url = new URL(cloneUrl)
  return {
    options: [
      ...GIT_OPTIONS,
      '-c', 'http.sslVerify=true',
      '-c', 'credential.helper=',
      '-c', `credential.helper=${HELPER}`,
      '-c', 'credential.useHttpPath=true',
    ],
    env: { ...GIT_ENV, DELO_GIT_TOKEN: token, DELO_GIT_HOST: url.host, DELO_GIT_PATH: url.pathname.slice(1) },
  }
}

/**
 * The environment one clone spawns with, merged onto the subprocess provider's
 * scrubbed base: {@link GIT_ENV}, plus an undefined entry for every name of
 * `parentEnv` that starts with `GIT_CONFIG`, `GIT_TRACE` or `GIT_ASKPASS` or
 * is one of {@link CLEARED}. Names are compared in upper case, because Windows
 * environment names are case-insensitive.
 * @param parentEnv - the environment the harness runs with.
 * @returns the entries; an undefined entry removes its name from the child.
 */
export function cloneEnvironment(parentEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...GIT_ENV }
  for (const name of Object.keys(parentEnv)) {
    if (isCleared(name)) env[name] = undefined
  }
  return env
}

/**
 * Whether a clone drops an environment name.
 * @param name - the name as the parent environment holds it.
 * @returns true for a {@link CLEARED} name or a name under a {@link CLEARED_PREFIXES} prefix.
 */
function isCleared(name: string): boolean {
  const upper = name.toUpperCase()
  return CLEARED_NAMES.has(upper) || CLEARED_PREFIXES.some((prefix) => upper.startsWith(prefix))
}

/**
 * Replace every occurrence of each secret in a text with `[redacted]`.
 * Empty secrets are ignored.
 * @param text - the text to redact.
 * @param secrets - the values to remove.
 * @returns the redacted text.
 */
export function redactClone(text: string, secrets: readonly string[]): string {
  return secrets.reduce((redacted, secret) => (secret === '' ? redacted : redacted.split(secret).join('[redacted]')), text)
}

/**
 * The `https` URL of a workspace's remote: an `https` remote as it is, and an
 * `ssh://` or scp-like remote, such as `git@github.com:owner/name.git`, on the
 * same host and path without its user and port.
 * @param remote - the remote's URL as git's configuration holds it.
 * @returns the URL, or undefined for a remote of another kind, such as a path.
 */
export function httpsRemote(remote: string): string | undefined {
  const scp = remote.includes('://') ? null : SCP_REMOTE.exec(remote)
  if (scp !== null) return `https://${scp[1] ?? ''}/${scp[2] ?? ''}`
  const url = URL.parse(remote)
  if (url === null) return undefined
  if (url.protocol === 'https:') return remote
  if (url.protocol === 'ssh:' && url.hostname !== '') return `https://${url.hostname}${url.pathname}`
  return undefined
}
