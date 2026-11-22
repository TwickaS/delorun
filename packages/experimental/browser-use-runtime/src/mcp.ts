/** Session-owned MCP browser processes and provider catalog activation. @module */

import { createHash } from 'node:crypto'
import { chmod, lstat, mkdir, realpath, stat, writeFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { pathWithin, writableRoots } from '@deepseek-ai/dsh-sandbox'
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
import type {} from '@deepseek-ai/dsh-sandbox-policy'
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
  /**
   * Absolute folder under which the Host creates one output folder for each Session, with mode 0700, and tells the
   * server to save its output files there instead of in the Session's working directory (`PLAYWRIGHT_MCP_OUTPUT_DIR`).
   * Choose a folder no sandbox grants a confined command write access to, so a sandboxed command cannot replace the
   * Session's output folder. When set, {@link outputFolder} is ignored and the Session's own folder gets no output
   * folder.
   */
  outputRoot?: string
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
   * Replace the arguments of a browser tool call before it reaches the server, after {@link refuseCall} let it through,
   * such as a path the server would read replaced by a copy the Host made, so the server never opens a path a confined
   * command can swap.
   * @param call - the call, as given to {@link refuseCall}.
   * @returns the model-visible refusal; or `arguments`, whose entries replace the same-named entries of the call's
   * arguments, and the `note` that is added to the call's result so the model and the log show what the server got; or
   * `undefined` to send the call as it is. A throw fails the call.
   */
  prepareCall?: (call: BrowserToolCall) => Promise<string | { arguments: Record<string, unknown>; note?: string } | undefined>
  /**
   * Check what a browser tool call left behind, after the server answered, such as a file saved outside the Session's
   * folder. A result it refuses is replaced by a failure with the returned text. It runs after failed calls too,
   * because a call can write a file and still fail; its own failure is kept when it refuses nothing.
   * @param call - the call, as given to {@link refuseCall}.
   * @param startedAt - the time, in milliseconds since the epoch, taken just before the call was sent to the server.
   * @returns the model-visible refusal, or `undefined` to keep the result.
   */
  checkResult?: (call: BrowserToolCall, startedAt: number) => Promise<string | undefined>
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
  /** The Session's output folder, when the provider set {@link SessionMcpOptions.outputRoot}. */
  outputDirectory?: string
}

/**
 * Create a Session's output folder under the provider's output root.
 * @param root - the provider's output root.
 * @param sessionId - the Session's id.
 * @returns the folder, named by a digest of the id so the name is safe on every file system, with mode 0700.
 */
async function sessionOutputDirectory(root: string, sessionId: string): Promise<string> {
  const directory = join(await fixedDirectory(root), createHash('sha256').update(sessionId).digest('hex').slice(0, 32))
  return fixedDirectory(directory)
}

/**
 * The refusal of a Session's output folder, which leaves Browser off in that chat instead of failing the chat's creation.
 * The chat starts with Browser's tools off; the message is the plain reason, and it is written to Delorun's log.
 */
export class OutputFolderRefusedError extends Error {
  override readonly name = 'OutputFolderRefusedError'
}

/**
 * Resolve a path to its canonical form.
 * @param path - the path.
 * @returns the canonical path.
 * @throws {OutputFolderRefusedError} when the file system fails the call (an error with a string errno `code` and a `syscall`);
 *   any other error propagates.
 */
async function resolvedPath(path: string): Promise<string> {
  try {
    return await realpath(path)
  } catch (error) {
    const { code, syscall } = error as NodeJS.ErrnoException
    if (typeof code !== 'string' || syscall === undefined) throw error
    throw new OutputFolderRefusedError(`Browser is off in this chat: its output folder could not be checked against the folders this chat can write (${(error as Error).message}).`, { cause: error })
  }
}

/** Where a writable folder that overlaps the output folder comes from, which decides the advice. */
type OverlapSource = 'workspace' | 'extra'

