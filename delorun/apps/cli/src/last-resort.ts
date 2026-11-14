/**
 * The last-resort report of a `delorun` process, installed by the [entry point](./bin.ts) before `main` runs: an
 * uncaught exception or an unhandled rejection, at any point of the process's life, prints as a redacted refusal with
 * `delorun`'s describers ([refusals](./refusals.ts)) in place of Node's or upstream's `inspect()` output, and the
 * process exits 1.
 *
 * The handler is upstream's `installFailLoud`, registered first and through a process adapter whose diagnostic stream
 * is this report: it keeps upstream's treatment of the activation rejections its boot already reported and its single
 * report per process. The `inspect()` diagnostic upstream composes, with the failure's stack, own properties and
 * causes, goes to the home process's `home-<profile>` log when this process opened one, and nowhere else: a plain
 * command, `delorun headless` and `delorun plugin` keep no log.
 *
 * Without a registered teardown ({@link registerFatalRelease}) the exit is synchronous, inside the listener, so a
 * handler registered later, such as the one upstream's profile runner installs when its `failLoud` option is not
 * `false`, never runs: it would print its own `inspect()` report and run its own teardown. A process that boots a Host
 * passes `failLoud: false` and registers the Host's teardown here instead; the exit then waits for the teardown, at
 * most upstream's `FAIL_LOUD_RELEASE_TIMEOUT_MS`.
 *
 * @module @delorun/cli/last-resort
 */
import { FAIL_LOUD_RELEASE_TIMEOUT_MS, installFailLoud, type FailLoudEvent, type FailLoudProcess } from '@deepseek-ai/dsh-app-boot'
import { claimFatalHandler, recordFatal, renderFatal, type FatalEvent, type FatalProcess, type FatalRecord } from '@delorun/home'
import { openedHomeLog } from '@delorun/home-process'
import { CLI_DESCRIBERS, PATTERN_REDACTOR, refusalContext } from './refusals.ts'

/** The diagnostic prefix upstream's handler composes its record line with. */
const NAME = 'delorun'

/**
 * The last remedy of a fatal report from a process that keeps no log: a plain command, `delorun headless` and
 * `delorun plugin`, and a home process that failed before it opened its log.
 */
export const NO_LOG_POINTER = 'delorun keeps no log of this command, so this report is all it recorded; run the same command again, and report this if it repeats.'

/**
 * Record a fatal failure of a `delorun` process: in the home process, an `error` record in its `home-<profile>` log
 * with upstream's diagnostic and the failure's message and stack, each redacted by the log; any other process keeps no
 * log.
 * @param error - the thrown value or the rejection's reason.
 * @param event - which event reported it.
 * @param diagnostic - upstream's `inspect()` line for the failure.
 * @returns where the detail is, with the home log's redactor when it took the detail.
 */
export function recordCliFatal(error: unknown, event: FatalEvent, diagnostic: string): FatalRecord {
  const opened = openedHomeLog()
  if (opened === undefined) return { pointer: NO_LOG_POINTER }
  const what = event === 'uncaughtException' ? 'an uncaught exception' : 'an unhandled rejection'
  opened.homeLog.logger.error(`${what} stopped the home process: ${diagnostic.trimEnd()}`, { err: error })
  return { pointer: `See the full detail in the home process's log: delorun logs home --profile ${opened.profile}`, redactor: opened.homeLog.redactor }
}

/** The teardown the fatal exit waits for, under upstream's bound; at most one at a time. */
let release: (() => Promise<void>) | undefined

/**
 * Register the teardown the last-resort handler awaits before its exit, at most `FAIL_LOUD_RELEASE_TIMEOUT_MS`: the
 * current Host of a process that boots one with upstream's `failLoud: false`, which a fatal exit disposes first.
 * @param teardown - the teardown.
 * @returns the disposer that unregisters it.
 * @throws {Error} when another teardown is registered.
 */
export function registerFatalRelease(teardown: () => Promise<void>): () => void {
  if (release !== undefined) throw new Error('a teardown for the fatal exit is already registered')
  release = teardown
  return () => {
    if (release === teardown) release = undefined
  }
}

/** What {@link installCliLastResort} reports through; the real process's by default. */
export interface CliFatalIo {
  /** The process whose events it reports. */
  readonly process: FatalProcess
  /** Writes to standard error. */
  readonly stderr: (text: string) => void
  /** Ends the process. */
  readonly exit: (code: number) => void
}

/**
 * End the process: at once without a registered teardown, otherwise once the teardown settled or overran
 * `FAIL_LOUD_RELEASE_TIMEOUT_MS`, whose timer stays referenced so the process cannot end with 0 while it waits.
 * @param exit - ends the process.
 * @param code - the exit code.
 */
function exitAfterTeardown(exit: (code: number) => void, code: number): void {
  const teardown = release
  if (teardown === undefined) {
    exit(code)
    return
  }
  let timer!: ReturnType<typeof setTimeout>
  const bound = new Promise<void>((resolve) => { timer = setTimeout(resolve, FAIL_LOUD_RELEASE_TIMEOUT_MS) })
  void Promise.race([(async () => teardown())(), bound])
    .catch((_teardownFailure: unknown) => {
      // The teardown failed; the fatal exit below is the outcome, and the report already named the failure.
    })
    .then(() => {
      clearTimeout(timer)
      exit(code)
    })
}

/** The real process's events, standard error and exit. */
const PROCESS_IO: CliFatalIo = {
  process,
  stderr: text => void process.stderr.write(text),
  exit: code => process.exit(code),
}

/**
 * Install the last-resort handler of a `delorun` process, once.
 * @param argv - the arguments after the script, for the profile a remedy names.
 * @param io - the process, standard error and the exit.
 * @returns the uninstaller.
 * @throws {Error} when a last-resort handler is already installed on the process.
 */
export function installCliLastResort(argv: readonly string[], io: CliFatalIo = PROCESS_IO): () => void {
  const unclaim = claimFatalHandler(io.process)
  const options = { describers: CLI_DESCRIBERS, context: refusalContext(argv), redactor: PATTERN_REDACTOR }
  // The failure upstream's handler is reporting: set around each call of it, which writes its diagnostic synchronously.
  let failing: { readonly error: unknown, readonly event: FatalEvent } | undefined
  const listeners: Array<{ readonly event: FailLoudEvent, readonly handler: (error: unknown) => void, readonly listener: (error: unknown) => void }> = []
  const adapter: FailLoudProcess = {
    on(event, handler) {
      const listener = (error: unknown): void => {
        failing = { error, event }
        try {
          handler(error)
        } finally {
          failing = undefined
        }
      }
      listeners.push({ event, handler, listener })
      io.process.on(event, listener)
    },
    off(event, handler) {
      for (const entry of listeners) {
        if (entry.event === event && entry.handler === handler) io.process.off(event, entry.listener)
      }
    },
    stderr: {
      write(diagnostic: string) {
        // Upstream writes only from inside the handler call that set `failing`, once it decided the failure is fatal.
        const { error, event } = failing!
        const text = renderFatal(error, recordFatal((value, kind) => recordCliFatal(value, kind, diagnostic), error, event), options)
        try {
          io.stderr(text)
        } catch (_closedStderr) {
          // Standard error is gone, so nothing can show the report; upstream's exit still ends the process.
        }
      },
    },
    exit: (code) => { exitAfterTeardown(io.exit, code) },
  }
  // No release here: upstream then calls the adapter's exit inside the listener, which ends the process at once unless
  // a teardown is registered.
  const uninstall = installFailLoud(NAME, adapter)
  return () => {
    uninstall()
    unclaim()
  }
}
