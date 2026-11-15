/**
 * The handover between a home process and its successor on a new runtime (contract C19, "The update handshake",
 * steps `switching` to `committed`). The predecessor starts the successor with a pipe inherited as file descriptor 3
 * and writes one handover line to it; the successor boots its Host in `standby`, checks its health and answers
 * `ready` or `failed`. On `ready` the predecessor hands the lock over and writes `commit`; the successor then takes
 * the update channel. Nothing of the handover passes through a command line or an environment variable, and no
 * token passes at all: the successor writes its own.
 *
 * @module @delorun/home-process/handover
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { Socket } from 'node:net'
import type { Duplex } from 'node:stream'
import { brandString } from '@deepseek-ai/dsh-brand'
import { DELORUN_START_CHECK_ENV, inheritableEnvironment, RUNTIME_VERSION_PATTERN, type RuntimeVersion, type StartId } from '@delorun/contract-home-layout'
import { HANDOVER_FD, type HandoverMessage } from '@delorun/contract-home-process'
import { z } from 'zod'
import type { HealthExpectations, HomeCommand } from './seams.ts'

/** What the predecessor tells its successor, in the first line on the pipe. */
export interface HandoverLine {
  /** The line's kind. */
  readonly type: 'handover'
  /** Record version. */
  readonly v: 1
  /** The resolved Delorun home. */
  readonly home: string
  /** The CLI profile. */
  readonly profile: string
  /** The version the predecessor runs. */
  readonly from: RuntimeVersion
  /** The version the successor runs. */
  readonly to: RuntimeVersion
  /** The start id the predecessor assigned to the successor, which the lock carries after the handover. */
  readonly startId: StartId
  /** What C3's health check holds the successor to. */
  readonly health: HealthExpectations
  /** RFC 3339 UTC time the update started, for the journal. */
  readonly startedAt: string
}

/** The largest line on the handover pipe, in bytes. */
export const HANDOVER_LINE_MAX_BYTES = 65_536

const version = z.string().regex(new RegExp(RUNTIME_VERSION_PATTERN))
/**
 * A row of the previous release's Host, as the handover carries it for the successor's health check. The handover's
 * objects drop fields this release does not know, so a predecessor may add an optional field a successor can do
 * without, as contract C19's "Compatibility" allows; a field a successor must understand raises `v`.
 */
const bootRow = z.object({ id: z.string(), name: z.string(), generated: z.boolean(), configHash: z.string().regex(/^[0-9a-f]{64}$/u).optional() })
const handoverSchema = z.object({
  type: z.literal('handover'),
  v: z.literal(1),
  home: z.string().min(1),
  profile: z.string().min(1),
  from: version,
  to: version,
  startId: z.string().regex(/^[0-9a-f]{32}$/),
  health: z.object({
    disabledPlugins: z.array(z.string()),
    namedRows: z.array(z.string()),
    bundleRows: z.array(z.string()).optional(),
    bundles: z.array(z.string()).optional(),
    previousFailures: z.array(bootRow),
    previousRows: z.array(bootRow),
    previousProtection: z.object({
      protectedHome: z.string(),
      protectedHomeReadable: z.array(z.string()),
      deniedSockets: z.array(z.string()),
      escapeSocketDirectories: z.array(z.string()),
      privateTmp: z.boolean(),
    }).optional(),
  }),
  startedAt: z.string().datetime(),
})
const messageSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('ready') }),
  z.strictObject({ type: z.literal('failed'), reason: z.literal('HEALTH_CHECK_FAILED'), criterion: z.string().regex(/^H[1-5]-[a-z-]{1,40}$/u).optional() }),
])

/**
 * Read newline-separated lines from a stream and hand each to a listener; a line over the limit or the stream's end
 * calls `end`.
 * @param stream - the pipe.
 * @param line - receives each line.
 * @param end - called once, when the stream ends, fails or carries a line over {@link HANDOVER_LINE_MAX_BYTES}.
 */