/**
 * Refuse an output folder that overlaps a folder a confined command of the Session can write: inside one, the chat could
 * replace the output folder; around one, that folder would be inside the output folder. The writable folders are the
 * Session's working directory and, when a sandbox policy is provided, the policy's workspace-write roots, the
 * workspace, the extra writable directories and the temp areas, whatever mode the Session is in now. A path the file
 * system fails to resolve refuses too; any other error propagates.
 * @param ctx - the provider context, which may provide the sandbox policy.
 * @param agent - the Agent whose Session starts.
 * @param output - the Session's output folder.
 * @param sessionDirectory - the Session's working directory.
 * @throws {OutputFolderRefusedError} when either folder is inside the other, or a folder cannot be resolved; the message
 *   names the cause and the remedy.
 */
async function assertOutsideWritableFolders(ctx: Context, agent: Agent, output: string, sessionDirectory: string): Promise<void> {
  const policy = ctx.get('sandboxPolicy')?.resolve({ session: agent.session, mode: 'workspace-write' })
  const writable: Array<{ path: string; source: OverlapSource }> = [
    { path: sessionDirectory, source: 'workspace' },
    ...policy === undefined ? [] : [
      { path: policy.workspaceRoot, source: 'workspace' as const },
      ...writableRoots(policy).map(path => ({ path, source: 'extra' as const })),
    ],
  ]
  const folder = await resolvedPath(output)
  for (const candidate of writable) {
    const real = await resolvedPath(candidate.path).catch((error: unknown) => {
      if (error instanceof OutputFolderRefusedError && (error.cause as NodeJS.ErrnoException).code === 'ENOENT') return candidate.path
      throw error
    })
    if (!pathWithin(folder, real) && !pathWithin(real, folder)) continue
    const cache = process.env.XDG_CACHE_HOME
    const cacheInside = cache !== undefined && isAbsolute(cache) && pathWithin(folder, await resolvedPath(cache).catch(() => cache))
    const remedy = cacheInside && pathWithin(folder, real)
      ? 'XDG_CACHE_HOME points inside it; point XDG_CACHE_HOME somewhere this chat cannot write.'
      : candidate.source === 'workspace'
        ? "Use a workspace that isn't your home folder."
        : `${real} is an extra folder this chat can write; remove it from the chat's writable folders, or use a different workspace.`
    throw new OutputFolderRefusedError(`Browser is off in this chat: its output folder would sit inside a folder this chat can write (${real}). ${remedy}`)
  }
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

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * The add-time consent accepted one server's start. A provider that mounts the server per Session starts it again
     * in the live Sessions the refusal left without its tools; the consent is still checked at that start.
     * @param serverName - the accepted server.
     * @mode parallel
     */
    'mcp-client/consent-accepted'(serverName: string): void | Promise<void>
  }
}

interface ClientState {
  /**
   * `ready` holds a started client; `blocked` waits for a busy attachment; `refused` is a start the add-time consent did
   * not allow; `unadmitted` is a Session the provider's admission does not serve.
   */
  status: 'ready' | 'blocked' | 'refused' | 'unadmitted'
  mask?: Scope
  /** The admission change or consent retry running for this Session; they run one after another. */
  transition?: Promise<void>
  /**
   * Whether an admission change is starting or closing the Session's server: its own tools, which the start adds and
   * the close removes, are not masked meanwhile.
   */
  changing?: boolean
  /** The Agent's creation signal, which a later start of a `refused` Session runs under. */
  signal?: AbortSignal | undefined
}

/**
 * Whether a failed acquisition is the add-time consent keeping the server stopped, which leaves one Session without
 * browser tools rather than failing its creation.
 * @param error - the acquisition's failure.
 * @returns true for a refused start, a declared consent that did not start, or a refused output folder.
 */
function isConsentStop(
  error: unknown,
): error is McpClient.McpConsentRefusedError | McpClient.McpConsentUnavailableError | OutputFolderRefusedError {
  return error instanceof McpClient.McpConsentRefusedError || error instanceof McpClient.McpConsentUnavailableError
    || error instanceof OutputFolderRefusedError
}

