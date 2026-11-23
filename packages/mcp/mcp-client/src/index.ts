/**
 * MCP client bridge plugin: connects to an external MCP server and registers
 * its tools on `ctx.tools` under server-qualified public names
 * (`mcp__<serverName>__<rawName>`). Each plugin instance connects to one MCP
 * server; load multiple instances in `cordis.yml` for multiple servers.
 *
 * Namespace plugin (named exports, no default export). Lifecycle is
 * effect-scoped: disposal disconnects from the server, unregisters all tools,
 * and releases the `serverName` namespace reservation. HMR hot-swaps by
 * disposing the old instance and creating a new one; identical `serverName`
 * reproduces identical public tool names.
 *
 * @module @deepseek-ai/dsh-mcp-client
 */

import type { Context, Fiber } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { scopeOf } from '@deepseek-ai/dsh-scope'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import { DEFAULT_MAX_INSTRUCTION_BYTES, RECONNECT_DEFAULTS, resolveReconnectPolicy, startConnection } from './connection.ts'
import { findMcpAddConsent, McpConsentRefusedError, type McpAddConsent } from './consent.ts'
import { resolveServerStart } from './server-start.ts'
import { assertLiteralStart } from './templates.ts'

export { resolveReconnectPolicy } from './connection.ts'
import type { ConnectionOptions, ReconnectConfig } from './connection.ts'
import { registerServerContext } from './server-context.ts'
import { connectionStatusIn, registerStatusCell } from './status.ts'
import type { McpConnectionStatusHandle } from './status.ts'
// Side-effect type import: declaration-merges `ctx.tools` onto Context.
import type {} from '@deepseek-ai/dsh-tools'

export { createMcpToolDefinition } from './tools.ts'
export type { McpResult, McpToolDefinitionOptions } from './tools.ts'
export type { ReconnectConfig, ResolvedReconnectPolicy } from './connection.ts'
export { McpAddConsent, McpConsentRefusedError, McpConsentUnavailableError } from './consent.ts'
export type { McpConsentDecision, McpServerCommand } from './consent.ts'
export { McpServerStartUnresolvedError } from './server-start.ts'
export type { McpConnectionStatusHandle } from './status.ts'
export type * from './types.ts'
export { probeServer } from './probe.ts'
export { assertTemplateSyntax } from './templates.ts'
export type { McpProbeOptions } from './probe.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'mcp-client'

/** Services required by this plugin. */
export const inject = ['tools']

/** Default timeout for individual MCP tool calls and resource requests (ms). */
const DEFAULT_TOOL_CALL_TIMEOUT_MS = 60_000

/** Default budget for transport closure and local cleanup (ms). */
const DEFAULT_CLOSE_TIMEOUT_MS = 5_000

/** An absolute POSIX or Windows folder path, the only form a configured MCP root takes. */
const ABSOLUTE_ROOT_PATTERN = /^(?:\/|[A-Za-z]:[\\/]|\\\\)/u

/** Valid `serverName`, kept below the public tool-name budget. */
export const SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/

/**
 * Live `serverName` reservations per registration scope. Agent-scoped MCP
 * servers may reuse a namespace in another Agent, while global instances and
 * duplicates inside one Agent remain mutually exclusive.
 */
const activeServerNames = new WeakMap<object, Set<string>>()

/**
 * Read an MCP instance's stable status handle. Reloading the same Fiber keeps
 * the handle; final disposal detaches observers and leaves its last state readable.
 * @param fiber - the plugin Fiber or the handle returned by `ctx.plugin()`.
 * @returns the status handle, or `undefined` before the instance registers one.
 */
export function connectionStatusOf(fiber: Fiber): McpConnectionStatusHandle | undefined {
  return connectionStatusIn(fiber)
}

// ---- Config ----

