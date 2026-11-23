/**
 * The `mcpAddConsent` Service Definition: the optional add-time consent seam
 * an mcp-client instance consults before it starts a configured MCP server.
 * The service is optional — without a mounted provider, or with no loader row
 * that declares one, the mcp-client plugin starts a server exactly as upstream
 * does — and a stdio server row waits for the mounted service's decision
 * before its command runs. A stdio server command runs as a local child
 * process outside the agent sandbox, so the consent names everything that
 * decides what that process runs: the command, its arguments, its working
 * directory and the configured environment variables, together with the
 * absolute executable path and canonical working directory the configured
 * command and directory resolve to when the review runs, and on Windows the
 * command shell that runs a batch file. The server is
 * spawned with those resolved paths, or with the executable path an allowing
 * decision names, so it runs what was reviewed.
 *
 * A provider implements {@link McpAddConsent} and is loaded as a plugin whose
 * module exports {@link MCP_ADD_CONSENT_PROVIDER_EXPORT} set to `true`. The
 * mcp-client finds the service with {@link findMcpAddConsent}, which does not
 * depend on the order of the loader's rows: when the service is not yet
 * registered, it waits until every row's module is imported and every row that
 * declares a provider has settled. The service sees the configured start at
 * every boot and before every reconnect, so a provider that remembers an accepted start lets the same
 * grant start without asking again, and a changed start reaches the provider
 * as a new review.
 *
 * @module @deepseek-ai/dsh-mcp-client/consent
 */

