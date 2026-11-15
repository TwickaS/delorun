/**
 * `${credential:REF}` syntax and substitution for MCP transport strings.
 * Managers validate syntax at configuration writes; the client resolves values
 * at runtime without changing the stored configuration.
 *
 * @module
 */

import { McpLocalError } from './diagnostic.ts'

/** A referenced credential has no configured value. */
export class MissingTemplateValue extends McpLocalError {}

/** A credential value a start cannot use; the server waits like one with a missing credential. */
export class RefusedTemplateValue extends MissingTemplateValue {}

const TOKEN = /\$\{credential:([A-Za-z_][A-Za-z0-9_]*)\}/g

/** One whole occurrence must BE a token; containment is not enough. */
const TOKEN_EXACT = /^\$\{credential:[A-Za-z_][A-Za-z0-9_]*\}$/

/**
 * The exact names of environment variables that change which program, library or startup script a start runs. The
 * list follows app-boot's bootstrap-only names (`BOOTSTRAP_NAMES`) for process launch, module and library loading,
 * interpreter startup hooks and program selectors. It is the one list: the consent card in `plugin-mcp-consent` shows
 * a value for these names and {@link assertLiteralStart} refuses a credential template in them.
 */
const RUN_AFFECTING_ENV_NAMES: ReadonlySet<string> = new Set([
  'PATH', 'PATHEXT', 'SHELL', 'COMSPEC', 'LOCPATH', 'GCONV_PATH',
  'BASH_ENV', 'ENV', 'SHELLOPTS', 'BASHOPTS',
  'JAVA_TOOL_OPTIONS', '_JAVA_OPTIONS', 'JDK_JAVA_OPTIONS',
  'GIT_SSH', 'GIT_SSH_COMMAND', 'GIT_EXTERNAL_DIFF', 'GIT_PAGER', 'GIT_EDITOR', 'GIT_ASKPASS', 'SSH_ASKPASS',
  'EDITOR', 'VISUAL', 'PAGER', 'BROWSER',
])

/** Name prefixes of run-affecting environment variables: dynamic linker, Node, interpreter and OpenSSL families. */
const RUN_AFFECTING_ENV_PREFIXES: readonly string[] = ['LD_', 'DYLD_', 'NODE_', 'PYTHON', 'PERL5', 'RUBY', 'OPENSSL_', 'BASH_FUNC_']

/**
 * Whether an environment variable changes which program, library or startup script a start runs: the names of
 * `RUN_AFFECTING_ENV_NAMES` and every name starting with `LD_`, `DYLD_`, `NODE_`, `PYTHON`, `PERL5`, `RUBY`,
 * `OPENSSL_` or `BASH_FUNC_`. The comparison ignores letter case, because Windows reads names that way.
 * @param name - the variable's name.
 * @returns true for a run-affecting variable.
 */
export function isRunAffectingEnv(name: string): boolean {
  const upper = name.toUpperCase()
  return RUN_AFFECTING_ENV_NAMES.has(upper) || RUN_AFFECTING_ENV_PREFIXES.some(prefix => upper.startsWith(prefix))
}

/**
 * Whether a configured string is exactly one template token.
 * @param value - the configured string.
 * @returns true when the whole string is `${credential:REF}`.
 */
export function isWholeTemplate(value: string): boolean {
  return TOKEN_EXACT.test(value)
}

/** Any `${…}` occurrence, well-formed or not, for fail-loud validation. */
const SUSPECT = /\$\{[^}]*\}/g

/**
 * The credential references one configured string names, read statically. A
 * rotation observer uses this over the raw configuration so a server whose
 * earlier resolution failed — a credential configured only now — is still
 * recognized as affected.
 * @param value - the configured string.
 * @returns the referenced credential names, in template order.
 */
export function credentialRefsIn(value: string): string[] {
  return [...value.matchAll(TOKEN)].map(token => token[1] as string)
}

/**
 * Reject a string whose `${…}` occurrences are not all well-formed template
 * tokens, naming the offending occurrence and where it sits.
 * @param value - the configured string.
 * @param where - configuration path used in the thrown message.
 */
export function assertTemplateSyntax(value: string, where: string): void {
  for (const occurrence of value.matchAll(SUSPECT)) {
    // Anchored equality, not containment: `${x${credential:A}` contains a
    // valid token but the resolver would leave its `${x` prefix behind as a
    // literal, so only an occurrence that IS a token may pass.
    if (!TOKEN_EXACT.test(occurrence[0])) {
      throw new Error(`${where}: "${occurrence[0]}" is not a template token — use \${credential:REF}`)
    }
  }
}

/**
 * Resolve every template token in one string.
 * @param value - the configured string.
 * @param where - configuration path used in thrown messages.
 * @param credential - credential-reference lookup returning `undefined` while unconfigured.
 * @returns the substituted string.
 * @throws when a referenced credential is unconfigured.
 */
export async function resolveTemplateString(
  value: string,
  where: string,
  credential: (ref: string) => Promise<string | undefined>,
): Promise<string> {
  let out = ''
  let cursor = 0
  for (const token of value.matchAll(TOKEN)) {
    const name = token[1] as string
    const resolved = await credential(name)
    if (resolved === undefined) {
      throw new MissingTemplateValue(`${where}: credential "${name}" is not configured — store it through the credential seam or remove the \${credential:${name}} template`)
    }
    out += value.slice(cursor, token.index) + resolved
    cursor = token.index + token[0].length
  }
  return out + value.slice(cursor)
}

/**
 * Refuse the templates a reviewed local start cannot hold: the executable and working directory the review pins, and
 * the value of an environment variable that changes what runs, must be literal, because a credential that changes
 * later would otherwise change what runs under an unchanged review.
 * @param config - the stdio fields to check.
 * @param config.serverName - the server named in the message.
 * @param config.command - the configured executable.
 * @param config.cwd - the configured working directory.
 * @param config.env - the configured environment.
 * @throws when `command`, `cwd` or a run-affecting variable holds a template.
 */
export function assertLiteralStart(
  config: { serverName: string; command: string; cwd: string; env: Readonly<Record<string, string>> },
): void {
  const label = `mcp-client(${config.serverName})`
  for (const [field, value] of [['command', config.command], ['cwd', config.cwd]] as const) {
    if (credentialRefsIn(value).length > 0) {
      throw new McpLocalError(`${label}: ${field} holds a credential template — write the ${field} directly; only arguments and other environment values are filled from stored credentials`)
    }
  }
  for (const [name, value] of Object.entries(config.env)) {
    if (isRunAffectingEnv(name) && credentialRefsIn(value).length > 0) {
      throw new McpLocalError(`${label}: env.${name} holds a credential template, but ${name} changes what runs — put the value directly or use another variable name`)
    }
  }
}

/**
 * Refuse a resolved argument that would be read as an option.
 * @param raw - the configured argument.
 * @param resolved - the argument after substitution.
 * @param label - the server label for the message.
 * @param index - the argument's position.
 * @throws when the whole argument is a template and its value starts with `-`; the message never holds the value.
 */
export function assertNoInjectedOption(raw: string, resolved: string, label: string, index: number): void {
  if (isWholeTemplate(raw) && resolved.startsWith('-')) {
    throw new RefusedTemplateValue(
      `${label}: args[${index}] is a credential template whose value starts with "-", which a program would read as an option — `
      + 'write the option directly and keep the template inside a longer argument such as --token=${credential:REF}',
    )
  }
}
