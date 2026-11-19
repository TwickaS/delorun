/**
 * An in-memory stand-in for one `codex app-server --stdio` process: a subprocess handle over two pass-through streams,
 * scripted answers to the driver's requests, and helpers to send recorded notifications and server requests. Starts
 * no process, so the specs that use it stay in the unit lane.
 * @module @delorun/agent-codex/tests/fake-app-server
 */
import { PassThrough } from 'node:stream'
import { createInterface } from 'node:readline'
import type { SubprocessHandle, SubprocessOutcome } from '@deepseek-ai/dsh-subprocess'

/** A JSON object frame. */
export type Frame = Record<string, unknown>

/** Answers one request: a result, or an error object. */
export type Answer = { readonly result: unknown } | { readonly error: { readonly code: number; readonly message: string } }

/** The fake process. */
export class FakeAppServer {
  readonly stdin = new PassThrough()
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  /** Every frame the driver wrote, in order. */
  readonly received: Frame[] = []
  /** Answers by method; a method with no answer is left waiting. */
  readonly answers = new Map<string, (params: Frame) => Answer | undefined>()
  /** Whether the driver asked the subprocess owner to terminate the process. */
  terminated = false
  /** Whether the process has exited. */
  exited = false
  /** Exit when stdin ends, as Codex does; set false to model a process that ignores it. */
  exitOnStdinEnd = true
  private readonly exit = Promise.withResolvers<SubprocessOutcome>()
  private readonly waiters: { readonly match: (frame: Frame) => boolean; readonly done: PromiseWithResolvers<Frame> }[] = []

  constructor() {
    createInterface({ input: this.stdin }).on('line', (line) => { this.receive(JSON.parse(line) as Frame) })
    this.stdin.on('finish', () => { if (this.exitOnStdinEnd) this.end({ exitCode: 0, signal: null }) })
  }

  /** The subprocess handle the gate's spawn would return. */
  readonly handle: SubprocessHandle = {
    stdin: this.stdin,
    stdout: this.stdout,
    stderr: this.stderr,
    control: undefined,
    collected: {},
    done: this.exit.promise,
    terminate: () => {
      this.terminated = true
      this.end({ exitCode: null, signal: 'SIGTERM' })
    },
    waitForExit: async () => {
      await this.exit.promise
      return true
    },
  }

  /**
   * End the process with an outcome; its output closes.
   * @param outcome - the exit facts.
   */
  end(outcome: SubprocessOutcome): void {
    if (this.exited) return
    this.exited = true
    this.stdout.end()
    this.stderr.end()
    this.exit.resolve(outcome)
  }

  /**
   * Answer every request of one method.
   * @param method - the method.
   * @param answer - the result, or a function of the request's params.
   */
  answer(method: string, answer: Answer | ((params: Frame) => Answer | undefined)): void {
    this.answers.set(method, typeof answer === 'function' ? answer : () => answer)
  }

  /**
   * Send one frame on stdout.
   * @param frame - the frame.
   */
  send(frame: Frame): void {
    this.stdout.write(`${JSON.stringify(frame)}\n`)
  }

  /**
   * Send a notification.
   * @param method - the method.
   * @param params - its parameters.
   */
  notify(method: string, params: Frame): void {
    this.send({ method, params })
  }

  /**
   * Send a server request and wait for the driver's answer.
   * @param id - the request id.
   * @param method - the method.
   * @param params - its parameters.
   * @returns the answer frame.
   */
  ask(id: number, method: string, params: Frame): Promise<Frame> {
    const answered = this.waitFor(frame => frame.id === id && frame.method === undefined)
    this.send({ id, method, params })
    return answered
  }

  /**
   * Wait for a frame from the driver.
   * @param match - which frame.
   * @returns the first matching frame, including one already received.
   */
  waitFor(match: (frame: Frame) => boolean): Promise<Frame> {
    const seen = this.received.find(match)
    if (seen !== undefined) return Promise.resolve(seen)
    const done = Promise.withResolvers<Frame>()
    this.waiters.push({ match, done })
    return done.promise
  }

  /**
   * The requests of one method the driver sent.
   * @param method - the method.
   * @returns their params, in order.
   */
  requests(method: string): Frame[] {
    return this.received.filter(frame => frame.method === method).map(frame => frame.params as Frame)
  }

  private receive(frame: Frame): void {
    this.received.push(frame)
    for (const waiter of [...this.waiters]) {
      if (!waiter.match(frame)) continue
      this.waiters.splice(this.waiters.indexOf(waiter), 1)
      waiter.done.resolve(frame)
    }
    if (typeof frame.method !== 'string' || frame.id === undefined) return
    const answer = this.answers.get(frame.method)?.(frame.params as Frame)
    if (answer !== undefined) this.send({ id: frame.id, ...answer })
  }
}

/**
 * Let queued stream and promise callbacks run.
 * @returns after a macrotask turn.
 */
export function settle(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve))
}
