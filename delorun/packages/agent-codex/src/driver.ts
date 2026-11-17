/**
 * The Codex driver: opens a thread in a fresh `codex app-server --stdio` process started through the gate's spawn,
 * and runs limits checks. Threads ask under approval policy `untrusted` and write only inside the workspace (L31, T7),
 * are never ephemeral, and use the stable protocol only.
 *
 * The workspace-write sandbox is set on each `turn/start`, over a read-only thread: a thread started with sandbox
 * `workspace-write` makes Codex add `trust_level = "trusted"` for the folder to the person's own `config.toml`, which a
 * turn's sandbox policy does not.
 *
 * The model rule (L33, EA22): a model the person picked is passed on `thread/start` and `thread/resume`. Without one,
 * the model the thread reports must be one `model/list` offers; otherwise the open fails `model-not-offered` before any
 * turn, with the configured name and the offered list. The driver never picks a model for the person.
 * @module @delorun/agent-codex/driver
 */
import type {
  AccountObservation, ExternalAgentDriver, OfferedModel, ProgramFailure, ProgramOpenRequest, ProgramProbeRequest,
  ProgramSpawn,
} from './contract.ts'
import { ProgramFailureError } from './contract.ts'
import { observationOf, offeredModels } from './mapping.ts'
import { TESTED_CODEX_VERSION, type ClientResult } from './protocol.ts'
import { CodexRpc, CodexRpcError, type WireTap } from './rpc.ts'
import { CodexSession } from './session.ts'

/** The pinned Codex program the driver starts. */
export interface CodexProgram {
  /** The `@openai/codex` package's `bin.codex` script, run with this Node. */
  readonly entry: string
  /** The package's version, which must equal {@link TESTED_CODEX_VERSION}. */
  readonly version: string
}

/** The driver's settings, from its row's validated configuration. */
export interface CodexDriverOptions {
  /** Finds the pinned program in upstream's Codex pack. */
  readonly locate: () => CodexProgram
  /** How long one request may wait for Codex's answer, in milliseconds; a fresh `thread/start` can take 30 s. */
  readonly requestTimeoutMs: number
  /** How long the process may take to exit after its input ends before it is terminated, in milliseconds. */
  readonly closeWaitMs: number
  /** Sees every frame, for live diagnostics only. */
  readonly tap?: WireTap
}

/** The most `model/list` pages one listing follows, so a server that never stops paging cannot hold an open. */
const MAX_MODEL_PAGES = 10

/** The client name Codex records for threads the driver starts. */
const CLIENT_INFO = { name: 'delorun', title: 'Delorun', version: '0.1.0' }

/**
 * Thread settings every seat thread uses: Codex asks before any command it does not know to be safe (L31, T7). The
 * thread's own sandbox is read-only; each turn widens it to the workspace ({@link CodexSession}).
 */
const THREAD_POLICY = { approvalPolicy: 'untrusted', sandbox: 'read-only' } as const

/**
 * The argv for the pinned app-server.
 * @param program - the located program.
 * @returns Node, the package's bin script and the app-server arguments.
 */
export function appServerArgv(program: CodexProgram): string[] {
  return [process.execPath, program.entry, 'app-server', '--stdio']
}

/** The Codex driver. */
export class CodexDriver implements ExternalAgentDriver {
  readonly provider = 'codex'
  private readonly options: CodexDriverOptions

  /** @param options - the locator, timeouts and an optional wire tap. */
  constructor(options: CodexDriverOptions) {
    this.options = options
  }

  async open(request: ProgramOpenRequest): Promise<CodexSession> {
    request.signal.throwIfAborted()
    const session = this.connect(request.spawn, request.onApproval, request.onLimits)
    const close = (): void => { void session.session.close() }
    request.signal.addEventListener('abort', close, { once: true })
    try {
      const rpc = session.rpc
      await this.handshake(rpc, request.signal)
      const account = await rpc.request('account/read', { refreshToken: false }, this.timeout(request.signal))
      if (account.account === null && account.requiresOpenaiAuth) throw new ProgramFailureError({ category: 'signed-out' })
      const thread = {
        cwd: request.cwd,
        ...THREAD_POLICY,
        ...request.model === undefined ? {} : { model: request.model },
      }
      let opened: ClientResult<'thread/start'>
      if (request.resume === undefined) {
        opened = await rpc.request('thread/start', { ...thread, ephemeral: false }, this.timeout(request.signal))
      } else {
        try {
          opened = await rpc.request('thread/resume', { ...thread, threadId: request.resume }, this.timeout(request.signal))
        } catch (error: unknown) {
          if (error instanceof CodexRpcError) throw new ProgramFailureError({ category: 'resume-failed' }, { cause: error })
          throw error
        }
      }
      const offered = await this.listModels(rpc, request.signal)
      if (request.model === undefined && !offered.some(model => model.id === opened.model)) {
        throw new ProgramFailureError({ category: 'model-not-offered', configured: opened.model, offered })
      }
      request.onLimits({ ...observationOf({ account, source: 'run' }), offeredModels: offered })
      session.session.attach(opened.thread.id, request.cwd)
      return session.session
    } catch (error: unknown) {
      await session.session.close()
      throw asFailure(error, 'open')
    } finally {
      request.signal.removeEventListener('abort', close)
    }
  }