/** Config for connecting to an MCP server via a spawned child process over stdio. */
export interface StdioConfig {
  /** Selects child-process stdio transport. */
  transport: 'stdio'
  /**
   * Stable local namespace for this server's model-facing tool names
   * (`mcp__<serverName>__<rawName>`). Must match `[A-Za-z0-9_-]{1,32}` and be
   * unique among live mcp-client instances in the same registration scope.
   */
  serverName: string
  /** Executable used to start the server. */
  command: string
  /**
   * The `argv[0]` the server sees when it differs from `command`. A reviewed
   * start sets it to the configured `command` while `command` names the
   * reviewed file, so a program that locates itself by its invoked name, such
   * as a virtual-environment `python` link, still does. `apply` drops a
   * configured value. Absent, the server sees `command`.
   */
  argv0?: string
  /** Arguments passed directly, without shell interpolation. */
  args: string[]
  /** Extra env vars merged on top of scrubbed ambient env. */
  env: Record<string, string>
  /** Working directory for the child process. */
  cwd: string
  /** Timeout per tool call or resource request in milliseconds. */
  toolCallTimeoutMs: number
  /** Optional budget for one connection attempt plus its initial tool sync, in milliseconds. */
  startupTimeoutMs?: number
  /** Budget for transport closure and local cleanup, in milliseconds (default 5000). */
  closeTimeoutMs: number
  /** Resolve `${credential:…}` in transport strings at runtime and redact resolved values from diagnostics (default false). */
  expandTemplates: boolean
  /** Fail plugin activation when the initial connection or tool synchronization fails. */
  failOnStartupError: boolean
  /** Maximum UTF-8 bytes of attributed server instructions (default 32768). */
  maxInstructionBytes?: number
  /** Automatic reconnect policy after a lost connection; omission uses the defaults. */
  reconnect?: ReconnectConfig
  /**
   * Absolute folders advertised to the server as its MCP roots, the client's
   * `roots` capability, answered on `roots/list` as `file:` URLs. Roots only
   * tell the server which folders the session works in; they grant the server
   * no access it does not already have. Omission or an empty list advertises no roots.
   */
  roots?: string[]
  /**
   * The server's own tool names that this client never registers: a denied tool is in no tool list, the model is not
   * offered it, and a call to it never reaches the server. A name the server does not list has no effect. Omission
   * denies nothing.
   */
  deniedTools?: string[]
}

/** Config for connecting to an MCP server over Streamable HTTP (SSE). */
export interface StreamableHttpConfig {
  /** Selects Streamable HTTP transport. */
  transport: 'streamable-http'
  /**
   * Stable local namespace for this server's model-facing tool names
   * (`mcp__<serverName>__<rawName>`). Must match `[A-Za-z0-9_-]{1,32}` and be
   * unique among live mcp-client instances in the same registration scope.
   */
  serverName: string
  /** MCP endpoint URL. */
  url: string
  /** Additional headers attached to MCP requests. */
  headers: Record<string, string>
  /** Timeout per tool call or resource request in milliseconds. */
  toolCallTimeoutMs: number
  /** Optional budget for one connection attempt plus its initial tool sync, in milliseconds. */
  startupTimeoutMs?: number
  /** Budget for transport closure and local cleanup, in milliseconds (default 5000). */
  closeTimeoutMs: number
  /** Resolve `${credential:…}` in transport strings at runtime and redact resolved values from diagnostics (default false). */
  expandTemplates: boolean
  /** Fail plugin activation when the initial connection or tool synchronization fails. */
  failOnStartupError: boolean
  /** Maximum UTF-8 bytes of attributed server instructions (default 32768). */
  maxInstructionBytes?: number
  /** Automatic reconnect policy after a lost connection; omission uses the defaults. */
  reconnect?: ReconnectConfig
  /**
   * Absolute folders advertised to the server as its MCP roots, the client's
   * `roots` capability, answered on `roots/list` as `file:` URLs. Roots only
   * tell the server which folders the session works in; they grant the server
   * no access it does not already have. Omission or an empty list advertises no roots.
   */
  roots?: string[]
  /**
   * The server's own tool names that this client never registers: a denied tool is in no tool list, the model is not
   * offered it, and a call to it never reaches the server. A name the server does not list has no effect. Omission
   * denies nothing.
   */
  deniedTools?: string[]
}

/** Configuration for one stdio or Streamable HTTP MCP server. */
export type Config = StdioConfig | StreamableHttpConfig

