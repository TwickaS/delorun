/**
 * The terminal prompts of `delorun setup`, behind one interface so the answers
 * flow can run against a scripted prompter in tests. The production prompter
 * is `@clack/prompts`: it draws the questions, masks the key and lets the
 * person cancel, which is the only prompt behaviour setup relies on.
 *
 * @module @delo/cli/setup/prompts
 */
import * as clack from '@clack/prompts'
import type { Option as ClackOption } from '@clack/prompts'

/** One choice of {@link Prompter.select}. */
export interface PromptOption<T extends string> {
  /** The value the answer carries. */
  readonly value: T
  /** The label shown for the choice. */
  readonly label: string
  /** A line shown beside the label, such as a not-enforced label. */
  readonly hint?: string | undefined
}

/** The questions setup asks. A cancelled prompt rejects with {@link SetupCancelled}. */
export interface Prompter {
  /**
   * Ask a question with fixed choices.
   * @param message - the question.
   * @param options - the choices, in display order.
   * @param initial - the choice selected at first.
   * @returns the chosen value.
   * @throws {SetupCancelled} when the person cancels.
   */
  select<T extends string>(message: string, options: readonly PromptOption<T>[], initial: T): Promise<T>
  /**
   * Ask a yes-or-no question.
   * @param message - the question.
   * @param initial - the answer selected at first.
   * @returns the answer.
   * @throws {SetupCancelled} when the person cancels.
   */
  confirm(message: string, initial: boolean): Promise<boolean>
  /**
   * Ask for a secret, shown masked.
   * @param message - the question.
   * @returns the entered text, which is never empty.
   * @throws {SetupCancelled} when the person cancels.
   */
  secret(message: string): Promise<string>
  /**
   * Show text that needs no answer.
   * @param body - the text.
   * @param title - a heading for the text.
   */
  note(body: string, title: string): void
}

/** Thrown when the person cancels a prompt; setup then writes nothing further. */
export class SetupCancelled extends Error {
  constructor() {
    super('delorun setup: cancelled')
    this.name = 'SetupCancelled'
  }
}

/**
 * The prompter a terminal uses.
 * @returns a prompter that draws each question with `@clack/prompts`.
 */
export function terminalPrompter(): Prompter {
  const unwrap = <T>(value: T | typeof clack.CANCEL_SYMBOL): T => {
    if (clack.isCancel(value)) throw new SetupCancelled()
    return value
  }
  return {
    async select<T extends string>(message: string, options: readonly PromptOption<T>[], initial: T): Promise<T> {
      // Option<T> resolves only for a concrete T, so the generic choices are passed through as clack's option type.
      const choices = options.map(option => (option.hint === undefined
        ? { value: option.value, label: option.label }
        : { value: option.value, label: option.label, hint: option.hint }))
      return unwrap(await clack.select({ message, initialValue: initial, options: choices as ClackOption<T>[] }))
    },
    async confirm(message, initial) {
      return unwrap(await clack.confirm({ message, initialValue: initial }))
    },
    async secret(message) {
      return unwrap(await clack.password({ message, validate: value => ((value ?? '').trim() === '' ? 'Enter a key.' : undefined) }))
    },
    note(body, title) {
      clack.note(body, title)
    },
  }
}
