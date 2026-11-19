/**
 * The Claude Code driver: opens program sessions and runs limits checks over the pinned Agent SDK, with every program
 * process started through the gate's spawn.
 * @module @delorun/agent-claude-code/driver
 */
import { randomUUID } from 'node:crypto'
import type { Options, SDKControlGetUsageResponse, SDKUserMessage, SettingSource, SpawnedProcess, SpawnOptions } from '@anthropic-ai/claude-agent-sdk'
import { scrubbedParentEnv } from '@deepseek-ai/dsh-subprocess'
import { allowedToolsFor, canUseTool } from './approvals.ts'
import { ClaudeCodeDriverError } from './errors.ts'
import { harnessToolServer } from './harness-tools.ts'
import { claudeSeatLevel, SandboxUnavailableError, type LevelMachine } from './levels.ts'
import { probeObservation } from './limits.ts'
import { ProgramOpenError, type AccountObservation, type ExternalAgentDriver, type ProgramOpenRequest, type ProgramSession, type ProgramSpawn } from '@delorun/external-agents/contract'
import { spawnThroughGate } from './process.ts'
import type { ClaudeSdk } from './sdk.ts'
import { ClaudeCodeSession } from './session.ts'

/**
 * The person's own Claude Code settings a seat loads: user, project and local, as the CLI does. At the `own` level no
 * `permissionMode` is passed, so the person's own default mode applies.
 */
const SEAT_SETTING_SOURCES: SettingSource[] = ['user', 'project', 'local']

/** The dialogs Claude Code may raise in a run nobody watches at a terminal; the driver cancels each one. */
const SUPPORTED_DIALOG_KINDS = ['refusal_fallback_prompt']

/**
 * Turn the driver's own failure to open into the contract's typed open failure, with its sentence for the person.
 * @param work - the step that may fail.
 * @returns the step's result.
 * @throws ProgramOpenError `program` for a {@link ClaudeCodeDriverError}; any other failure as it is.
 */
async function opening<T>(work: Promise<T>): Promise<T> {
  try {
    return await work
  } catch (error: unknown) {
    if (error instanceof ClaudeCodeDriverError || error instanceof SandboxUnavailableError) throw new ProgramOpenError({ category: 'program', detail: error.message }, { cause: error })
    throw error
  }
}

/** What the driver needs. */
export interface ClaudeCodeDriverOptions {
  /** Loads the SDK from upstream's Claude Code pack, refusing an untested version. */
  readonly sdk: () => Promise<ClaudeSdk>
  /** Claude Code's wait limit for one harness tool call, in milliseconds, set as `MCP_TOOL_TIMEOUT`. */
  readonly harnessToolTimeoutMs: () => number
  /** Where the command sandbox's tools are looked for; the computer's own by default. */
  readonly machine?: () => LevelMachine
  /**
   * Environment entries layered over the scrubbed base for every program process. Delorun's composition passes none;
   * the keyless real-program spec points Claude Code at a local Messages fixture with them.
   */
  readonly env?: Readonly<Record<string, string>>
  /** Turns the gate's spawn into the SDK's spawn option; defaults to the watcher on POSIX. */
  readonly spawnOption?: (spawn: ProgramSpawn) => (options: SpawnOptions) => SpawnedProcess
}

/** Opens Claude Code sessions and runs its limits checks. */
export class ClaudeCodeDriver implements ExternalAgentDriver {
  /** Upstream's provider name. */
  readonly provider = 'claude-code'
  readonly #options: ClaudeCodeDriverOptions

  /** @param options - the SDK loader, the harness tool wait limit and the environment. */
  constructor(options: ClaudeCodeDriverOptions) {
    this.#options = options
  }

  #env(extra: Readonly<Record<string, string>>): Record<string, string | undefined> {
    return { ...scrubbedParentEnv(), ...this.#options.env, ...extra }
  }

  #spawnOption(spawn: ProgramSpawn): (options: SpawnOptions) => SpawnedProcess {
    return (this.#options.spawnOption ?? spawnThroughGate)(spawn)
  }

