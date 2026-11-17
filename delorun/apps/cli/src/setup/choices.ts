/**
 * The plain-language text of setup's choices: each choice shows what it does, who it suits and how to change it
 * later, in a note above the question, so that every choice is readable at once and the question stays one line.
 *
 * @module @delorun/cli/setup/choices
 */
import type { SetupUseCase } from '@delorun/contract-setup-answers'

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

/** The first question: how the person uses Delorun. */
export const USE_CASE_QUESTION = 'How will you use Delorun?'

/** What each use case does, in the order the question lists them. */
export const USE_CASE_TEXT: Readonly<Record<SetupUseCase, ChoiceText>> = {
  local: {
    label: `Just me, on this computer${RECOMMENDED}`,
    lines: [
      'Delorun runs in the background and opens in your browser on this computer. Nothing outside this computer can reach it.',
      'Suits most people.',
      'Change later: delorun setup reach.',
    ],
  },
  remote: {
    label: 'Also from my phone or another device',
    lines: [
      'As above, plus a private address on your own Tailscale network. A device you approve here with a code can read and reply to chats.',
      'Needs Tailscale installed and signed in on this computer.',
      'Change later: delorun reach off.',
    ],
  },
  automation: {
    label: 'For scripts and automation',
    lines: [
      'No studio is opened. You run delorun headless "task" from scripts or CI, with your key in an environment variable such as DEEPSEEK_API_KEY.',
      'Suits servers and scheduled jobs.',
      'Change later: delorun setup key, delorun setup background.',
    ],
  },
}

/** The short phrase beside each use case while it is selected; the longer text is behind {@link USE_CASE_EXPLAIN}. */
export const USE_CASE_HINT: Readonly<Record<SetupUseCase, string>> = {
  local: 'Delorun runs here, in your browser',
  remote: 'and from your phone, over Tailscale',
  automation: 'no studio; run it from scripts',
}

/** The choice that shows what each use case means and asks again. */
export const USE_CASE_EXPLAIN = 'What does each one mean?'

/** The use cases in the order the question lists them. */
export const USE_CASE_ORDER: readonly SetupUseCase[] = ['local', 'remote', 'automation']

/** The name of a use case on the review screen. */
export const USE_CASE_REVIEW: Readonly<Record<SetupUseCase, string>> = {
  local: 'just me, on this computer',
  remote: 'also from my phone or another device',
  automation: 'scripts and automation',
}

/** What an environment variable is, in one line, for the key question that offers one. */
export const ENVIRONMENT_VARIABLE_LINE = 'An environment variable is a named setting that your terminal passes to the programs it starts.'
