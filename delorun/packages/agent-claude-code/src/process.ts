/**
 * The Claude Code program process: the SDK's spawn request turned into one call of the gate's spawn, the program
 * placed under Delorun's watcher on POSIX, and the gate's handle shown to the SDK as the process it expects.
 * @module @delorun/agent-claude-code/process
 */
import { EventEmitter } from 'node:events'
import { fileURLToPath } from 'node:url'
import type { SpawnedProcess, SpawnOptions } from '@anthropic-ai/claude-agent-sdk'
import { scrubbedParentEnv, type SubprocessHandle } from '@deepseek-ai/dsh-subprocess'
import type { ProgramSpawn, ProgramSpawnRequest } from './pending-contract.ts'

/**
 * The watcher script's path. It is plain JavaScript, so Node runs it without a loader wherever the package is installed.
 * @returns the absolute path of `watcher.mjs`.
 */
export function watcherPath(): string {
  return fileURLToPath(import.meta.resolve('@delorun/agent-claude-code/watcher'))
}

/**
 * The program's argv, placed under the watcher on POSIX. On Windows the subprocess owner's kill-on-close Job already
 * ends the program's tree with the Host, so the program starts directly.
 * @param argv - the program's own argv from the SDK.
 * @param platform - the operating system.
 * @param watcher - the watcher script's path.
 * @returns the argv to spawn.
 */
export function watchedArgv(argv: readonly string[], platform: NodeJS.Platform, watcher: string): string[] {
  return platform === 'win32' ? [...argv] : [process.execPath, watcher, ...argv]
}

/**
 * The SDK's complete child environment as an overlay on the subprocess owner's scrubbed base: the SDK's values, and a
 * tombstone for each base name the SDK removed.
 * @param env - the environment the SDK composed for the program.
 * @param base - the scrubbed base environment the subprocess owner starts from.
 * @returns the overlay.
 */
export function environmentOverlay(env: SpawnOptions['env'], base: NodeJS.ProcessEnv = scrubbedParentEnv()): NodeJS.ProcessEnv {
  const overlay: NodeJS.ProcessEnv = { ...env }
  for (const name of Object.keys(base)) if (!(name in env)) overlay[name] = undefined
  return overlay
}

/**
 * The spawn request for one SDK spawn. The SDK's own abort signal and folder are not passed: the gate owns the process's
 * life and its folder.
 * @param options - the SDK's spawn request.
 * @param platform - the operating system.
 * @param watcher - the watcher script's path.
 * @returns the request for the gate's spawn.
 */
export function programSpawnRequest(options: SpawnOptions, platform: NodeJS.Platform, watcher: string): ProgramSpawnRequest {
  return {
    argv: watchedArgv([options.command, ...options.args], platform, watcher),
    env: environmentOverlay(options.env),
    stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'ignore' },
  }
}

type ExitListener = (code: number | null, signal: NodeJS.Signals | null) => void
type ErrorListener = (error: Error) => void

/** The gate's process handle as the SDK's `SpawnedProcess`: streams and exit pass through, and `kill` asks the gate to end the process. */
export class GateProcess implements SpawnedProcess {
  /** The program's standard input. */
  readonly stdin: NonNullable<SubprocessHandle['stdin']>
  /** The program's standard output. */
  readonly stdout: NonNullable<SubprocessHandle['stdout']>
  readonly #handle: SubprocessHandle
  readonly #events = new EventEmitter()
  #exit: { readonly code: number | null; readonly signal: NodeJS.Signals | null } | undefined
  #killed = false

  /**
   * @param handle - the gate's handle, spawned with piped standard input and output.
   */
  constructor(handle: SubprocessHandle) {
    const { stdin, stdout } = handle
    if (stdin === undefined || stdout === undefined) throw new Error('agent-claude-code: the program was spawned without piped standard input and output')
    this.stdin = stdin
    this.stdout = stdout
    this.#handle = handle
    // EventEmitter throws an `error` without a listener; the SDK adds its own right after spawn returns.
    this.#events.on('error', () => {})
    void handle.done.then(
      (outcome) => {
        this.#exit = { code: outcome.exitCode, signal: outcome.signal }
        this.#events.emit('exit', outcome.exitCode, outcome.signal)
      },
      (error: unknown) => { this.#events.emit('error', error instanceof Error ? error : new Error(String(error))) },
    )
  }

  /** Whether the SDK asked for the process to end. */
  get killed(): boolean { return this.#killed }
  /** The exit code, or null while running or after a signal. */
  get exitCode(): number | null { return this.#exit?.code ?? null }
  /** The ending signal, if any. */
  get signalCode(): NodeJS.Signals | null { return this.#exit?.signal ?? null }

  /**
   * Ask the gate's handle to end the process; the subprocess owner chooses the signals.
   * @param _signal - the SDK's signal, not used.
   * @returns false after exit or an earlier request.
   */
  kill(_signal: NodeJS.Signals): boolean {
    if (this.#killed || this.#exit !== undefined) return false
    this.#killed = true
    this.#handle.terminate()
    return true
  }

  /**
   * Add a lasting listener.
   * @param event - `exit` or `error`.
   * @param listener - the listener.
   */
  on(event: 'exit' | 'error', listener: ExitListener | ErrorListener): void { this.#events.on(event, listener) }
  /**
   * Add a one-time listener.
   * @param event - `exit` or `error`.
   * @param listener - the listener.
   */
  once(event: 'exit' | 'error', listener: ExitListener | ErrorListener): void { this.#events.once(event, listener) }
  /**
   * Remove a listener.
   * @param event - `exit` or `error`.
   * @param listener - the listener.
   */
  off(event: 'exit' | 'error', listener: ExitListener | ErrorListener): void { this.#events.off(event, listener) }
}

/**
 * The SDK's `spawnClaudeCodeProcess` over the gate's spawn.
 * @param spawn - the gate's spawn.
 * @param platform - the operating system.
 * @param watcher - the watcher script's path, resolved lazily so Windows never needs it.
 * @returns the SDK option.
 */
export function spawnThroughGate(spawn: ProgramSpawn, platform: NodeJS.Platform = process.platform, watcher: () => string = watcherPath): (options: SpawnOptions) => SpawnedProcess {
  return options => new GateProcess(spawn(programSpawnRequest(options, platform, platform === 'win32' ? '' : watcher())))
}