type StdioConfigInput = Omit<StdioConfig, 'argv0' | 'args' | 'env' | 'cwd' | 'toolCallTimeoutMs' | 'startupTimeoutMs' | 'failOnStartupError' | 'closeTimeoutMs' | 'expandTemplates'>
  & Partial<Pick<StdioConfig, 'args' | 'env' | 'cwd' | 'toolCallTimeoutMs' | 'startupTimeoutMs' | 'failOnStartupError' | 'closeTimeoutMs' | 'expandTemplates'>>
type StreamableHttpConfigInput = Omit<StreamableHttpConfig, 'headers' | 'toolCallTimeoutMs' | 'startupTimeoutMs' | 'failOnStartupError' | 'closeTimeoutMs' | 'expandTemplates'>
  & Partial<Pick<StreamableHttpConfig, 'headers' | 'toolCallTimeoutMs' | 'startupTimeoutMs' | 'failOnStartupError' | 'closeTimeoutMs' | 'expandTemplates'>>
type ConfigInput = StdioConfigInput | StreamableHttpConfigInput

/**
 * Reconnect-policy section schema, exported so a manager composing mcp-client
 * instances (`dsh-mcp-manager`) validates the same fields, defaults, and
 * bounds without restating them.
 */
export const ReconnectSchema: z<ReconnectConfig> = z.object({
  enabled: z.boolean().default(RECONNECT_DEFAULTS.enabled),
  initialDelayMs: z.number().min(1).max(MAX_TIMER_DELAY_MS).default(RECONNECT_DEFAULTS.initialDelayMs),
  maxDelayMs: z.number().min(1).max(MAX_TIMER_DELAY_MS).default(RECONNECT_DEFAULTS.maxDelayMs),
  maxAttempts: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(RECONNECT_DEFAULTS.maxAttempts),
})

/* jscpd:ignore-start */
// The catalog generator statically walks this literal and rejects spreads and
// computed keys, so the branches restate their shared rows by construction.
export const Config = z.union([
  z.object({
    transport: z.const('stdio'),
    serverName: z.string().required().pattern(SERVER_NAME_PATTERN),
    command: z.string().required(),
    args: z.array(String).default([]),
    env: z.dict(String).default({}),
    cwd: z.string().default(''),
    toolCallTimeoutMs: z.number().default(DEFAULT_TOOL_CALL_TIMEOUT_MS),
    startupTimeoutMs: z.number().min(1).max(MAX_TIMER_DELAY_MS),
    closeTimeoutMs: z.number().min(1).max(MAX_TIMER_DELAY_MS).default(DEFAULT_CLOSE_TIMEOUT_MS),
    expandTemplates: z.boolean().default(false),
    failOnStartupError: z.boolean().default(false),
    maxInstructionBytes: z.number().step(1).min(1).default(DEFAULT_MAX_INSTRUCTION_BYTES),
    reconnect: ReconnectSchema,
    roots: z.array(z.string().pattern(ABSOLUTE_ROOT_PATTERN)),
    deniedTools: z.array(z.string().pattern(/\S/u)),
  }),
  z.object({
    transport: z.const('streamable-http'),
    serverName: z.string().required().pattern(SERVER_NAME_PATTERN),
    url: z.string().required(),
    headers: z.dict(String).default({}),
    toolCallTimeoutMs: z.number().default(DEFAULT_TOOL_CALL_TIMEOUT_MS),
    startupTimeoutMs: z.number().min(1).max(MAX_TIMER_DELAY_MS),
    closeTimeoutMs: z.number().min(1).max(MAX_TIMER_DELAY_MS).default(DEFAULT_CLOSE_TIMEOUT_MS),
    expandTemplates: z.boolean().default(false),
    failOnStartupError: z.boolean().default(false),
    maxInstructionBytes: z.number().step(1).min(1).default(DEFAULT_MAX_INSTRUCTION_BYTES),
    reconnect: ReconnectSchema,
    roots: z.array(z.string().pattern(ABSOLUTE_ROOT_PATTERN)),
    deniedTools: z.array(z.string().pattern(/\S/u)),
  }),
]) as z<ConfigInput, Config>
/* jscpd:ignore-end */