import { FiberState, Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import type { Entry } from '@deepseek-ai/cordis-plugin-loader'

/** The server start a consent review judges. */
export interface McpServerCommand {
  /** The server's configured `serverName` namespace. */
  readonly serverName: string
  /** Executable the server would be started with. */
  readonly command: string
  /** Arguments passed directly to the executable, without shell interpolation. */
  readonly args: readonly string[]
  /**
   * The configured environment entries merged over the scrubbed Host
   * environment. Values may be credentials: a provider compares them but never
   * writes them to a log, an error message or a file in plain text.
   */
  readonly env: Readonly<Record<string, string>>
  /** The configured working directory; the empty string runs the server in the Host's working directory. */
  readonly cwd: string
  /**
   * The absolute path of the executable the server is spawned with, unless the
   * allowing decision names another ({@link McpConsentDecision}): `command`
   * itself when it contains `/`, resolved against {@link resolvedCwd}, or the
   * first executable file named `command` in the `PATH` of the child's
   * environment. Symbolic links are kept; the review covers this path, not the
   * contents of the file it names.
   */
  readonly resolvedCommand: string
  /**
   * The canonical working directory the server is spawned in: `cwd` resolved
   * against the Host's working directory when the review ran, with every
   * symbolic link resolved.
   */
  readonly resolvedCwd: string
  /**
   * On Windows, when {@link resolvedCommand} is a `.cmd` or `.bat` file, the
   * canonical path of the Host's `COMSPEC`, the command shell that runs it.
   * Absent when the file runs directly and on Linux and macOS.
   */
  readonly resolvedShell?: string
}

/** The decision a consent review returns. */
export type McpConsentDecision =
  | {
    readonly allow: true
    /**
     * The absolute path the server is spawned with instead of the reviewed
     * `resolvedCommand`, such as the canonical file the provider checked, so
     * a symbolic link retargeted after the review cannot change the file that
     * runs. Absent, the server is spawned with `resolvedCommand`.
     */
    readonly spawnCommand?: string
    /**
     * The arguments the server is spawned with instead of the configured
     * ones: the same list, each argument that names a file the provider
     * pinned written with that file's canonical path, so a link retargeted
     * after the review cannot change the file the program opens. Absent, the
     * configured arguments are used.
     */
    readonly spawnArgs?: readonly string[]
    /**
     * Checks the files the review pinned again, and resolves to the reason one
     * no longer matches, or `undefined` when all do. The connection calls it
     * immediately before every spawn; a reason fails that attempt, and the
     * next attempt is reviewed again.
     */
    readonly verify?: () => Promise<string | undefined>
  }
  | { readonly allow: false; readonly reason: string }

/**
 * The name of the module export by which a plugin declares that its row may
 * register the `mcpAddConsent` service. A provider module exports it as
 * `true`; {@link findMcpAddConsent} waits for the rows that declare it before
 * it decides that no consent is mounted.
 */
export const MCP_ADD_CONSENT_PROVIDER_EXPORT = 'providesMcpAddConsent'

/**
 * A server start's configured environment entries in a fixed order, sorted by
 * name in UTF-16 code unit order, so equal environments compare and digest
 * equally whatever order their keys were written in.
 * @param env - the configured environment entries.
 * @returns the `[name, value]` pairs sorted by name.
 */
export function sortedEnvEntries(env: Readonly<Record<string, string>>): readonly (readonly [string, string])[] {
  return Object.entries(env).sort(([left], [right]) => Number(left > right) - Number(left < right))
}

/**
 * The words naming a working directory in a consent message.
 * @param cwd - the configured working directory.
 * @returns the quoted directory, or the Host's working directory for the empty string.
 */
function describeCwd(cwd: string): string {
  return cwd === '' ? 'the Host\'s working directory' : JSON.stringify(cwd)
}

/**
 * The words naming the configured environment variables in a consent message:
 * the names only, because the values may be credentials.
 * @param envNames - the configured variable names, sorted.
 * @returns the clause that names them.
 */
function describeEnv(envNames: readonly string[]): string {
  if (envNames.length === 0) return 'no configured environment variables'
  return `the configured environment variables ${envNames.join(', ')} (values not shown)`
}

/**
 * The words naming what runs a server start's file in a consent message.
 * @param start - the server start.
 * @returns the quoted executable, or the quoted batch file and the command shell that runs it.
 */
function describeExecutable(start: McpServerCommand): string {
  const file = JSON.stringify(start.resolvedCommand)
  return start.resolvedShell === undefined ? `the executable ${file}` : `the batch file ${file} through the command shell ${JSON.stringify(start.resolvedShell)}`
}

/**
 * Refusal of one server start by the mounted consent, thrown by the
 * mcp-client plugin's activation so the refused server stays stopped. The
 * message names the command and arguments being granted, the resolved
 * executable path and, for a Windows batch file, the command shell that runs
 * it, the resolved and configured working directory and the
 * names of the configured environment variables, carries
 * the provider's reason, and states that a server command runs outside the
 * agent sandbox. Environment values are never part of the error.
 */
export class McpConsentRefusedError extends Error {
  /** The refused server's configured namespace. */
  readonly serverName: string
  /** The refused executable. */
  readonly command: string
  /** The refused arguments. */
  readonly args: readonly string[]
  /** The refused working directory; the empty string is the Host's working directory. */
  readonly cwd: string
  /** The absolute path of the refused executable. */
  readonly resolvedCommand: string
  /** The canonical working directory the refused server would have run in. */
  readonly resolvedCwd: string
  /** The canonical path of the command shell that would have run a refused Windows batch file; absent otherwise. */
  readonly resolvedShell: string | undefined
  /** The names of the refused configured environment variables, sorted; their values are withheld. */
  readonly envNames: readonly string[]
  /** The consent provider's own reason. */
  readonly reason: string

  /**
   * @param start - the server start that was not granted.
   * @param reason - the consent provider's reason.
   */
  constructor(start: McpServerCommand, reason: string) {
    const granted = [start.command, ...start.args].map(part => JSON.stringify(part)).join(' ')
    const envNames = sortedEnvEntries(start.env).map(([name]) => name)
    super(
      `mcp-client(${start.serverName}): the add-time consent did not allow this server's command, so the server stays stopped — ${reason}. `
        + `The consent covers the command ${granted}, which runs ${describeExecutable(start)} `
        + `in ${JSON.stringify(start.resolvedCwd)} (configured as ${describeCwd(start.cwd)}) with ${describeEnv(envNames)}. `
        + 'A server command runs outside the agent sandbox.',
    )
    this.name = 'McpConsentRefusedError'
    this.serverName = start.serverName
    this.command = start.command
    this.args = [...start.args]
    this.cwd = start.cwd
    this.resolvedCommand = start.resolvedCommand
    this.resolvedCwd = start.resolvedCwd
    this.resolvedShell = start.resolvedShell
    this.envNames = envNames
    this.reason = reason
  }
}

/**
 * Refusal of one server start because a loader row declares an `mcpAddConsent`
 * provider whose fiber did not become active, so no review can run. The
 * server stays stopped: a declared consent that is not running never counts
 * as no consent.
 */
export class McpConsentUnavailableError extends Error {
  /** The server's configured namespace. */
  readonly serverName: string
  /** The ids of the declaring rows that did not become active. */
  readonly rows: readonly string[]

  /**
   * @param serverName - the server's configured namespace.
   * @param rows - the ids of the declaring rows that did not become active.
   */
  constructor(serverName: string, rows: readonly string[]) {
    super(
      `mcp-client(${serverName}): the row ${rows.join(', ')} declares the add-time consent but did not start, so the server stays stopped. `
        + 'Fix the consent row\'s failure and start again.',
    )
    this.name = 'McpConsentUnavailableError'
    this.serverName = serverName
    this.rows = [...rows]
  }
}

/**
 * Abstract add-time consent service. Subclass, implement {@link review}, and
 * load the subclass as a plugin — it registers as `ctx.mcpAddConsent` (one
 * implementation per context; loading a second throws, cordis' standard
 * duplicate-service behavior). The plugin module that mounts it exports
 * {@link MCP_ADD_CONSENT_PROVIDER_EXPORT} as `true`.
 */
export abstract class McpAddConsent extends Service {
  constructor(ctx: Context) {
    super(ctx, 'mcpAddConsent')
  }

  /**
   * Review one configured server start before the mcp-client plugin starts
   * that server. The review runs at every boot of the server row, before any
   * child process starts, and again before every reconnect spawns the server
   * after its connection dropped, where a refusal ends the reconnect loop and
   * leaves the server stopped until its row starts again. The provider can
   * therefore compare what the start names, such as the contents of its
   * executable, with what it accepted each time, and let an accepted start through
   * at once and ask again when the command, arguments, working directory,
   * environment, resolved executable path, resolved command shell or resolved
   * working directory it is shown differ from the ones it accepted before.
   *
   * The returned promise gates the server's start: the mcp-client plugin's
   * activation does not finish, and the server does not start, until it
   * settles, so an implementation that asks a person must settle it when the
   * person answers and when the provider's own plugin unloads.
   *
   * @param command - the server start under review.
   * @param client - the context of the mcp-client plugin that starts the
   *   server. Its fiber's ancestors are the plugins that mounted the server,
   *   so a provider can judge a start by where its definition lives; the
   *   server's configuration cannot change them.
   * @returns `allow: true` to start the server, or `allow: false` with the
   *   reason that leaves the server stopped.
   */
  abstract review(command: McpServerCommand, client: Context): Promise<McpConsentDecision>
}

/**
 * Whether a loader row is enabled now; a `disabled` expression that throws
 * counts as disabled, because such a row does not start.
 * @param entry - the loader row.
 * @returns true when the row starts.
 */
function enabled(entry: Entry): boolean {
  try {
    return !entry.disabled
  } catch (_error) {
    // The Loader reports the expression's failure for the row; a row it does not start provides nothing.
    return false
  }
}

/**
 * Whether a loader row's imported plugin declares an `mcpAddConsent` provider.
 * @param entry - the loader row, after its module import settled.
 * @param unwrap - the Loader's export normalization.
 * @returns true when the plugin exports {@link MCP_ADD_CONSENT_PROVIDER_EXPORT} as `true`.
 */
function declaresProvider(entry: Entry, unwrap: (exports: unknown) => unknown): boolean {
  if (entry.moduleNamespace === undefined) return false
  const plugin = unwrap(entry.moduleNamespace)
  return typeof plugin === 'object' && plugin !== null
    && Reflect.get(plugin, MCP_ADD_CONSENT_PROVIDER_EXPORT) === true
}

/**
 * Find the `mcpAddConsent` service for one server start, independent of the
 * order in which the loader starts its rows. A registered service is returned
 * at once. Otherwise, when the context was mounted by a Loader, the lookup
 * waits until every row the Loader holds has imported its module and created
 * its fiber — work that never waits on a plugin's activation — and then until
 * every enabled row whose plugin declares a provider has settled. The waits
 * cover the rows present when the lookup starts and the rows created while it
 * waits.
 *
 * Imports that fail leave a row that declares nothing, which the Loader
 * reports as a failed row.
 * @param ctx - the mcp-client plugin's context.
 * @param serverName - the server's configured namespace, named in a refusal.
 * @returns the service, or `undefined` when no row declares a provider or every
 *   declaring row is active without registering one, as a provider whose own
 *   switch is off does.
 * @throws {McpConsentUnavailableError} when a declaring row did not become active.
 */
export async function findMcpAddConsent(ctx: Context, serverName: string): Promise<McpAddConsent | undefined> {
  const present = ctx.get('mcpAddConsent')
  if (present !== undefined) return present
  const loader = ctx.get('loader')
  if (loader === undefined) return undefined
  for (;;) {
    const imports = [...loader.entries()].flatMap(entry => entry._initTask === undefined ? [] : [entry._initTask])
    if (imports.length === 0) break
    await Promise.allSettled(imports)
  }
  const providers = [...loader.entries()]
    .filter(entry => enabled(entry) && declaresProvider(entry, exports => loader.unwrapExports(exports)))
  const fibers = providers.map(entry => entry.fiber).filter(fiber => fiber !== undefined)
  await Promise.allSettled(fibers.map(fiber => fiber.await()))
  const consent = ctx.get('mcpAddConsent')
  if (consent !== undefined) return consent
  const inactive = providers.filter(entry => entry.fiber?.state !== FiberState.ACTIVE)
  if (inactive.length > 0) throw new McpConsentUnavailableError(serverName, inactive.map(entry => entry.id))
  return undefined
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    mcpAddConsent: McpAddConsent
  }
}
