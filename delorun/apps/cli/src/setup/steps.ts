/**
 * The step runner of the interactive setup. `@clack/prompts` has no way back, so each question is asked through
 * a {@link StepIO} that adds an explicit "← Back" choice to select and yes-or-no questions and treats an empty
 * entry as "go back" on text and key questions. A step returns {@link BACK} and the runner re-asks the nearest
 * earlier step that asks something, with the answers as they were before that step.
 *
 * @module @delorun/cli/setup/steps
 */
import type { Prompter, PromptOption } from './prompts.ts'

/** What a question returns when the person chose to go back. */
export const BACK: unique symbol = Symbol('delorun setup back')

/** The type of {@link BACK}. */
export type Back = typeof BACK

/** The value of the "← Back" choice; no answer of setup uses it. */
export const BACK_CHOICE = '← back'

/** The label of the "← Back" choice. */
export const BACK_LABEL = '← Back'

/** The hint appended to a text or key question that leaves empty for "go back". */
export const BACK_HINT = '(leave empty to go back)'

/** The questions one step may ask. */
export interface StepIO {
  /** Whether an earlier step asks a question, so "go back" is offered. */
  readonly canGoBack: boolean
  /**
   * The questions a step asks after its first one, which always offer "go back" to the step's earlier question.
   * @returns the questions, with the way back.
   */
  followUp(): StepIO
  /**
   * Ask a question with fixed choices.
   * @param message - the question.
   * @param options - the choices, in display order.
   * @param initial - the choice selected at first.
   * @returns the chosen value, or {@link BACK}.
   */
  select<T extends string>(message: string, options: readonly PromptOption<T>[], initial: T): Promise<T | Back>
  /**
   * Ask a yes-or-no question.
   * @param message - the question.
   * @param initial - the answer selected at first.
   * @returns the answer, or {@link BACK}.
   */
  confirm(message: string, initial: boolean): Promise<boolean | Back>
  /**
   * Ask for a secret.
   * @param message - the question.
   * @returns the entered text, or {@link BACK} for an empty entry when the step can go back.
   */
  secret(message: string): Promise<string | Back>
  /**
   * Ask for a line of text.
   * @param message - the question.
   * @param initial - the text offered at first.
   * @param validate - the check of an entry; it returns the message to show, or `undefined`.
   * @returns the entered text, or {@link BACK} for an empty entry when the step can go back.
   */
  text(message: string, initial: string, validate: (value: string) => string | undefined): Promise<string | Back>
  /**
   * Show text that needs no answer.
   * @param body - the text.
   * @param title - a heading for the text.
   */
  note(body: string, title: string): void
}

/**
 * The questions of a step, drawn by a prompter.
 * @param prompter - draws the questions.
 * @param canGoBack - whether the nearest earlier question exists.
 * @returns the questions with the way back added.
 */
export function stepIO(prompter: Prompter, canGoBack: boolean): StepIO {
  return {
    canGoBack,
    followUp: () => stepIO(prompter, true),
    async select<T extends string>(message: string, options: readonly PromptOption<T>[], initial: T): Promise<T | Back> {
      if (!canGoBack) return prompter.select(message, options, initial)
      const withBack: readonly PromptOption<string>[] = [...options, { value: BACK_CHOICE, label: BACK_LABEL }]
      const chosen = await prompter.select<string>(message, withBack, initial)
      // The prompter returns one of the values it was given, so a value that is not the back choice is one of `options`.
      return chosen === BACK_CHOICE ? BACK : chosen as T
    },
    async confirm(message, initial) {
      if (!canGoBack) return prompter.confirm(message, initial)
      const chosen = await prompter.select(message, [
        { value: 'yes', label: 'Yes' },
        { value: 'no', label: 'No' },
        { value: BACK_CHOICE, label: BACK_LABEL },
      ], initial ? 'yes' : 'no')
      return chosen === BACK_CHOICE ? BACK : chosen === 'yes'
    },
    async secret(message) {
      if (!canGoBack) return prompter.secret(message)
      const entered = await prompter.secret(`${message} ${BACK_HINT}`, true)
      return entered === '' ? BACK : entered
    },
    async text(message, initial, validate) {
      if (!canGoBack) return prompter.text(message, initial, validate)
      const entered = await prompter.text(`${message} ${BACK_HINT}`, initial, validate, true)
      return entered === '' ? BACK : entered
    },
    note: (body, title) => { prompter.note(body, title) },
  }
}

/** One step of {@link runSteps}. */
export interface RunStep<S> {
  /** Whether the step asks a question in this state; a step that does not is passed over when going back. */
  asks(state: S): boolean
  /**
   * Run the step.
   * @param io - the questions it may ask.
   * @param state - the state before this step.
   * @returns the state after the step, or {@link BACK}.
   */
  run(io: StepIO, state: S): Promise<S | Back>
}

/**
 * Run the steps in order. A step that returns {@link BACK} sends the run to the nearest earlier step that asks,
 * which runs again from the state it started with.
 * @param steps - the steps.
 * @param initial - the state before the first step.
 * @param prompter - draws the questions.
 * @returns the state after the last step.
 */
export async function runSteps<S>(steps: readonly RunStep<S>[], initial: S, prompter: Prompter): Promise<S> {
  const before: S[] = [initial]
  let index = 0
  while (index < steps.length) {
    const step = steps[index] as RunStep<S>
    const state = before[index] as S
    const canGoBack = steps.slice(0, index).some((earlier, position) => earlier.asks(before[position] as S))
    const next = await step.run(stepIO(prompter, canGoBack), state)
    if (next === BACK) {
      index = previousAsking(steps, before, index)
      continue
    }
    before[index + 1] = next
    index += 1
  }
  return before[steps.length] as S
}

/**
 * The nearest earlier step that asks.
 * @param steps - the steps.
 * @param before - the state before each step.
 * @param index - the step that went back; at least one earlier step asks.
 * @returns that step's index.
 */
function previousAsking<S>(steps: readonly RunStep<S>[], before: readonly S[], index: number): number {
  let position = index - 1
  while (!(steps[position] as RunStep<S>).asks(before[position] as S)) position -= 1
  return position
}