  /**
   * Open a new program session or resume one. The program uses the person's own Claude Code settings, and the run
   * rules the person allowed earlier hold again from the first turn.
   * @param request - the seat's request.
   * @returns the live session; the program process starts with the first input.
   * @throws ProgramOpenError `program` when the SDK cannot be used or a harness tool cannot be offered.
   */
  async open(request: ProgramOpenRequest): Promise<ProgramSession> {
    request.signal.throwIfAborted()
    const sdk = await opening(this.#options.sdk())
    request.signal.throwIfAborted()
    const programSessionId = request.resume ?? randomUUID()
    const session = new ClaudeCodeSession({
      programSessionId,
      resumed: request.resume !== undefined,
      ...request.model === undefined ? {} : { model: request.model },
      onLimits: request.onLimits,
    })
    const server = await opening(Promise.resolve().then(() => harnessToolServer(sdk, request.harnessTools, session.ended)))
    const allowedTools = allowedToolsFor(request.runRules)
    const level = await opening(Promise.resolve().then(() => claudeSeatLevel(
      request.level, request.cwd, this.#options.machine?.() ?? { platform: process.platform, path: process.env['PATH'] },
    )))
    const options: Options = {
      cwd: request.cwd,
      settingSources: SEAT_SETTING_SOURCES,
      ...level.permissionMode === undefined ? {} : { permissionMode: level.permissionMode },
      ...level.permissionMode === 'bypassPermissions' ? { allowDangerouslySkipPermissions: true } : {},
      ...level.sandbox === undefined ? {} : { sandbox: level.sandbox },
      env: this.#env({ MCP_TOOL_TIMEOUT: String(this.#options.harnessToolTimeoutMs()) }),
      ...request.resume === undefined ? { sessionId: programSessionId } : { resume: request.resume },
      ...request.model === undefined ? {} : { model: request.model },
      ...allowedTools.length === 0 ? {} : { allowedTools },
      ...server === undefined ? {} : { mcpServers: { [server.name]: server.config } },
      disallowedTools: ['AskUserQuestion', ...level.disallowedTools],
      canUseTool: canUseTool(
        question => request.onApproval(question),
        { beforeAsk: () => { session.endMessage() }, onCancel: () => { session.stopping() } },
        server?.toolNames ?? new Set(),
      ),
      onElicitation: () => Promise.resolve({ action: 'decline' }),
      onUserDialog: () => Promise.resolve({ behavior: 'cancelled' }),
      supportedDialogKinds: SUPPORTED_DIALOG_KINDS,
      spawnClaudeCodeProcess: this.#spawnOption(request.spawn),
    }
    session.sandboxed = level.sandbox?.enabled === true
    session.attach(sdk.query({ prompt: session.inputStream(), options }))
    request.signal.addEventListener('abort', () => { void session.close() }, { once: true })
    return session
  }

  /**
   * Check the account and plan limits: no message, no task and none of the person's settings files. The program
   * process lives only for the check.
   * @param request - the gate's spawn, an empty folder and the check's abort signal.
   * @returns the observation, with no personal field.
   * @throws ProgramOpenError `program` when the SDK cannot be used; the signal's reason when aborted; the program's failure when it cannot report its account.
   */
  async probe(request: { readonly spawn: ProgramSpawn; readonly cwd: string; readonly signal: AbortSignal }): Promise<AccountObservation> {
    request.signal.throwIfAborted()
    const sdk = await opening(this.#options.sdk())
    const stop = new AbortController()
    const idle = (async function * (): AsyncGenerator<SDKUserMessage> {
      // A prompt that never yields keeps the program idle while it answers the control requests.
      await new Promise<void>((resolve) => { stop.signal.addEventListener('abort', () => { resolve() }, { once: true }) })
    })()
    const query = sdk.query({
      prompt: idle,
      options: {
        cwd: request.cwd,
        env: this.#env({}),
        settingSources: [],
        persistSession: false,
        canUseTool: () => Promise.resolve({ behavior: 'deny', message: 'A limits check runs no tool.' }),
        spawnClaudeCodeProcess: this.#spawnOption(request.spawn),
      },
    })
    const aborted = new Promise<never>((_resolve, reject) => {
      const onAbort = (): void => { reject(request.signal.reason) }
      if (request.signal.aborted) onAbort()
      request.signal.addEventListener('abort', onAbort, { once: true })
      stop.signal.addEventListener('abort', () => { request.signal.removeEventListener('abort', onAbort) }, { once: true })
    })
    aborted.catch(() => {})
    try {
      const account = await Promise.race([query.accountInfo(), aborted])
      let usage: SDKControlGetUsageResponse | undefined
      try {
        usage = await Promise.race([query.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true }), aborted])
      } catch (_unavailable) {
        // The usage call is experimental and may fail or be gone; the account answer still tells the sign-in state.
        request.signal.throwIfAborted()
        usage = undefined
      }
      return probeObservation(account, usage)
    } finally {
      stop.abort()
      query.close()
    }
  }
}
