/** Session-owned MCP browser processes and provider catalog activation. @module */

import { chmod, lstat, mkdir, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
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

/** The launch fields every MCP browser provider accepts; a provider with fields of its own adds them to these. */
export const browserMcpLaunchFields = {
  mode: Schema.const('launch').required(),
  headless: Schema.boolean().default(true),
  executablePath: Schema.string().pattern(/\S/u),
  toolCallTimeoutMs: Schema.number().min(1),
  serverDirectory: Schema.union(['session', 'home']),
}

/** The attachment fields every MCP browser provider accepts. */
export const browserMcpAttachFields = {
  mode: Schema.const('attach').required(),
  endpoint: Schema.string().pattern(/^https?:\/\/[^\s/]+|^wss?:\/\/[^\s/]+/u).required(),
  toolCallTimeoutMs: Schema.number().min(1),
  serverDirectory: Schema.union(['session', 'home']),
}

/** Validate the browser mode before the provider reserves browser use. */
export const BrowserMcpConfig: Schema<BrowserMcpAttachConfig | (Omit<BrowserMcpLaunchConfig, 'headless'> & { headless?: boolean }), BrowserMcpConfig> = Schema.union([
  Schema.object(browserMcpLaunchFields),
  Schema.object(browserMcpAttachFields),
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
   * Absolute folder every Session's server runs in, created with mode 0700 before a start when it is missing and
   * narrowed to that mode when it exists with access for others.
   * Omission starts each Session's server in that Session's working directory. Either way the server is told the
   * Session's working directory as its one MCP root, where a server such as Playwright's saves its output files.
   */
  directory?: string
  /**
   * The folder, relative to the Session's working directory, that the server saves its output files to. When a
   * Session's server has started, that folder is created if missing and given a `.gitignore` of `*` if it has none, so
   * Git leaves the files out of commits. A link at the folder's name, an existing `.gitignore` and the project's own
   * `.gitignore` are never changed, and a Session whose server did not start gets no folder.
   */
  outputFolder?: string
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
  /**
   * Refuse one browser tool call before it reaches the server, such as one whose file argument leads outside the
   * Session's folder. A refused call fails with the returned text and the server never sees it.
   * @param call - the tool's name without the server prefix, the model's arguments as received, and the folder the
   * Session's server was told as its MCP root.
   * @returns the model-visible refusal, or `undefined` to let the call through.
   */
  refuseCall?: (call: BrowserToolCall) => Promise<string | undefined>
  /**
   * `slot` (the default) registers the provider as the browser-use slot's one provider; `none` registers nothing, for a
   * second browser that sits beside the slot's provider, such as the person's own browser.
   */
  registration?: 'slot' | 'none'
  /**
   * Which Sessions the server serves. Omission serves every Session. With it, a Session it does not admit gets no
   * server, its browser tools are masked and refused, and the server's prompt section is left out; when
   * {@link SessionMcpAdmission.changed} reports the Session, an admitted one starts the server and one no longer
   * admitted stops it.
   */
  admission?: SessionMcpAdmission
  /**
   * The server's own tool names that are turned off, such as one that runs model-written code in the server process:
   * the MCP client never registers them, so no Session is offered them and a call to one never reaches the server.
   */
  deniedTools?: string[]
}

/** The provider's rule for which Sessions a {@link mountSessionMcp} server serves. */
export interface SessionMcpAdmission {
  /**
   * Whether a live Agent's Session is served now.
   * @param agent - the Agent.
   * @returns whether the server may start and serve its tools to it.
   */
  admitted(agent: Agent): boolean
  /**
   * Hear each Session whose admission may have changed.
   * @param listener - called with the Session after the change; it settles once the Session's server has started or
   *   stopped to match, so a provider can wait for the browser tools before it answers.
   * @returns the disposer, called when the mount unloads.
   */
  changed(listener: (session: Agent['session']) => Promise<void>): () => void
}

/** One browser tool call offered to a provider's {@link SessionMcpOptions.refuseCall}. */
export interface BrowserToolCall {
  /** The server's own tool name, without the `mcp__<server>__` prefix. */
  tool: string
  /** The arguments the model sent, not yet validated against the tool's schema. */
  arguments: unknown
  /** The Session's working directory when its server started, which the server was told as its one MCP root. */
  directory: string
}

/**
 * A failed tool result carrying one message.
 * @param message - the model-visible failure.
 * @returns the failure.
 */
function failure(message: string): ToolExecutionResult {
  return { isError: true, error: { message }, content: [{ type: 'text', text: `Error: ${message}` }] }
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
  return message === undefined ? result : failure(message)
}

/**
 * A fixed server folder that only its owner can enter: created with mode 0700 when missing, and an existing folder
 * that others can enter is narrowed to it.
 * @param directory - the absolute folder.
 * @returns the folder.
 */
async function fixedDirectory(directory: string): Promise<string> {
  await mkdir(directory, { recursive: true, mode: 0o700 })
  if (((await stat(directory)).mode & 0o077) !== 0) await chmod(directory, 0o700)
  return directory
}

/**
 * Make Git ignore everything in a server's output folder: create the folder when it is missing, and give it a
 * `.gitignore` of `*` when it has none. Nothing is written through a link: a link or a file at the folder's name is
 * left alone, and so is whatever exists at `.gitignore`, a link included.
 * @param folder - the absolute folder.
 * @throws when the folder or its `.gitignore` cannot be created for a reason other than already existing.
 */
async function ignoredOutputFolder(folder: string): Promise<void> {
  try {
    await mkdir(folder, { mode: 0o700 })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    if (!(await lstat(folder)).isDirectory()) return
  }
  try {
    // Exclusive creation fails on any existing name without following it, so a person's own rules stay theirs.
    await writeFile(join(folder, '.gitignore'), '*\n', { flag: 'wx' })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
}

interface ClientState {
  /**
   * `ready` holds a started client; `blocked` waits for a busy attachment; `refused` is a start the add-time consent did
   * not allow; `unadmitted` is a Session the provider's admission does not serve.
   */
  status: 'ready' | 'blocked' | 'refused' | 'unadmitted'
  mask?: Scope
  /** The admission change running for this Session; changes run one after another. */
  transition?: Promise<void>
  /**
   * Whether an admission change is starting or closing the Session's server: its own tools, which the start adds and
   * the close removes, are not masked meanwhile.
   */
  changing?: boolean
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
 * Once a Session's server has started, its output folder, when the provider names one, is created if missing and given
 * a `.gitignore` of `*` if it has none; a failure to do so is logged as a warning and the Session keeps its tools.
 * A call the provider's `refuseCall` refuses fails with the provider's text and never reaches the server.
 * With an admission, a Session it does not admit gets no server and its browser tool calls are refused; its later
 * admission starts the server, and the end of its admission stops it. A start that fails after creation is logged and
 * leaves the Session without the tools. With `registration: 'none'` the mount takes no browser-use slot.
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
        if (state.status === 'ready' || state.changing === true) continue
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
    if (options.registration !== 'none') yield ctx.browserUse.register(BrowserUseProviderName(options.name))
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
          const sessionDirectory = await workingDirectory.ensure(agent, signal)
          scope.ctx.on('tools/execute', async (exec, next) => {
            if (!exec.name.startsWith(toolPrefix)) return next()
            if (exec.agent !== agent) {
              if (ctx.tools.get(exec.name, exec.agent) !== ctx.tools.get(exec.name, agent)) return next()
              throw new Error(`${options.name}: browser tool belongs to another Session`)
            }
            const refusal = await options.refuseCall?.({
              tool: exec.name.slice(toolPrefix.length), arguments: exec.arguments, directory: sessionDirectory,
            })
            return refusal === undefined ? next() : failure(refusal)
          })
          await scope.ctx.plugin(McpClient, McpClient.Config({
            transport: 'stdio',
            serverName: options.name,
            command: options.command,
            args: options.args,
            ...options.env === undefined ? {} : { env: options.env },
            cwd: options.directory === undefined ? sessionDirectory : await fixedDirectory(options.directory),
            roots: [sessionDirectory],
            ...options.deniedTools === undefined ? {} : { deniedTools: options.deniedTools },
            ...options.toolCallTimeoutMs === undefined ? {} : { toolCallTimeoutMs: options.toolCallTimeoutMs },
            failOnStartupError: true,
            reconnect: { enabled: false },
          }))
          if (options.outputFolder !== undefined) {
            try {
              await ignoredOutputFolder(join(sessionDirectory, options.outputFolder))
            } catch (error) {
              // The browser tools still work; only the Git protection of their saved files is missing, which the log names.
              ctx.logger.warn(`${options.name}: could not create ${options.outputFolder} with a .gitignore in Session ${agent.id}'s folder, so Git may pick up files the browser saves there: ${(error as Error).message}`)
            }
          }
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
  /** Start the server for an admitted Session that holds no client; a consent refusal leaves it `refused`. */
  const start = async (agent: Agent, state: ClientState, signal?: AbortSignal): Promise<void> => {
    if (!resources.available(agent)) {
      state.status = 'blocked'
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
      refreshBlockedMasks()
      return
    }
    state.status = 'ready'
    const mask = state.mask
    delete state.mask
    await mask?.dispose()
  }

  /** Follow one Session's admission: start its server once admitted, stop it once no longer admitted. */
  const readmit = async (agent: Agent, state: ClientState): Promise<void> => {
    if (stopping || clients.get(agent) !== state) return
    const admitted = options.admission?.admitted(agent) ?? true
    if (admitted && state.status === 'unadmitted') {
      state.changing = true
      try {
        await start(agent, state)
      } catch (error) {
        // The Session keeps running without the browser tools; the next change of its admission tries again.
        state.status = 'unadmitted'
        ctx.logger.error(`${options.name}: could not start the browser server for Session ${agent.id}: ${(error as Error).message}`)
      } finally {
        state.changing = false
        refreshBlockedMasks()
      }
    } else if (!admitted && state.status !== 'unadmitted') {
      // Calls are refused from here on; the server's own tools leave with it, and only inherited ones need a mask.
      state.status = 'unadmitted'
      state.changing = true
      try {
        await resources.release(agent)
      } finally {
        state.changing = false
        refreshBlockedMasks()
      }
    }
  }

  if (options.admission !== undefined) {
    const admission = options.admission
    ctx.effect(() => admission.changed(async (session) => {
      const transitions: Promise<void>[] = []
      for (const [agent, state] of clients) {
        if (agent.session !== session) continue
        const previous = state.transition ?? Promise.resolve()
        state.transition = previous.then(() => readmit(agent, state))
        transitions.push(state.transition)
      }
      await Promise.all(transitions)
    }), `${options.name}.admission`)
  }

  ctx.on('agent/created', async ({ agent, signal }) => {
    const unadmitted = options.admission !== undefined && !options.admission.admitted(agent)
    const state: ClientState = { status: unadmitted ? 'unadmitted' : resources.available(agent) ? 'ready' : 'blocked' }
    agent.ctx.effect(() => async () => {
      clients.delete(agent)
      await state.transition
      await state.mask?.dispose()
    }, `${options.name}.activation`)
    if (state.status === 'unadmitted' || state.status === 'blocked') {
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
    const status = agent === undefined ? undefined : clients.get(agent)?.status
    if (status === 'unadmitted') throw new Error(`${options.name}: this Session may not use this browser`)
    if (agent === undefined || status !== 'ready') {
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
