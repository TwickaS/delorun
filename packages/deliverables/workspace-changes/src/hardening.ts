/**
 * The configuration and environment every Host git command of this package runs with, so that repository state a
 * confined model command can write (the repository's `.git/config` and the files it includes, `.gitattributes`,
 * `.git/info/attributes`, hooks, or a `.git` file naming another git directory) cannot make git start a program.
 *
 * Overrides travel as `GIT_CONFIG_COUNT`/`GIT_CONFIG_KEY_<n>`/`GIT_CONFIG_VALUE_<n>`, git's command scope, which
 * outranks every configuration file and accepts any subsection name, including one that holds `=`. git older than
 * 2.31 ignores those variables, so {@link gitVersionProblem} refuses it. The person's global and system configuration
 * stay in effect: no writable root of a confined command contains them, and they carry the person's ignore rules.
 * @module @deepseek-ai/dsh-workspace-changes/hardening
 */

/** The oldest git whose command-scope configuration variables carry the overrides. */
const MINIMUM_GIT: readonly [number, number] = [2, 31]

/**
 * Overrides every command gets: no file-system monitor, hooks, pager, editor, external diff, credential helper,
 * askpass program, SSH command, proxy command, alternate-refs command, pack-objects hook, transport (which also stops
 * a partial clone's lazy fetch), implicitly found bare repository, or submodule recursion.
 */
export const FIXED_GIT_OVERRIDES: readonly (readonly [string, string])[] = [
  ['core.fsmonitor', 'false'],
  ['core.useBuiltinFSMonitor', 'false'],
  ['core.hooksPath', '/dev/null'],
  ['core.pager', 'cat'],
  ['core.editor', 'false'],
  ['sequence.editor', 'false'],
  ['diff.external', ''],
  ['credential.helper', ''],
  ['core.askPass', ''],
  ['core.sshCommand', 'false'],
  ['core.gitProxy', ''],
  ['core.alternateRefsCommand', ''],
  ['uploadpack.packObjectsHook', ''],
  ['protocol.allow', 'never'],
  ['safe.bareRepository', 'explicit'],
  ['submodule.recurse', 'false'],
]

/**
 * The arguments of the command whose output {@link driverOverrides} reads: the names of every filter and diff driver
 * key in every configuration scope, NUL-terminated. git exits 1 when there is none.
 */
export const DRIVER_LISTING_ARGS: readonly string[] = ['config', '--null', '--name-only', '--get-regexp', '^(filter|diff)\\.']

/** A configuration key that names a filter or diff driver: `filter.<name>.<key>` or `diff.<name>.<key>`. */
const DRIVER_KEY = /^(filter|diff)\.([^\n]+)\.([^.\n]+)$/

/**
 * Overrides that switch off every filter and diff driver a configuration listing names, so a `.gitattributes`
 * entry selects nothing that runs: each filter loses its `clean`, `smudge` and `process` commands and is no longer
 * `required`; each diff driver loses its `textconv` and `command`. git's built-in end-of-line, `ident` and encoding
 * conversions still apply.
 * @param listing - the standard output of git run with {@link DRIVER_LISTING_ARGS}.
 * @returns the overrides, in listing order without repeats.
 */
export function driverOverrides(listing: string): Array<[string, string]> {
  const overrides = new Map<string, string>()
  for (const key of listing.split('\0')) {
    const match = DRIVER_KEY.exec(key)
    if (match === null) continue
    const driver = `${match[1] as string}.${match[2] as string}`
    if (match[1] === 'filter') {
      for (const command of ['clean', 'smudge', 'process']) overrides.set(`${driver}.${command}`, '')
      overrides.set(`${driver}.required`, 'false')
    } else {
      for (const command of ['textconv', 'command']) overrides.set(`${driver}.${command}`, '')
    }
  }
  return [...overrides]
}

/**
 * The environment entries of one hardened git command, merged onto the subprocess provider's base: every
 * inherited `GIT_*` name removed, the overrides as command-scope configuration, no prompt, no optional index write,
 * no lazy fetch, the C locale, then the command's own entries.
 * @param parent - the environment the subprocess provider starts from.
 * @param overrides - {@link FIXED_GIT_OVERRIDES} followed by any {@link driverOverrides}.
 * @param own - the command's own entries, such as `GIT_INDEX_FILE`; they win over everything above.
 * @returns entries where `undefined` removes a name.
 */
export function hardenedGitEnvironment(
  parent: Readonly<Record<string, string | undefined>>,
  overrides: readonly (readonly [string, string])[],
  own: Readonly<Record<string, string>> = {},
): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {}
  for (const name of Object.keys(parent)) {
    if (/^(GIT_|SSH_ASKPASS$)/i.test(name)) env[name] = undefined
  }
  overrides.forEach(([key, value], index) => {
    env[`GIT_CONFIG_KEY_${index}`] = key
    env[`GIT_CONFIG_VALUE_${index}`] = value
  })
  return {
    ...env,
    GIT_CONFIG_COUNT: String(overrides.length),
    GIT_TERMINAL_PROMPT: '0',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_NO_LAZY_FETCH: '1',
    LC_ALL: 'C',
    ...own,
  }
}

/**
 * Why a git cannot run hardened commands: it is older than 2.31, so it would ignore the overrides, or its version
 * cannot be read.
 * @param versionOutput - the standard output of `git version`.
 * @returns the reason, or undefined when the version is supported.
 */
export function gitVersionProblem(versionOutput: string): string | undefined {
  const match = /^git version (\d+)\.(\d+)/.exec(versionOutput.trim())
  if (match === null) return `cannot read the git version from ${JSON.stringify(versionOutput.trim().slice(0, 80))}`
  const [major, minor] = [Number(match[1]), Number(match[2])]
  const [needMajor, needMinor] = MINIMUM_GIT
  if (major > needMajor || (major === needMajor && minor >= needMinor)) return undefined
  return `git ${major}.${minor} is older than ${needMajor}.${needMinor}, which reads command-scope configuration from the environment`
}