  async probe(request: ProgramProbeRequest): Promise<AccountObservation> {
    request.signal.throwIfAborted()
    const session = this.connect(request.spawn, () => Promise.resolve('reject'), () => {})
    const close = (): void => { void session.session.close() }
    request.signal.addEventListener('abort', close, { once: true })
    try {
      const rpc = session.rpc
      await this.handshake(rpc, request.signal)
      const account = await rpc.request('account/read', { refreshToken: false }, this.timeout(request.signal))
      if (account.account === null) return observationOf({ account, source: 'probe' })
      let snapshot: ClientResult<'account/rateLimits/read'>['rateLimits'] | undefined
      try {
        snapshot = (await rpc.request('account/rateLimits/read', {}, this.timeout(request.signal))).rateLimits
      } catch (error: unknown) {
        // An API-key sign-in has no plan limits; Codex answers with an error, and the check reports no windows.
        if (!(error instanceof CodexRpcError)) throw error
      }
      const offered = await this.listModels(rpc, request.signal)
      return observationOf({ account, ...snapshot === undefined ? {} : { snapshot }, offered, source: 'probe' })
    } catch (error: unknown) {
      throw asFailure(error, 'probe')
    } finally {
      request.signal.removeEventListener('abort', close)
      await session.session.close()
    }
  }

  /** Locate the program, refuse an untested version, and start the app-server through the gate. */
  private connect(spawn: ProgramSpawn, onApproval: ProgramOpenRequest['onApproval'], onLimits: ProgramOpenRequest['onLimits']): { readonly rpc: CodexRpc; readonly session: CodexSession } {
    const program = this.options.locate()
    if (program.version !== TESTED_CODEX_VERSION) {
      throw new ProgramFailureError({ category: 'program', detail: `Codex ${program.version} is not a version Delorun has tested; Delorun runs Codex ${TESTED_CODEX_VERSION}.` })
    }
    const handle = spawn({ argv: appServerArgv(program), stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' } })
    if (handle.stdin === undefined || handle.stdout === undefined) {
      handle.terminate()
      throw new ProgramFailureError({ category: 'program', detail: 'The Codex app-server started without its input and output pipes.' })
    }
    const { tap } = this.options
    if (handle.stderr !== undefined) {
      // Codex's diagnostics go to the tap only; unread, the pipe would fill and stall the program.
      handle.stderr.setEncoding('utf8')
      handle.stderr.on('data', (chunk: string) => { tap?.('!', chunk) })
    }
    const rpc = new CodexRpc(handle.stdout, handle.stdin, tap)
    const session = new CodexSession({ handle, rpc, onApproval, onLimits, requestTimeoutMs: this.options.requestTimeoutMs, closeWaitMs: this.options.closeWaitMs })
    return { rpc, session }
  }

  private async handshake(rpc: CodexRpc, signal: AbortSignal): Promise<void> {
    await rpc.request('initialize', { clientInfo: CLIENT_INFO, capabilities: { experimentalApi: false, requestAttestation: false } }, this.timeout(signal))
    rpc.notify('initialized')
  }

  private async listModels(rpc: CodexRpc, signal: AbortSignal): Promise<OfferedModel[]> {
    const data: ClientResult<'model/list'>['data'] = []
    let cursor: string | null | undefined
    for (let page = 0; page < MAX_MODEL_PAGES; page += 1) {
      const result = await rpc.request('model/list', cursor === undefined || cursor === null ? {} : { cursor }, this.timeout(signal))
      data.push(...result.data)
      cursor = result.nextCursor
      if (cursor === undefined || cursor === null) break
    }
    return offeredModels(data)
  }

  private timeout(signal: AbortSignal): AbortSignal {
    return AbortSignal.any([signal, AbortSignal.timeout(this.options.requestTimeoutMs)])
  }
}

/**
 * Any open or probe failure as a {@link ProgramFailureError}: a typed failure passes through; anything else becomes a
 * `program` failure whose detail is for the person's view only.
 */
function asFailure(error: unknown, stage: 'open' | 'probe'): ProgramFailureError {
  if (error instanceof ProgramFailureError) return error
  const detail = error instanceof Error && error.name === 'TimeoutError'
    ? `Codex did not answer in time during the ${stage}.`
    : `Codex could not ${stage === 'open' ? 'start' : 'be checked'}: ${error instanceof Error ? error.message : 'no reason was given'}`
  const failure: ProgramFailure = { category: 'program', detail }
  return new ProgramFailureError(failure, { cause: error })
}
