/**
 * The clone step of a workspace import: git clones one repository into an
 * empty directory through the subprocess provider. The clone reports git's
 * progress lines as they arrive and keeps git's latest `fatal:` and `error:`
 * lines for the reason. It deletes nothing; the caller removes the directory
 * when the clone fails. {@link resolveClone} builds the spawn without I/O, and
 * the clone reads its environment only from {@link CloneOptions.env}.
 * @module @delo/plugin-workspaces/clone
 */
import type { Readable } from 'node:stream'
import type { SubprocessHandle, SubprocessOutcome, SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { cloneEnvironment, cloneUrlProblem, GIT_ENV, GIT_OPTIONS, redactClone, tokenGit, tokenProblem } from './git.ts'
import type { GitInvocation } from './git.ts'

/** The longest text kept from one line of git's output, in characters. */
const MAX_LINE_CHARS = 300

/** How many of git's latest `fatal:` and `error:` lines the reason keeps. */
const MAX_ERROR_LINES = 5

/** The longest line the reader assembles. A longer line is dropped whole, because a cut could leave part of a token unredacted. */
const MAX_ASSEMBLED_CHARS = 4096

/** How long git's error output may stay open after git exits, in milliseconds. */
const DRAIN_GRACE_MS = 5000

/** Bytes of git's standard output kept; a clone writes nothing there. */
const STDOUT_TAIL_BYTES = 4096

/** A line break in git's output: CRLF, a bare CR (which git's progress uses to rewrite a line), or LF. */
const LINE_END = /\r\n|\r|\n/

/** The control characters a line loses: C0 except tab, DEL, and the C1 range. */
const CONTROL_CHARACTERS = /[\x00-\x08\x0a-\x1f\x7f-\x9f]/g

/** A line git reports as a failure. */
const ERROR_LINE = /^(?:fatal|error):/

/** What {@link cloneRepository} clones and how. */
export interface CloneOptions {
  /** The subprocess provider that runs git. */
  readonly subprocess: SubprocessRuntime
  /**
   * The parent environment whose names the clone removes from git's environment: the repository pointers, configuration,
   * certificate and transport overrides, proxies, traces and askpass programs that {@link cloneEnvironment} lists. The clone
   * reads no other environment, so the caller passes the environment its subprocess provider inherits from; a name left out
   * reaches git.
   */
  readonly env: Readonly<Record<string, string | undefined>>
  /** The `https` clone URL, without a user name, password, query or fragment. */
  readonly url: string
  /** The absolute path of an empty directory; git clones into it, and the caller removes it when the clone fails. */
  readonly directory: string
  /**
   * The token for {@link url}, which reaches only git's credential helper. Undefined clones without a credential: no clone reads
   * the system or the person's global git configuration, so a private repository needs the token.
   */
  readonly token?: string | undefined
  /** An absolute path to a PEM file. It replaces git's default certificate authorities for this clone (`http.sslCAInfo`), so it must hold every authority the clone trusts. */
  readonly extraCaFile?: string | undefined
  /**
   * The proxy git uses for this clone, as `http.proxy` takes it, such as `http://proxy.example:3128`. Undefined uses no proxy: the
   * clone reads no proxy from git configuration or from the environment.
   */
  readonly proxy?: string | undefined
  /** The clone's time limit in milliseconds; git is stopped when it passes. */
  readonly timeoutMs: number
  /** Cancels the clone, which stops git. */
  readonly signal?: AbortSignal | undefined
  /** Receives a message about a condition that does not fail the clone. */
  readonly warn: (message: string) => void
  /** Receives each git progress line, with its control characters and credentials removed and cut to 300 characters. */
  readonly onProgress?: ((line: string) => void) | undefined
}

/**
 * The outcome of {@link cloneRepository}: `ok`, or a failure whose reason holds
 * no token.
 */
export type CloneResult = { readonly ok: true } | { readonly ok: false, readonly reason: string }

/** The command {@link cloneRepository} spawns for a clone that is not refused. */
export interface CloneSpawn {
  /** git's argument list, starting with `git`. */
  readonly argv: readonly string[]
  /** The spawn's working directory, the clone's empty directory. */
  readonly cwd: string
  /** The entries merged onto the subprocess provider's scrubbed base; an undefined entry removes its name from git's environment. */
  readonly env: Readonly<Record<string, string | undefined>>
  /** The provider's grace period in milliseconds, for termination and for draining a pipe that stays open after git exits. */
  readonly graceMs: number
}

/**
 * The resolution of a clone: the command {@link cloneRepository} spawns, or a
 * refusal in the failure shape of {@link CloneResult}.
 */
export type CloneSpec = ({ readonly ok: true } & CloneSpawn) | { readonly ok: false, readonly reason: string }

/**
 * Resolve a clone into its spawn: the refusals of {@link cloneUrlProblem} and
 * {@link tokenProblem}, git's arguments with the credential helper when a token
 * is given, and the child's environment entries. It does no I/O and reads no
 * process state, so its result depends on `options` alone.
 * @param options - the clone's inputs.
 * @returns the spawn, or a refusal whose reason holds no token.
 */
export function resolveClone(options: CloneOptions): CloneSpec {
  const refusal = cloneUrlProblem(options.url) ?? (options.token === undefined ? undefined : tokenProblem(options.token))
  if (refusal !== undefined) return { ok: false, reason: refusal }
  const invocation: GitInvocation = options.token === undefined ? { options: GIT_OPTIONS, env: GIT_ENV } : tokenGit(options.url, options.token)
  const caOptions = options.extraCaFile === undefined ? [] : ['-c', `http.sslCAInfo=${options.extraCaFile}`]
  const proxyOptions = options.proxy === undefined ? [] : ['-c', `http.proxy=${options.proxy}`]
  return {
    ok: true,
    argv: ['git', ...invocation.options, ...caOptions, ...proxyOptions, 'clone', '--progress', '--', options.url, '.'],
    cwd: options.directory,
    env: { ...cloneEnvironment(options.env), ...invocation.env },
    graceMs: DRAIN_GRACE_MS,
  }
}

/**
 * Clone {@link CloneOptions.url} into {@link CloneOptions.directory}: the
 * command {@link resolveClone} resolves, spawned through the subprocess
 * provider. A refused URL or token is reported before any process starts.
 * @param options - the clone's inputs.
 * @returns `{ ok: true }` when git exits 0; otherwise a reason that states what stopped git and then holds git's latest error lines.
 */
export async function cloneRepository(options: CloneOptions): Promise<CloneResult> {
  const spec = resolveClone(options)
  if (!spec.ok) return spec
  const { token } = options
  const secrets = token === undefined ? [] : [token, encodeURIComponent(token)]
  const redact = (text: string): string => redactClone(text, secrets)
  const output = new CloneOutput(redact, options.onProgress, options.warn)
  const timeout = AbortSignal.timeout(options.timeoutMs)
  const signal = options.signal === undefined ? timeout : AbortSignal.any([timeout, options.signal])
  let handle: SubprocessHandle
  try {
    handle = options.subprocess.spawn({
      argv: spec.argv,
      cwd: spec.cwd,
      stdio: { stdin: 'ignore', stdout: { maxBytes: STDOUT_TAIL_BYTES }, stderr: 'pipe' },
      graceMs: spec.graceMs,
      signal,
      env: spec.env,
    })
  } catch (error) {
    return failure([`git could not run: ${redact(messageOf(error))}`])
  }
  // A missing error pipe is a provider defect, so attach throws and the caller's import records it.
  const stderrEnded = output.attach(handle.stderr)
  let outcome: SubprocessOutcome
  try {
    outcome = await handle.done
  } catch (error) {
    return failure([`git could not run: ${redact(messageOf(error))}`])
  }
  // Read the causes of the stop now: the wait for the error output below can run past the time limit.
  const timedOut = timeout.aborted
  const cancelled = options.signal?.aborted === true
  if (!(await endedWithin(stderrEnded, DRAIN_GRACE_MS))) {
    options.warn('git clone: the error output stayed open after git exited, so the reason may be incomplete')
  }
  output.end()
  if (outcome.exitCode === 0) return { ok: true }
  const facts: string[] = []
  if (timedOut) facts.push(`the clone did not finish within ${options.timeoutMs} ms`)
  if (cancelled) facts.push('the clone was cancelled')
  facts.push(outcome.exitCode === null ? `git was stopped by ${outcome.signal ?? 'a signal'}` : `git exited with code ${outcome.exitCode}`)
  return failure(facts, output.errors())
}

/**
 * A failed result: the facts about the stop, then git's error lines.
 * @param facts - what stopped or failed the clone, in words.
 * @param lines - git's error lines, latest last.
 * @returns the failed result with its reason.
 */
function failure(facts: readonly string[], lines: readonly string[] = []): CloneResult {
  return { ok: false, reason: [facts.join('; '), ...lines].join('\n') }
}

/**
 * The message of a thrown value.
 * @param error - the value a catch clause received.
 * @returns the error's message, or the value as a string when it is not an Error.
 */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Wait for a stream to end, up to a grace period.
 * @param ended - settles when the stream ends.
 * @param graceMs - the period in milliseconds.
 * @returns true when the stream ended first, false when the period ran out.
 */
function endedWithin(ended: Promise<void>, graceMs: number): Promise<boolean> {
  const deadline = AbortSignal.timeout(graceMs)
  return new Promise<boolean>((resolve) => {
    void ended.then(() => { resolve(true) })
    deadline.addEventListener('abort', () => { resolve(false) }, { once: true })
  })
}

/**
 * git's error stream as it arrives: each progress line goes to `onProgress`,
 * and the latest `fatal:` and `error:` lines are kept for the reason. Every
 * line loses its control characters and is redacted before any use, and is cut
 * afterwards, so a token that straddles a cut never shows.
 */
class CloneOutput {
  readonly #redact: (text: string) => string
  readonly #onProgress: ((line: string) => void) | undefined
  readonly #warn: (message: string) => void
  readonly #errors: string[] = []
  #pending = ''
  #dropping = false
  #closed = false

  /**
   * @param redact - removes the token from a text.
   * @param onProgress - receives each progress line.
   * @param warn - receives a message about a progress callback that threw.
   */
  constructor(redact: (text: string) => string, onProgress: ((line: string) => void) | undefined, warn: (message: string) => void) {
    this.#redact = redact
    this.#onProgress = onProgress
    this.#warn = warn
  }

  /**
   * Read the stream from now on.
   * @param stream - the error stream the spawn returned for `stderr: 'pipe'`.
   * @returns a promise that settles when the stream ends, closes or fails; a failure is reported as a warning.
   * @throws Error when the provider returned no stream for the pipe the spawn asked for.
   */
  attach(stream: Readable | undefined): Promise<void> {
    if (stream === undefined) throw new Error('the subprocess provider returned no stderr pipe for a spawn that asked for one')
    stream.setEncoding('utf8')
    stream.on('data', (chunk: string) => { this.#push(chunk) })
    return new Promise<void>((resolve) => {
      stream.once('end', () => { resolve() })
      stream.once('close', () => { resolve() })
      stream.once('error', (error: Error) => {
        this.#warn(`git clone: reading its error output failed: ${this.#redact(error.message)}`)
        resolve()
      })
    })
  }

  /**
   * Report the partial last line and ignore any later output.
   */
  end(): void {
    this.#finish()
    this.#closed = true
  }

  /**
   * @returns the latest error lines, oldest first.
   */
  errors(): readonly string[] {
    return this.#errors
  }

  #push(chunk: string): void {
    if (this.#closed) return
    const parts = chunk.split(LINE_END)
    const last = parts.pop() ?? ''
    for (const part of parts) {
      this.#add(part)
      this.#finish()
    }
    this.#add(last)
  }

  #add(text: string): void {
    if (this.#dropping) return
    this.#pending += text
    if (this.#pending.length > MAX_ASSEMBLED_CHARS) {
      this.#pending = ''
      this.#dropping = true
    }
  }

  #finish(): void {
    const dropped = this.#dropping
    const line = this.#pending
    this.#pending = ''
    this.#dropping = false
    if (!dropped) this.#line(line)
  }

  #line(raw: string): void {
    const line = this.#redact(raw.replace(CONTROL_CHARACTERS, '')).trim()
    if (line === '') return
    if (ERROR_LINE.test(line)) {
      this.#errors.push(line.slice(0, MAX_LINE_CHARS))
      if (this.#errors.length > MAX_ERROR_LINES) this.#errors.shift()
      return
    }
    if (this.#onProgress === undefined) return
    try {
      this.#onProgress(line.slice(0, MAX_LINE_CHARS))
    } catch (error) {
      this.#warn(`git clone: the progress callback threw, so its line was not reported: ${this.#redact(messageOf(error))}`)
    }
  }
}