// ---- Plugin apply ----

/**
 * Resolve a stdio server's start, have the consent review it, and return the
 * config that spawns the reviewed executable, or the path the consent's
 * decision names for it, in the reviewed directory. A file that runs directly
 * sees the configured `command` as its `argv[0]`; a Windows batch shim keeps
 * the command shell's own.
 * @param ctx - the mcp-client plugin's context, shown to the consent.
 * @param consent - the mounted consent.
 * @param config - the server's stdio configuration.
 * @returns the configuration to spawn.
 * @throws {McpServerStartUnresolvedError} when the start cannot be resolved.
 * @throws {McpConsentRefusedError} when the consent refuses the start.
 */
async function reviewedStart(ctx: Context, consent: McpAddConsent, config: StdioConfig): Promise<ReviewedStart> {
  const start = await resolveServerStart(config)
  const decision = await consent.review(start, ctx)
  if (!decision.allow) throw new McpConsentRefusedError(start, decision.reason)
  return {
    config: {
      ...config,
      command: decision.spawnCommand ?? start.resolvedCommand,
      ...decision.spawnArgs === undefined ? {} : { args: [...decision.spawnArgs] },
      ...start.resolvedShell === undefined ? { argv0: config.command } : {},
      cwd: start.resolvedCwd,
    },
    verify: decision.verify,
  }
}

/** A start the consent allowed: the configuration to spawn, and the check of its pinned files to run just before the spawn. */
interface ReviewedStart {
  readonly config: StdioConfig
  readonly verify: (() => Promise<string | undefined>) | undefined
}

/**
 * The hook that reviews a stdio server's start again before each reconnect
 * spawns it, so a file that changed while the server ran is reviewed before it
 * runs. It looks the consent up again; a consent that is no longer mounted
 * refuses the reconnect.
 * @param ctx - the mcp-client plugin's context.
 * @param config - the server's stdio configuration.
 * @param first - the start the first review allowed.
 * @returns the connection options, whose `beforeSpawn` rechecks the files of the latest allowed start just before each spawn.
 */
function reviewEachReconnect(ctx: Context, config: StdioConfig, first: ReviewedStart): ConnectionOptions {
  let latest = first
  return {
    beforeReconnect: async () => {
      const consent = await findMcpAddConsent(ctx, config.serverName)
      if (consent === undefined) {
        throw new Error(`mcp-client(${config.serverName}): the add-time consent that allowed this server is no longer mounted, so the server stays stopped`)
      }
      latest = await reviewedStart(ctx, consent, config)
      return latest.config
    },
    beforeSpawn: async () => {
      const changed = await latest.verify?.()
      if (changed !== undefined) throw new Error(`mcp-client(${config.serverName}): ${changed}, so the server was not started`)
    },
  }
}

/**
 * A configuration without the `argv0` only a reviewed start sets.
 * @param config - the configuration as the row gave it.
 * @returns the configuration without `argv0`.
 */
function withoutArgv0(config: Config): Config {
  if (config.transport !== 'stdio' || config.argv0 === undefined) return config
  const { argv0: _reviewedOnly, ...rest } = config
  return rest
}

/**
 * Connect one MCP server and publish its initial tool generation before activation.
 * This entry remains explicitly `async`: Cordis treats a prototype-bearing
 * ordinary function as a constructor, whose returned Promise is not startup work.
 * @param ctx - plugin context carrying the tool registry.
 * @param configured - resolved transport and server namespace configuration.
 * @returns startup readiness after connection and initial tool discovery settle.
 */
