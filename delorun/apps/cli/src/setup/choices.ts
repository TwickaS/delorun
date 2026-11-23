/**
 * The plain-language text of setup's choices: each choice shows what it does, who it suits and how to change it
 * later, in a note above the question, so that every choice is readable at once and the question stays one line.
 *
 * @module @delorun/cli/setup/choices
 */

/** One choice as the person reads it. */
export interface ChoiceText {
  /** The choice's label, as the question lists it. */
  readonly label: string
  /** Two to three plain lines: what it does, who it suits, how to change it later. */
  readonly lines: readonly string[]
}

/**
 * Lay out the choices of one question.
 * @param choices - the choices in the order the question lists them.
 * @returns the note body: each label, then its lines indented under it, with a blank line between choices.
 */
export function choiceNote(choices: readonly ChoiceText[]): string {
  return choices.map(choice => [choice.label, ...choice.lines.map(line => `  ${line}`)].join('\n')).join('\n\n')
}

/** The label that marks the choice setup suggests. */
export const RECOMMENDED = ' (recommended)'

/** What an environment variable is, in one line, for the key question that offers one. */
export const ENVIRONMENT_VARIABLE_LINE = 'An environment variable is a named setting that your terminal passes to the programs it starts.'
