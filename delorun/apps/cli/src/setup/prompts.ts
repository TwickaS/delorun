/**
 * The terminal prompts of `delorun setup`, behind one interface so the answers
 * flow can run against a scripted prompter in tests. The production prompter
 * is `@clack/prompts`: it draws the questions, masks the key, draws a long list
 * of choices as one to search, and lets the person cancel, which is the only
 * prompt behaviour setup relies on.
 *
 * @module @delorun/cli/setup/prompts
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
   * @param allowEmpty - whether an empty entry is accepted and returned as `''`; the step runner uses it for "go back".
   * @returns the entered text; empty only when `allowEmpty` is true.
   * @throws {SetupCancelled} when the person cancels.
   */
  secret(message: string, allowEmpty?: boolean): Promise<string>
  /**
   * Ask for a line of text.
   * @param message - the question.
   * @param initial - the text offered at first, returned when the person presses Enter on it.
   * @param validate - a check of the entry; it returns the message to show, or `undefined` when the entry is accepted.
   * @param allowEmpty - whether an empty entry is accepted, skipping `validate`; the step runner uses it for "go back".
   * @returns the entered text.
   * @throws {SetupCancelled} when the person cancels.
   */
  text(message: string, initial: string, validate: (value: string) => string | undefined, allowEmpty?: boolean): Promise<string>
  /**
   * Show text that needs no answer.
   * @param body - the text.
   * @param title - a heading for the text.
   */
  note(body: string, title: string): void
}

/** A select with more choices than this, such as a provider's model list, is drawn as a list the person can search. */
const SEARCH_ABOVE = 15

/** The choices a searchable list shows at once. */
const SEARCH_ROWS = 12

/** Thrown when the person cancels a prompt; setup then writes nothing further. */
export class SetupCancelled extends Error {
  /**
   * @param saved - what an earlier run or step already wrote and still stands; `undefined` when nothing was saved.
   */
  constructor(saved?: string) {
    super(`Setup cancelled. ${saved ?? 'Nothing was saved.'} Run delorun to ${saved === undefined ? 'start again' : 'finish setting up'}.`)
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
      if (choices.length > SEARCH_ABOVE) {
        return unwrap(await clack.autocomplete({ message, initialValue: initial, options: choices as ClackOption<T>[], maxItems: SEARCH_ROWS, placeholder: 'Type to search' }))
      }
      return unwrap(await clack.select({ message, initialValue: initial, options: choices as ClackOption<T>[] }))
    },
    async confirm(message, initial) {
      return unwrap(await clack.confirm({ message, initialValue: initial }))
    },
    async secret(message, allowEmpty = false) {
      return unwrap(await clack.password({ message, validate: value => (!allowEmpty && (value ?? '').trim() === '' ? 'Enter a key.' : undefined) }))
    },
    async text(message, initial, validate, allowEmpty = false) {
      return unwrap(await clack.text({
        message,
        initialValue: initial,
        validate: (value) => {
          const entry = (value ?? '').trim()
          return allowEmpty && entry === '' ? undefined : validate(entry)
        },
      }))
    },
    note(body, title) {
      clack.note(body, title)
    },
  }
}