/**
 * Await one MCP client during each future Agent's creation.
 * A busy attachment leaves that activation without browser tools; its other turns continue. A start the mounted
 * add-time consent refuses, or a declared consent that did not start, also leaves that activation without browser
 * tools and logs a warning naming the server and the consent's reason; the Agent is still created, and the next
 * activation reviews the start again. When the consent accepts that server's start (`mcp-client/consent-accepted`),
 * each live Session left without tools by a refusal runs the same consent check once more and, when it passes, gets the
 * server's tools; a Session the check still refuses stays without them and starts nothing.
 * An output folder that overlaps a folder the chat's sandbox can write, or that cannot be checked, does the same with a
 * warning that holds the plain reason ({@link OutputFolderRefusedError}); no server starts with a folder that failed the check.
 * Every other startup failure fails the Agent's creation.
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
          // The call's logged arguments stay as the model sent them; the server gets the replacement.
          const replacements = new WeakMap<object, Record<string, unknown>>()
          const notes = new WeakMap<object, string>()
          // The registry rebuilds a wrapper's result from the tool body's own output, so the note joins the content
          // the model sees at the post-execute step.
          scope.ctx.on('tools/post-execute', async (exec, result, next) => {
            const decision = await next()
            const note = exec.agent === agent ? notes.get(exec) : undefined
            if (note === undefined || decision.kind !== 'accept' || decision.content !== undefined) return decision
            return {
              kind: 'accept',
              content: [...result.content, { type: 'text', text: note }],
              ...decision.additionalContexts === undefined ? {} : { additionalContexts: decision.additionalContexts },
            }
          })
          scope.ctx.on('mcp-client/call-arguments', (serverName, _args, exec) =>
            serverName === options.name && exec.agent === agent ? replacements.get(exec) : undefined)
          const outputDirectory = options.outputRoot === undefined ? undefined : await sessionOutputDirectory(options.outputRoot, agent.id)
          if (outputDirectory !== undefined) await assertOutsideWritableFolders(ctx, agent, outputDirectory, sessionDirectory)
          scope.ctx.on('tools/execute', async (exec, next) => {
            if (!exec.name.startsWith(toolPrefix)) return next()
            if (exec.agent !== agent) {
              if (ctx.tools.get(exec.name, exec.agent) !== ctx.tools.get(exec.name, agent)) return next()
              throw new Error(`${options.name}: browser tool belongs to another Session`)
            }
            const call: BrowserToolCall = {
              tool: exec.name.slice(toolPrefix.length), arguments: exec.arguments, directory: sessionDirectory,
              ...outputDirectory === undefined ? {} : { outputDirectory },
            }
            const refusal = await options.refuseCall?.(call)
            if (refusal !== undefined) return failure(refusal)
            const prepared = await options.prepareCall?.(call)
            if (typeof prepared === 'string') return failure(prepared)
            if (prepared !== undefined) replacements.set(exec, { ...exec.arguments as Record<string, unknown>, ...prepared.arguments })
            if (typeof prepared === 'object' && prepared.note !== undefined) notes.set(exec, prepared.note)
            if (options.checkResult === undefined) return next()
            const startedAt = Date.now()
            let result: ToolExecutionResult | undefined
            let thrown: unknown
            try {
              result = await next()
            } catch (error) {
              thrown = error
            }
            const refused = await options.checkResult(call, startedAt)
            if (refused !== undefined) return failure(refused)
            if (result === undefined) throw thrown
            return result
          })
          await scope.ctx.plugin(McpClient, McpClient.Config({
            transport: 'stdio',
            serverName: options.name,
            command: options.command,
            args: options.args,
            ...options.env === undefined && outputDirectory === undefined
              ? {}
              : { env: { ...options.env, ...outputDirectory === undefined ? {} : { PLAYWRIGHT_MCP_OUTPUT_DIR: outputDirectory } } },
            cwd: options.directory === undefined ? sessionDirectory : await fixedDirectory(options.directory),
            roots: [sessionDirectory],
            ...options.deniedTools === undefined ? {} : { deniedTools: options.deniedTools },
            ...options.toolCallTimeoutMs === undefined ? {} : { toolCallTimeoutMs: options.toolCallTimeoutMs },
            failOnStartupError: true,
            reconnect: { enabled: false },
          }))
          if (options.outputFolder !== undefined && outputDirectory === undefined) {
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
  /**
   * Get the server for a Session; a consent refusal leaves the Session `refused`, running without the server's tools.
   * @returns whether the server started; false after a consent refusal, any other failure is rethrown.
   */
  const getOrRefuse = async (agent: Agent, state: ClientState, signal?: AbortSignal): Promise<boolean> => {
    try {
      await resources.get(agent, signal)
    } catch (error) {
      if (!isConsentStop(error)) throw error
      // The consent keeps the server stopped and lists it for the person's answer; this Session runs without its tools.
      ctx.logger.warn(`${options.name}: the browser tools are off in Session ${agent.id}${error instanceof OutputFolderRefusedError ? '' : " until the server's start is allowed"}: ${error.message}`)
      state.status = 'refused'
      return false
    }
    return true
  }
  /** Start the server for an admitted Session that holds no client; a consent refusal leaves it `refused`. */
  const start = async (agent: Agent, state: ClientState, signal?: AbortSignal): Promise<void> => {
    if (!resources.available(agent)) {
      state.status = 'blocked'
      refreshBlockedMasks()
      return
    }
    if (!await getOrRefuse(agent, state, signal)) {
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
    const state: ClientState = {
      status: unadmitted ? 'unadmitted' : resources.available(agent) ? 'ready' : 'blocked',
      signal: signal ?? new AbortController().signal,
    }
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
    if (!await getOrRefuse(agent, state, signal)) {
      clients.set(agent, state)
      refreshBlockedMasks()
      return
    }
    clients.set(agent, state)
  }, { prepend: true })
  ctx.on('tools/change', refreshBlockedMasks)
  /** Start the server again in a `refused` Session the person's acceptance may now allow; the consent decides again. */
  const retryRefused = async (agent: Agent, state: ClientState): Promise<void> => {
    if (stopping || clients.get(agent) !== state || state.status !== 'refused' || state.signal?.aborted !== false) return
    if (options.admission !== undefined && !options.admission.admitted(agent)) return
    // The mask denies the server's tools in this Session; it comes off first, because the new registration names them.
    const mask = state.mask
    delete state.mask
    try {
      await mask?.dispose()
    } catch (error) {
      // The accept already took effect; a Session whose mask would not come off stays as it was.
      if (mask !== undefined) state.mask = mask
      ctx.logger.warn(`${options.name}: the browser tools stay off in Session ${agent.id}: ${(error as Error).message}`)
      return
    }
    state.changing = true
    try {
      await start(agent, state, state.signal)
    } catch (error) {
      state.status = 'refused'
      ctx.logger.warn(`${options.name}: the browser tools could not start in Session ${agent.id} after the server was allowed: ${(error as Error).message}`)
    } finally {
      state.changing = false
      refreshBlockedMasks()
    }
  }
  ctx.on('mcp-client/consent-accepted', async (serverName) => {
    if (stopping || serverName !== options.name) return
    const transitions: Promise<void>[] = []
    for (const [agent, state] of [...clients]) {
      if (state.status !== 'refused') continue
      const previous = state.transition ?? Promise.resolve()
      state.transition = previous.then(() => retryRefused(agent, state))
      transitions.push(state.transition)
    }
    await Promise.all(transitions)
  })
  ctx.on('tools/execute', async (exec, next) => {
    const ownResource = resourceTools.has(exec.name)
      && typeof exec.arguments === 'object' && exec.arguments !== null
      && (exec.arguments as { server?: unknown }).server === options.name
    if (!exec.name.startsWith(toolPrefix) && !ownResource) return next()
    const agent = exec.agent
    const status = agent === undefined ? undefined : clients.get(agent)?.status
    // Asked at call time too: a call can run between the provider's change and the stop of the Session's server.
    const admitted = agent === undefined || options.admission === undefined || options.admission.admitted(agent)
    if (status === 'unadmitted' || !admitted) throw new Error(`${options.name}: this Session may not use this browser`)
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