function readLines(stream: Duplex, line: (text: string) => void, end: () => void): void {
  let buffered = ''
  let ended = false
  const finish = (): void => {
    if (ended) return
    ended = true
    end()
  }
  stream.setEncoding('utf8')
  stream.on('data', (chunk: string) => {
    if (ended) return
    buffered += chunk
    for (let newline = buffered.indexOf('\n'); newline !== -1 && !ended; newline = buffered.indexOf('\n')) {
      const text = buffered.slice(0, newline)
      buffered = buffered.slice(newline + 1)
      line(text)
    }
    if (Buffer.byteLength(buffered, 'utf8') > HANDOVER_LINE_MAX_BYTES) finish()
  })
  stream.once('end', finish)
  stream.once('close', finish)
  stream.once('error', finish)
}

/**
 * Parse one JSON line, or `undefined` when it is not JSON.
 * @param text - the line.
 * @returns the value.
 */
function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch (_notJson) {
    // Not JSON: the caller treats the line as a broken handover.
    return undefined
  }
}

/** A successor the predecessor started. */
export interface Successor {
  /** Its process id. */
  readonly pid: number
  /** Its first message, or `failed` when it exits, closes the pipe or does not answer before the deadline. */
  readonly result: Promise<HandoverMessage>
  /**
   * Tell the successor that the lock is now its own, then let it run on after this process exits.
   * @returns when the line is written.
   */
  commit(): Promise<void>
  /**
   * Stop the successor with every process of its process group, such as the composed tree's `delorun` a signed
   * successor handed off to, and wait for the successor to exit.
   * @returns when it has exited.
   */
  stop(): Promise<void>
}

/**
 * The environment a successor starts with: this process's, without the variables that load code into a Node or its
 * dynamic loader (`DROPPED_LAUNCH_ENV`), which this process may have taken from a `.env` file after the launcher dropped
 * them from its own start, and without `DELORUN_START_CHECK`, which describes this process's start, not the successor's.
 * @param inherited - this process's environment.
 * @returns the successor's environment.
 */
export function successorEnvironment(inherited: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const environment = inheritableEnvironment(inherited)
  delete environment[DELORUN_START_CHECK_ENV]
  return environment
}

/**
 * Kill a successor's process group: on POSIX `SIGKILL` to the group the successor leads; on Windows, which has no
 * process groups, `taskkill /T /F` over the successor's process tree, then the successor itself.
 * @param child - the successor.
 */
function killGroup(child: ChildProcess): void {
  const pid = child.pid
  if (pid === undefined) return
  /* v8 ignore next 5 -- Windows only; no spec runs on Windows. */
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/T', '/F', '/PID', String(pid)], { stdio: 'ignore', windowsHide: true })
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    return
  }
  try {
    process.kill(-pid, 'SIGKILL')
  } catch (_gone) {
    // ESRCH: no process of the group is left, so nothing of the successor's runs.
  }
}

/**
 * Start a successor from a version's runtime and write the handover line to its pipe, with
 * {@link successorEnvironment}. It leads its own process group, so a signal to the requester's terminal does not
 * reach it, and stopping it stops the group.
 * @param command - the command from the runtime store.
 * @param handover - the handover line.
 * @param timeoutMs - how long the successor has to answer.
 * @returns the successor.
 */
