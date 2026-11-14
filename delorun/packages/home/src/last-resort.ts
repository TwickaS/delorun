/**
 * The last-resort report of a Delorun command-line program. An uncaught exception or an unhandled rejection that reaches
 * the process at any point of its life, after the program's own `main` returned included, prints as a {@link Refusal}
 * in the one report format, redacted, and the process exits with {@link FATAL_EXIT}. The program records the failure's
 * full detail, its stack included, in the log it keeps open, and the refusal's last remedy says where the detail is or
 * that no log holds it; the stack never reaches standard error.
 *
 * A process carries one last-resort handler ({@link claimFatalHandler}), installed before anything else registers for
 * these events, so it runs first and its exit ends the process before a handler registered later prints a report of
 * its own. {@link installLastResort} is the handler of a program that boots no upstream profile; `delorun` reports
 * through upstream's `installFailLoud` instead, with {@link renderFatal}, so it keeps that handler's release and its
 * treatment of the activation rejections upstream's boot already reported.
 *
 * @module @delorun/home/last-resort
 */
import { describeFailure, renderRefusal, type Refusal, type RefusalContext, type RefusalDescriber, type TextRedactor } from './refusal.ts'

/** The exit code of a process a last-resort handler ends. */
export const FATAL_EXIT = 1

/** The process events a last-resort handler reports. */
export type FatalEvent = 'uncaughtException' | 'unhandledRejection'

/** The part of `process` a last-resort handler registers on; specs pass an emitter of their own. */
export interface FatalProcess {
  /**
   * Register a listener.
   * @param event - the event.
   * @param listener - receives the thrown value or the rejection's reason.
   */
  on(event: FatalEvent, listener: (error: unknown) => void): unknown
  /**
   * Remove a listener.
   * @param event - the event.
   * @param listener - the listener {@link FatalProcess.on} registered.
   */
  off(event: FatalEvent, listener: (error: unknown) => void): unknown
}

/** Where a program recorded a failure's full detail. */
export interface FatalRecord {
  /** The remedy that names where the full detail is, or says that no log holds it. */
  readonly pointer: string
  /** The redactor of the log the detail went to, which knows the secrets that log registered; absent when no log took it. */
  readonly redactor?: TextRedactor
}

/** What a fatal report is rendered with. */
export interface FatalReportOptions {
  /** The program's describers, the ones its `main` reports a caught failure with. */
  readonly describers: readonly RefusalDescriber[]
  /** What a remedy may name. */
  readonly context: RefusalContext
  /** The program's redactor, used when the record names none. */
  readonly redactor: TextRedactor
}

/** The remedy a report carries when recording its detail threw. */
export const UNRECORDED_POINTER = 'Delorun could not record the full detail of this failure; run the same command again, and report this if it repeats.'

/**
 * A fatal failure as standard error shows it: its refusal with the record's pointer as the last remedy, rendered
 * through the record's redactor, or the program's when the record names none.
 * @param error - the thrown value or the rejection's reason.
 * @param record - where the program recorded the full detail.
 * @param options - the describers, the context and the program's redactor.
 * @returns the redacted text, every line ending with a newline.
 */
export function renderFatal(error: unknown, record: FatalRecord, options: FatalReportOptions): string {
  const refusal: Refusal = describeFailure(error, options.describers, options.context)
  return renderRefusal({ ...refusal, remedies: [...refusal.remedies, record.pointer] }, record.redactor ?? options.redactor)
}

/**
 * Record a failure through the program's record, or say that it could not be recorded.
 * @param record - the program's record.
 * @param error - the thrown value or the rejection's reason.
 * @param event - which event reported it.
 * @returns where the detail is.
 */
export function recordFatal(record: (error: unknown, event: FatalEvent) => FatalRecord, error: unknown, event: FatalEvent): FatalRecord {
  try {
    return record(error, event)
  } catch (_unrecorded) {
    // The log could not take the detail; the refusal still prints, and its remedy says the detail is lost.
    return { pointer: UNRECORDED_POINTER }
  }
}

/** The processes that carry a last-resort handler. */
const claimed = new WeakSet<object>()

/**
 * Claim a process for its one last-resort handler.
 * @param process - the process.
 * @returns the release of the claim, for the handler's uninstaller.
 * @throws {Error} when a handler already claimed the process, which would report each failure twice.
 */
export function claimFatalHandler(process: object): () => void {
  if (claimed.has(process)) throw new Error('Delorun\'s last-resort handler is already installed on this process')
  claimed.add(process)
  return () => { claimed.delete(process) }
}

/** What {@link installLastResort} reports through. */
export interface LastResortOptions extends FatalReportOptions {
  /** The process whose events it reports. */
  readonly process: FatalProcess
  /** Writes to standard error. */
  readonly stderr: (text: string) => void
  /** Ends the process; called with {@link FATAL_EXIT} after every report, whether or not the report could be written. */
  readonly exit: (code: number) => void
  /**
   * Record the failure's full detail, its stack included, where the program keeps a log, and say where.
   * @param error - the thrown value or the rejection's reason.
   * @param event - which event reported it.
   * @returns where the detail is.
   */
  readonly record: (error: unknown, event: FatalEvent) => FatalRecord
}

/**
 * Install the last-resort handler of a program that boots no upstream profile: each event prints {@link renderFatal}'s
 * text and ends the process.
 * @param options - the process, the output, the exit, the describers, the redactor and the record.
 * @returns the uninstaller, which removes both listeners and releases the claim.
 * @throws {Error} when a handler already claimed the process.
 */
export function installLastResort(options: LastResortOptions): () => void {
  const release = claimFatalHandler(options.process)
  const report = (event: FatalEvent) => (error: unknown): void => {
    try {
      options.stderr(renderFatal(error, recordFatal(options.record, error, event), options))
    } finally {
      options.exit(FATAL_EXIT)
    }
  }
  const onException = report('uncaughtException')
  const onRejection = report('unhandledRejection')
  options.process.on('uncaughtException', onException)
  options.process.on('unhandledRejection', onRejection)
  return () => {
    options.process.off('uncaughtException', onException)
    options.process.off('unhandledRejection', onRejection)
    release()
  }
}
