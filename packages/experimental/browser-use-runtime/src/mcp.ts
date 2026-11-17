/** Session-owned MCP browser processes and provider catalog activation. @module */

import { mkdir } from 'node:fs/promises'
import type { Context } from '@deepseek-ai/cordis'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import type { Agent } from '@deepseek-ai/dsh-agent'
import Schema from '@deepseek-ai/schemastery'
import { BrowserUseProviderName } from '@deepseek-ai/dsh-browser-use/brand'
import * as McpClient from '@deepseek-ai/dsh-mcp-client'
import { createScope } from '@deepseek-ai/dsh-scope'
import type { Scope } from '@deepseek-ai/dsh-scope'
import { SessionResources } from './index.ts'
import type {} from '@deepseek-ai/dsh-browser-use'
import type { ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-working-directory'

/** Browser launch settings shared by the MCP integrations. */
export interface BrowserMcpLaunchConfig {
  /** Launch a new isolated Chromium browser for each live Session. */
  mode: 'launch'
  /** Whether Chromium runs without a visible window; defaults to true. */
  headless: boolean
  /** Chromium executable; omission uses the upstream server's installation discovery. */
  executablePath?: string
  /** Per-call timeout override in milliseconds; omission uses the MCP client default. */
  toolCallTimeoutMs?: number
  /** Where the MCP server process runs; see {@link BrowserServerDirectory}. Omission is `session`. */
  serverDirectory?: BrowserServerDirectory
}

/** Attachment to an externally owned Chromium browser. */
export interface BrowserMcpAttachConfig {
  /** Exclusively attach one live Session to the configured browser. */
  mode: 'attach'
  /** HTTP(S) debugging URL or WS(S) browser debugging endpoint. */
  endpoint: string
  /** Per-call timeout override in milliseconds; omission uses the MCP client default. */
  toolCallTimeoutMs?: number
  /** Where the MCP server process runs; see {@link BrowserServerDirectory}. Omission is `session`. */
  serverDirectory?: BrowserServerDirectory
}

/**
 * Where a browser MCP server process runs: `session` starts each Session's server in that Session's working directory;
 * `home` starts every Session's server in one folder of the Harness home, `browser-use/<server name>`, so the server's
 * command, arguments and working directory are the same for every Session.
 */
export type BrowserServerDirectory = 'session' | 'home'

/** Fixed launch or attachment choice for one MCP browser provider. */
export type BrowserMcpConfig = BrowserMcpLaunchConfig | BrowserMcpAttachConfig

/** Validate the browser mode before the provider reserves browser use. */
export const BrowserMcpConfig: Schema<BrowserMcpAttachConfig | (Omit<BrowserMcpLaunchConfig, 'headless'> & { headless?: boolean }), BrowserMcpConfig> = Schema.union([
  Schema.object({
    mode: Schema.const('launch').required(),
    headless: Schema.boolean().default(true),
    executablePath: Schema.string().pattern(/\S/u),
    toolCallTimeoutMs: Schema.number().min(1),
    serverDirectory: Schema.union(['session', 'home']),
  }),
  Schema.object({
    mode: Schema.const('attach').required(),
    endpoint: Schema.string().pattern(/^https?:\/\/[^\s/]+|^wss?:\/\/[^\s/]+/u).required(),
    toolCallTimeoutMs: Schema.number().min(1),
    serverDirectory: Schema.union(['session', 'home']),
  }),
])

/**
 * Reject an invalid debugging endpoint before acquiring provider or browser resources.
 * @param config - schema-validated browser selection.
 */
export function validateBrowserMcpConfig(config: BrowserMcpConfig): void {
  if (config.mode !== 'attach') return
  let endpoint: URL
  try {
    endpoint = new URL(config.endpoint)
  } catch (error) {
    throw new Error('browser endpoint must be a valid HTTP(S) or WS(S) URL', { cause: error })
  }
  if (!['http:', 'https:', 'ws:', 'wss:'].includes(endpoint.protocol) || /\s/u.test(config.endpoint)) {
    throw new Error('browser endpoint must be a valid HTTP(S) or WS(S) URL without whitespace')
  }
}

/**
 * The folder a provider's server runs in for every Session.
 * @param config - the provider's browser configuration.
 * @param name - the provider's server name.
 * @returns `browser-use/<name>` in the Harness home for `home`, or `undefined` for each Session's working directory.
 */
export function browserServerDirectory(config: BrowserMcpConfig, name: string): string | undefined {
  return config.serverDirectory === 'home' ? dshHomePath('browser-use', name) : undefined
}

/** Provider-owned connection options for one live Session. */
export interface SessionMcpOptions {
  /** Provider identity and MCP tool namespace. */
  name: string
  /** Whether another live Session must wait for the attached browser to be released. */
  exclusive: boolean
  /** Executable used to start the installed MCP server. */
  command: string
  /** Arguments passed directly without a shell. */
  args: string[]
  /**
   * Absolute folder every Session's server runs in, created with mode 0700 before a start when it is missing.
   * Omission starts each Session's server in that Session's working directory.
   */
  directory?: string
  /** Explicit overrides merged into the MCP client's scrubbed child environment. */
  env?: Record<string, string>
  /** Per-call timeout override; omission retains the MCP client default. */
  toolCallTimeoutMs?: number
  /**
   * The model-visible text that replaces a browser tool failure the person, not the model, must resolve, such as a
   * browser build that is not installed.
   * @param message - the failed call's error message.
   * @returns the replacement, or `undefined` to keep the failure as the server reported it.
   */
  explainFailure?: (message: string) => string | undefined
}

/**
 * A browser tool failure with the provider's replacement text.
 * @param result - the failed call's result.
 * @param explain - the provider's replacement, when it has one.
 * @returns the failure whose content and message are the replacement, or the result unchanged.
 */
function explained(result: ToolExecutionResult, explain: SessionMcpOptions['explainFailure']): ToolExecutionResult {
  if (!result.isError || explain === undefined) return result
  const message = explain(result.error.message)
  if (message === undefined) return result
  return { isError: true, error: { message }, content: [{ type: 'text', text: `Error: ${message}` }] }
}

/**
 * A fixed server folder, created when missing.
 * @param directory - the absolute folder.
 * @returns the folder.
 */
async function fixedDirectory(directory: string): Promise<string> {
  await mkdir(directory, { recursive: true, mode: 0o700 })
  return directory
}

interface ClientState {
  /** `ready` holds a started client; `blocked` waits for a busy attachment; `refused` is a start the add-time consent did not allow. */
  status: 'ready' | 'blocked' | 'refused'
  mask?: Scope
}

/**
 * Whether a failed acquisition is the add-time consent keeping the server stopped, which leaves one Session without
 * browser tools rather than failing its creation.
 * @param error - the acquisition's failure.
 * @returns true for a refused start or a declared consent that did not start.
 */
function isConsentStop(error: unknown): error is McpClient.McpConsentRefusedError | McpClient.McpConsentUnavailableError {
  return error instanceof McpClient.McpConsentRefusedError || error instanceof McpClient.McpConsentUnavailableError
}

/**
 * Await one MCP client during each future Agent's creation.
 * A busy attachment leaves that activation without browser tools; its other turns continue. A start the mounted
 * add-time consent refuses, or a declared consent that did not start, also leaves that activation without browser
 * tools and logs a warning naming the server and the consent's reason; the Agent is still created, and the next
 * activation reviews the start again. Every other startup failure fails the Agent's creation.
 * Calls are serialized per Session; unload closes every server before releasing registration.
 * @param ctx - provider context supplying browser use, Agents, tools, prompt assembly, and working directories.
 * @param options - provider identity, attachment exclusivity, and executable configuration.
 * @throws when the working-directory provider is absent, before browser resources are registered.
 */
export function mountSessionMcp(ctx: Context, options: SessionMcpOptions): void {
  const workingDirectory = ctx.get('workingDirectory')
  if (workingDirectory === undefined) throw new Error(`${options.name}: browser MCP requires a working-directory provider`)
  let resources!: SessionResources<Scope>
  const clients = new Map<Agent, ClientState>()
  const toolPrefix = `mcp__${options.name}__`
  const resourceTools = new Set(['list_mcp_resources', 'list_mcp_resource_templates', 'read_mcp_resource'])
  let stopping = false
  let refreshingMasks = false

  const refreshBlockedMasks = (): void => {
    if (stopping || refreshingMasks) return
    refreshingMasks = true
    try {
      for (const [agent, state] of clients) {
        if (state.status === 'ready') continue
        const inherited = ctx.tools.schemas(agent).filter(tool => tool.name.startsWith(toolPrefix))
        if (inherited.length === 0) continue
        state.mask ??= createScope(ctx, agent)
        state.mask.ctx.tools.restrict({ deny: inherited.map(tool => tool.name) })
      }
    } finally {
      refreshingMasks = false
    }
  }

  ctx.effect(function* () {
    yield ctx.browserUse.register(BrowserUseProviderName(options.name))
    resources = new SessionResources(ctx, {
      label: options.name,
      exclusive: options.exclusive,
      async open(agent, signal) {
        const scope = createScope(ctx, agent)
        let cancellation: Promise<void> | undefined
        const cancel = (): void => { cancellation = scope.dispose() }
        signal.addEventListener('abort', cancel, { once: true })
        try {
          signal.throwIfAborted()
          scope.ctx.on('tools/execute', async (exec, next) => {
            if (!exec.name.startsWith(toolPrefix)) return next()
            if (exec.agent !== agent) {
              if (ctx.tools.get(exec.name, exec.agent) !== ctx.tools.get(exec.name, agent)) return next()
              throw new Error(`${options.name}: browser tool belongs to another Session`)
            }
            return next()
          })
          await scope.ctx.plugin(McpClient, McpClient.Config({
            transport: 'stdio',
            serverName: options.name,
            command: options.command,
            args: options.args,
            ...options.env === undefined ? {} : { env: options.env },
            cwd: options.directory === undefined ? await workingDirectory.ensure(agent, signal) : await fixedDirectory(options.directory),
            ...options.toolCallTimeoutMs === undefined ? {} : { toolCallTimeoutMs: options.toolCallTimeoutMs },
            failOnStartupError: true,
            reconnect: { enabled: false },
          }))
          signal.throwIfAborted()
          return {
            value: scope,
            close() {
              clients.delete(agent)
              return scope.dispose()
            },
          }
        } catch (error) {
          await (cancellation ?? scope.dispose())
          throw error
        } finally {
          signal.removeEventListener('abort', cancel)
        }
      },
    })
    yield async () => {
      stopping = true
      await resources.dispose()
      clients.clear()
    }
  }, `${options.name}.sessions`)
  ctx.on('agent/created', async ({ agent, signal }) => {
    const state: ClientState = { status: resources.available(agent) ? 'ready' : 'blocked' }
    agent.ctx.effect(() => async () => {
      clients.delete(agent)
      await state.mask?.dispose()
    }, `${options.name}.activation`)
    if (state.status === 'blocked') {
      clients.set(agent, state)
      refreshBlockedMasks()
      return
    }
    try {
      await resources.get(agent, signal)
    } catch (error) {
      if (!isConsentStop(error)) throw error
      // The consent keeps the server stopped and lists it for the person's answer; this Session runs without its tools.
      ctx.logger.warn(`${options.name}: the browser tools are off in Session ${agent.id} until the server's start is allowed: ${error.message}`)
      state.status = 'refused'
      clients.set(agent, state)
      refreshBlockedMasks()
      return
    }
    clients.set(agent, state)
  }, { prepend: true })
  ctx.on('tools/change', refreshBlockedMasks)
  ctx.on('tools/execute', async (exec, next) => {
    const ownResource = resourceTools.has(exec.name)
      && typeof exec.arguments === 'object' && exec.arguments !== null
      && (exec.arguments as { server?: unknown }).server === options.name
    if (!exec.name.startsWith(toolPrefix) && !ownResource) return next()
    const agent = exec.agent
    if (agent === undefined || clients.get(agent)?.status !== 'ready') {
      throw new Error(`${options.name}: browser tool belongs to another Session`)
    }
    const result = await resources.run(agent, exec.signal, async (_scope, combined) => {
      const original = exec.signal
      exec.signal = combined
      try {
        return await next()
      } finally {
        exec.signal = original
      }
    })
    return explained(result, options.explainFailure)
  })
  ctx.on('system-prompt/assemble', async (_assembly, { agent }, next) => {
    const assembly = await next()
    if (agent === undefined || clients.get(agent)?.status === 'ready') return assembly
    return { ...assembly, sections: assembly.sections.filter(section => section.name !== `mcp:${options.name}`) }
  })
}