export async function apply(ctx: Context, configured: Config): Promise<void> {
  // Only a reviewed start sets argv0; a configured one is dropped, as upstream ignores it.
  const config = withoutArgv0(configured)
  // Fail loud at load: reconnect misconfiguration (including programmatic
  // construction that bypassed Schemastery) rejects THIS instance before any
  // effect registers.
  const reconnect = resolveReconnectPolicy(config.reconnect, `mcp-client(${config.serverName}): reconnect`)

  // Optional add-time consent seam: a stdio server command runs as a local
  // child process outside the agent sandbox, so when a consent service is
  // mounted, or a loader row declares one, the configured start — command,
  // arguments, working directory and environment, with the executable path
  // and working directory they resolve to now — is reviewed at every boot and
  // the server does not start until the review allows it, and again before
  // every reconnect spawns it, so a file that changed while the server ran is
  // reviewed before it runs again. The allowed server
  // is spawned with the reviewed executable path, or the path the decision
  // names for it, and working directory, so a later change of the Host's
  // working directory or PATH cannot swap them.
  // The lookup waits for declaring rows, so the result does not depend on row
  // order. Without a provider — or for a Streamable HTTP server, which starts
  // no local command — startup is exactly upstream's. An unresolved start or a
  // refusal fails THIS instance at load, which leaves the server stopped with
  // the typed reason. With `expandTemplates`, the review sees the arguments and
  // environment as configured, so no credential value reaches it, while a
  // `command` or `cwd` that holds a template does not resolve to a file and is
  // refused at load; the reviewed `command` and `cwd` replace the configured ones at
  // every attempt.
  if (config.transport === 'stdio' && config.expandTemplates) assertLiteralStart(config)
  let spawned: Config = config
  let connectionOptions: ConnectionOptions = {}
  if (config.transport === 'stdio') {
    const consent = await findMcpAddConsent(ctx, config.serverName)
    if (consent !== undefined) {
      const first = await reviewedStart(ctx, consent, config)
      spawned = first.config
      connectionOptions = reviewEachReconnect(ctx, config, first)
    }
  }

  // Namespace reservations are scope-local; status belongs to the actual
  // Fiber and survives its reloads and final disposal.
  let status!: ReturnType<typeof registerStatusCell>
  ctx.effect(() => {
    const owner = scopeOf(ctx) ?? ctx.root
    let names = activeServerNames.get(owner)
    if (!names) {
      names = new Set()
      activeServerNames.set(owner, names)
    }
    if (names.has(config.serverName)) {
      throw new Error(
        `mcp-client: serverName "${config.serverName}" is already in use by another mcp-client instance — pick a unique serverName in cordis.yml`,
      )
    }
    names.add(config.serverName)
    status = registerStatusCell(ctx.fiber, (message, error) => {
      ctx.logger.warn(`mcp-client(${config.serverName}): ${message}`)
      if (!config.expandTemplates) ctx.logger.warn(error)
    })
    return () => {
      if (ctx.fiber.uid === null) status.detach()
      names.delete(config.serverName)
    }
  }, 'mcp-client.serverName')

  // The supervisor owns the client/transport generations, the reconnect
  // loop, and the live tool registrations; disposal stops reconnection,
  // quiesces in-flight work, and unregisters the current generation.
  if (!status.closure().closeConfirmed || status.closure().cleanupError !== undefined) {
    throw new Error(`mcp-client(${config.serverName}): previous connection cleanup is incomplete; restart the Host`)
  }
  const connection = startConnection(ctx, spawned, reconnect, status, connectionOptions)
  let stopping: Promise<void> | undefined
  const dispose = (): Promise<void> => stopping ??= connection.dispose()
  // Cordis announces unload before awaiting an unfinished apply(). Closing
  // the transport here releases startup requests that are still awaiting a reply.
  // oxlint-disable-next-line typescript/no-misused-promises -- Cordis contains observer failures; the effect also awaits this promise.
  ctx.on('internal/plugin', (fiber) => {
    if (fiber !== ctx.fiber || fiber.uid !== null) return
    return dispose()
  }, { global: true })
  ctx.effect(() => dispose, 'mcp-client.connection')
  registerServerContext(ctx, config.serverName, connection)

  // Block plugin activation on the initial connection + tool discovery so
  // Cordis consumers observe the tools immediately after the fiber activates.
  // When failOnStartupError is true, a failed initial attempt rejects the
  // fiber (Cordis rolls it back); otherwise the error is logged and the
  // supervisor applies its reconnect or credential-wait policy.
  const outcome = await connection.ready
  if (outcome.error !== undefined && config.failOnStartupError) {
    throw new Error(`mcp-client(${config.serverName}): initial connection or tool synchronization failed`, { cause: outcome.error })
  }
}