export function startSuccessor(command: HomeCommand, handover: HandoverLine, timeoutMs: number): Successor {
  const child: ChildProcess = spawn(command.command, [...command.args], { cwd: command.cwd, env: successorEnvironment(process.env), stdio: ['ignore', 'ignore', 'ignore', 'pipe'], detached: true })
  const pipe = child.stdio[HANDOVER_FD] as Duplex
  const exited = new Promise<void>((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) resolve()
    else child.once('exit', () => { resolve() })
    // A process that could not be started reports `error` before `spawn` and never exits.
    const notStarted = (): void => { resolve() }
    child.once('error', notStarted)
    child.once('spawn', () => { child.off('error', notStarted) })
  })
  const result = new Promise<HandoverMessage>((resolve) => {
    let settled = false
    const settle = (message: HandoverMessage): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(message)
    }
    const failed = (): void => { settle({ type: 'failed', reason: 'HEALTH_CHECK_FAILED' }) }
    const timer = setTimeout(failed, timeoutMs)
    child.once('error', failed)
    child.once('exit', failed)
    readLines(pipe, (text) => {
      const parsed = messageSchema.safeParse(parseJson(text))
      settle(parsed.success ? parsed.data : { type: 'failed', reason: 'HEALTH_CHECK_FAILED' })
    }, failed)
  })
  pipe.on('error', () => {
    // EPIPE when the successor has exited; `result` reports it as failed.
  })
  pipe.write(`${JSON.stringify(handover)}\n`)
  return {
    pid: child.pid ?? -1,
    result,
    commit: () => new Promise<void>((resolve) => {
      pipe.end(`${JSON.stringify({ type: 'commit' })}\n`, () => {
        child.unref()
        resolve()
      })
    }),
    async stop() {
      killGroup(child)
      await exited
      pipe.destroy()
    },
  }
}

/** The successor's end of the handover. */
export interface HandoverPipe {
  /** The handover line. */
  readonly handover: HandoverLine
  /**
   * Answer the predecessor.
   * @param message - `ready` or `failed`.
   */
  send(message: HandoverMessage): void
  /** Resolves true on `commit`, false when the pipe closes or carries anything else first. */
  readonly committed: Promise<boolean>
  /** Close the pipe. */
  close(): void
}

/**
 * Read the handover line a successor receives: `v` 1, with every field this release knows checked and every field it
 * does not know dropped.
 * @param text - the line, without its newline.
 * @returns the handover.
 * @throws {Error} naming the first field that is not valid, a `v` other than 1 included; the message never quotes the line.
 */
export function parseHandoverLine(text: string): HandoverLine {
  const parsed = handoverSchema.safeParse(parseJson(text))
  if (!parsed.success) throw new Error(`the handover line is not valid at ${parsed.error.issues[0]?.path.join('.') ?? 'its root'}`)
  // The schema checked the versions' and start id's form; the brands are the contracts' own types.
  const data = parsed.data
  const { bundles, bundleRows, previousProtection, ...health } = data.health
  return {
    ...data, from: brandString<RuntimeVersion>(data.from), to: brandString<RuntimeVersion>(data.to), startId: brandString<StartId>(data.startId),
    health: { ...health, ...bundles === undefined ? {} : { bundles }, ...bundleRows === undefined ? {} : { bundleRows }, ...previousProtection === undefined ? {} : { previousProtection } },
  }
}

/**
 * Open the successor's end of the handover pipe and read the handover line. The pipe's end is watched from before the
 * first await, so a predecessor that dies while the successor starts is seen.
 * @param fd - the inherited descriptor, {@link HANDOVER_FD}.
 * @returns the pipe.
 * @throws {Error} when the pipe ends first or its first line is not a handover line; the message never quotes it.
 */
export function openHandoverPipe(fd: number = HANDOVER_FD): Promise<HandoverPipe> {
  const pipe = new Socket({ fd, readable: true, writable: true })
  return new Promise((resolve, reject) => {
    let handover: HandoverLine | undefined
    let commit: ((value: boolean) => void) | undefined
    const committed = new Promise<boolean>((resolveCommit) => { commit = resolveCommit })
    readLines(pipe, (text) => {
      if (handover === undefined) {
        let line: HandoverLine
        try {
          line = parseHandoverLine(text)
        } catch (error) {
          pipe.destroy()
          reject(error as Error)
          return
        }
        handover = line
        resolve({
          handover: line,
          send: (message) => { pipe.write(`${JSON.stringify(message)}\n`) },
          committed,
          close: () => { pipe.destroy() },
        })
        return
      }
      const value = parseJson(text)
      commit?.(typeof value === 'object' && value !== null && (value as { readonly type?: unknown }).type === 'commit')
    }, () => {
      commit?.(false)
      if (handover === undefined) reject(new Error('the handover pipe closed before the handover line'))
    })
    pipe.on('error', () => {
      // A predecessor that died: `readLines` sees the close and the successor stops waiting.
    })
  })
}
