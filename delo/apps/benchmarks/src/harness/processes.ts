/**
 * Child processes with timed output: each line of standard output and standard error carries the wall-clock time it
 * reached the harness, so a suite reads phase boundaries from what the product prints without changing it. Every
 * child runs in its own process group with a deadline; on the deadline, or when the harness ends it, the whole group
 * is killed.
 *
 * @module @delo/benchmarks/harness/processes
 */
import { spawn, type ChildProcess } from 'node:child_process'

/** One line a child printed. */
export interface TimedLine {
  /** Milliseconds since the epoch when the harness read it. */
  readonly at: number
  /** The stream. */
  readonly stream: 'stdout' | 'stderr'
  /** The text, without its line end. */
  readonly text: string
}

/** A finished child. */
export interface Finished {
  /** The exit code, or `null` when a signal ended it. */
  readonly code: number | null
  /** The signal that ended it, or `null`. */
  readonly signal: NodeJS.Signals | null
  /** When it was spawned, in epoch milliseconds. */
  readonly startedAt: number
  /** When its first byte of output arrived, or `undefined` when it printed nothing. */
  readonly firstOutputAt: number | undefined
  /** When it exited. */
  readonly endedAt: number
  /** Every line it printed, in arrival order. */
  readonly lines: readonly TimedLine[]
  /** Whether the deadline killed it. */
  readonly timedOut: boolean
}

/** What to start. */
export interface ProcessRequest {
  /** The executable. */
  readonly command: string
  /** Its arguments. */
  readonly args: readonly string[]
  /** Its whole environment. */
  readonly env: NodeJS.ProcessEnv
  /** Its working directory. */
  readonly cwd: string
  /** The longest it may run, in milliseconds. */
  readonly timeoutMs: number
  /** Text written to its standard input, which is then closed; standard input is closed at once without it. */
  readonly input?: string
  /** Extra descriptors passed through, as `spawn`'s `stdio` from index 3. */
  readonly extraStdio?: readonly ('pipe' | 'ignore')[]
  /** Told of each line as it arrives. */
  readonly onLine?: (line: TimedLine) => void
}

/** A started child. */
export interface Running {
  /** The child. */
  readonly child: ChildProcess
  /** Settles when it exits. */
  readonly finished: Promise<Finished>
  /** Kill its whole process group. */
  kill(signal?: NodeJS.Signals): void
}

/**
 * Split a stream's chunks into lines and time each one.
 * @param stream - the stream's name.
 * @param emit - receives each line.
 * @returns the chunk handler and a flush for the last partial line.
 */
function lineSplitter(stream: TimedLine['stream'], emit: (line: TimedLine) => void): { readonly push: (chunk: Buffer) => void, readonly flush: () => void } {
  let pending = ''
  return {
    push(chunk) {
      const at = Date.now()
      pending += chunk.toString('utf8')
      for (let end = pending.indexOf('\n'); end !== -1; end = pending.indexOf('\n')) {
        emit({ at, stream, text: pending.slice(0, end).replace(/\r$/u, '') })
        pending = pending.slice(end + 1)
      }
    },
    flush() {
      if (pending !== '') emit({ at: Date.now(), stream, text: pending })
      pending = ''
    },
  }
}

/**
 * Start a child in its own process group.
 * @param request - the command, environment, deadline and listeners.
 * @returns the running child.
 */
export function start(request: ProcessRequest): Running {
  const startedAt = Date.now()
  const child = spawn(request.command, [...request.args], {
    cwd: request.cwd,
    env: request.env,
    detached: true,
    stdio: ['pipe', 'pipe', 'pipe', ...request.extraStdio ?? []],
  })
  const lines: TimedLine[] = []
  let firstOutputAt: number | undefined
  let timedOut = false
  const emit = (line: TimedLine): void => {
    lines.push(line)
    request.onLine?.(line)
  }
  const out = lineSplitter('stdout', emit)
  const err = lineSplitter('stderr', emit)
  const first = (): void => { firstOutputAt ??= Date.now() }
  child.stdout?.on('data', (chunk: Buffer) => { first(); out.push(chunk) })
  child.stderr?.on('data', (chunk: Buffer) => { first(); err.push(chunk) })
  if (request.input !== undefined) child.stdin?.end(request.input)
  else child.stdin?.end()
  const kill = (signal: NodeJS.Signals = 'SIGKILL'): void => {
    if (child.pid === undefined || child.exitCode !== null) return
    try {
      process.kill(-child.pid, signal)
    } catch (_gone) {
      // ESRCH: the group has already exited.
    }
  }
  const timer = setTimeout(() => { timedOut = true; kill() }, request.timeoutMs)
  const finished = new Promise<Finished>((resolve, reject) => {
    child.once('error', (error) => { clearTimeout(timer); reject(error) })
    child.once('close', (code, signal) => {
      clearTimeout(timer)
      out.flush()
      err.flush()
      resolve({ code, signal, startedAt, firstOutputAt, endedAt: Date.now(), lines, timedOut })
    })
  })
  return { child, finished, kill }
}

/**
 * Run a child to its end.
 * @param request - the command, environment, deadline and listeners.
 * @returns how it finished.
 */
export async function run(request: ProcessRequest): Promise<Finished> {
  return start(request).finished
}

/**
 * The output of a finished child as text, for an error message.
 * @param finished - the child.
 * @param limit - the most lines kept, from the end.
 * @returns the lines joined.
 */
export function outputTail(finished: Pick<Finished, 'lines'>, limit = 40): string {
  return finished.lines.slice(-limit).map(line => line.text).join('\n')
}

/**
 * Throw unless a child exited 0.
 * @param finished - the child.
 * @param what - what it was, for the message.
 * @returns the child.
 * @throws {Error} naming the exit and the end of its output.
 */
export function expectSuccess(finished: Finished, what: string): Finished {
  if (finished.code === 0) return finished
  const ending = finished.timedOut ? 'ran past its deadline' : finished.signal === null ? `exited ${String(finished.code)}` : `ended by ${finished.signal}`
  throw new Error(`${what} ${ending}:\n${outputTail(finished)}`)
}

/**
 * The first line that matches, with its time.
 * @param lines - the lines.
 * @param pattern - the pattern.
 * @returns the line, or `undefined`.
 */
export function firstMatch(lines: readonly TimedLine[], pattern: RegExp): TimedLine | undefined {
  return lines.find(line => pattern.test(line.text))
}
