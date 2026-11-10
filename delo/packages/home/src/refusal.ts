/**
 * The one report format of Delo's command-line programs, `delorun` and its npm launcher: what Delo did, why, and what
 * the person can do. A typed error class reads as a {@link Refusal} through a {@link RefusalDescriber} its own package
 * exports; a program composes the describers of the packages it depends on, so this module imports none of them.
 *
 * @module @delo/home/refusal
 */
import { HomeLayoutError } from './errors.ts'

/** A failure as a person reads it. */
export interface Refusal {
  /** What Delo did or did not do, as one or two sentences. */
  readonly lead: string
  /** Why, naming the error's code and the path, value or detail it concerns; absent when the lead says it all. */
  readonly reason?: string
  /** What the person can do, in order; empty when Delo offers nothing. */
  readonly remedies: readonly string[]
}

/** What a describer may name in a remedy. */
export interface RefusalContext {
  /** The CLI profile the program ran for, when the person or the program named one; a remedy's command repeats it. */
  readonly profile?: string
}

/** A typed error class, as a describer names it. */
export type ErrorClass<E extends Error> = abstract new (...args: never[]) => E

/** How one typed error class reads as a {@link Refusal}. */
export interface RefusalDescriber<E extends Error = Error> {
  /** The class it describes; an instance of a subclass matches too. */
  readonly type: ErrorClass<E>
  /**
   * The refusal for one error.
   * @param error - the error.
   * @param context - what a remedy may name.
   * @returns the refusal.
   */
  describe(error: E, context: RefusalContext): Refusal
}

/**
 * A describer, with the error type inferred from the class.
 * @param type - the class it describes.
 * @param describe - the refusal for one error of the class.
 * @returns the describer.
 */
export function refusalDescriber<E extends Error>(type: ErrorClass<E>, describe: (error: E, context: RefusalContext) => Refusal): RefusalDescriber<E> {
  return { type, describe }
}

/**
 * The ` --profile <name>` a remedy's command carries, or nothing when the context names no profile.
 * @param context - what a remedy may name.
 * @returns the option with its leading space, or the empty string.
 */
export function profileOption(context: RefusalContext): string {
  return context.profile === undefined ? '' : ` --profile ${context.profile}`
}

/**
 * The refusal for any value a program caught. The first describer whose class the value is an instance of describes
 * it, so a subclass's describer comes before its base class's. Any other value reads as `Delo stopped: <message>`,
 * with no stack and no remedy.
 * @param error - the value thrown.
 * @param describers - the describers the program composes.
 * @param context - what a remedy may name.
 * @returns the refusal.
 */
export function describeFailure(error: unknown, describers: readonly RefusalDescriber[], context: RefusalContext = {}): Refusal {
  for (const describer of describers) {
    if (error instanceof describer.type) return describer.describe(error, context)
  }
  return { lead: `Delo stopped: ${error instanceof Error ? error.message : String(error)}`, remedies: [] }
}

/**
 * A refusal as standard error shows it: the lead, then `Why: <reason>`, then `What you can do:` with one indented line
 * per remedy. Every line ends with a newline.
 * @param refusal - the refusal.
 * @returns the text.
 */
export function renderRefusal(refusal: Refusal): string {
  const lines = [refusal.lead]
  if (refusal.reason !== undefined) lines.push(`Why: ${refusal.reason}`)
  if (refusal.remedies.length > 0) lines.push('What you can do:', ...refusal.remedies.map(remedy => `  ${remedy}`))
  return lines.map(line => `${line}\n`).join('')
}

/**
 * The reason line of a coded error: its code, then its detail.
 * @param code - the error's code.
 * @param detail - what is wrong, when the error carries more than its code.
 * @returns the reason.
 */
export function codedReason(code: string, detail: string | undefined): string {
  return detail === undefined ? code : `${code}: ${detail}`
}

/** How a {@link HomeLayoutError} reads: Delo stopped before using the path, C1's code and detail, and the fix when one exists. */
export const homeLayoutDescriber: RefusalDescriber<HomeLayoutError> = refusalDescriber(HomeLayoutError, error => ({
  lead: `Delo stopped before using ${error.path}.`,
  reason: codedReason(error.code, error.detail),
  remedies: error.fix === undefined ? [] : [`Fix it with: ${error.fix}`],
}))
