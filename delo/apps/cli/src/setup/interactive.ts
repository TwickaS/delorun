/**
 * The questions of `delorun setup` in a terminal (contract C11, "Questions"). The first screen picks Quick or
 * Full; then each registered section asks its question, with a way back to the previous one, and a review screen
 * ends the run. The answers come back as one {@link SetupAnswers}, the same value the `--yes` and `--config`
 * forms produce, so the three forms write identical profiles.
 *
 * @module @delo/cli/setup/interactive
 */
import { SETUP_DEFAULTS, type SetupAnswers } from '@delo/contract-setup-answers'
import { BACK, runSteps, type Back, type RunStep } from './steps.ts'
import { SetupCancelled, type Prompter } from './prompts.ts'
import { withRecord, type Draft, type SectionEnvironment, type SectionRegistry, type SetupMode, type SetupSection } from './sections.ts'

/** What the interactive form returns: the answers, and the model key the person typed, which is never stored in them. */
export interface InteractiveAnswers {
  /** The answers, the same value `--yes` and `--config` produce for the same choices. */
  readonly answers: SetupAnswers
  /** The typed key, when the key section took one; `undefined` otherwise. */
  readonly secret: string | undefined
}

/**
 * @returns true: a step that always asks.
 */
const alwaysAsks = (): boolean => true

const MODE_LABELS: Readonly<Record<SetupMode, string>> = { quick: 'Quick', full: 'Full' }

/**
 * Whether a section is asked in a run.
 * @param section - the section.
 * @param draft - the answers so far, which carry the mode.
 * @param environment - what the section may look at.
 * @returns true when the mode includes the section and it applies on this computer.
 */
function isAsked(section: SetupSection, draft: Draft, environment: SectionEnvironment): boolean {
  return (draft.mode === 'full' || section.mode === 'quick') && section.appliesTo(environment)
}

/**
 * The step of one section.
 * @param section - the section.
 * @param environment - what the section may look at.
 * @returns the step: it records the section as skipped when it is not asked.
 */
function askStep(section: SetupSection, environment: SectionEnvironment): RunStep<Draft> {
  return {
    asks: draft => section.asks(draft.mode) && isAsked(section, draft, environment),
    async run(io, draft) {
      if (!isAsked(section, draft, environment)) {
        return { ...draft, answers: { ...draft.answers, sections: withRecord(draft.answers.sections, section.id, 'skipped') } }
      }
      const given = await section.ask(io, draft, environment)
      if (given === BACK) return BACK
      return {
        mode: draft.mode,
        answers: { ...draft.answers, ...given.answers, sections: withRecord(draft.answers.sections, section.id, given.status) },
        secret: given.secret ?? draft.secret,
        keyCheckFailure: given.keyCheckFailure ?? draft.keyCheckFailure,
      }
    },
  }
}

/**
 * The review screen's lines.
 * @param draft - the answers.
 * @param sections - every registered section.
 * @returns one line for the mode and one per section that was asked and has a line.
 */
export function review(draft: Draft, sections: readonly SetupSection[]): string {
  return [
    `Setup: ${MODE_LABELS[draft.mode]}`,
    ...sections
      .filter(section => draft.answers.sections.find(record => record.id === section.id)?.status === 'answered')
      .flatMap(section => section.review?.(draft.answers, draft) ?? []),
  ].join('\n')
}

/**
 * Ask every question and return the answers.
 * @param prompter - the prompter.
 * @param registry - the sections.
 * @param environment - what the sections may look at.
 * @param defaults - the answers each question starts from; setup's defaults unless a command-line flag changed one.
 * @returns the answers and the typed key.
 * @throws {SetupCancelled} when the person cancels a question or declines the review.
 */
export async function askAnswers(prompter: Prompter, registry: SectionRegistry, environment: SectionEnvironment, defaults: SetupAnswers = SETUP_DEFAULTS): Promise<InteractiveAnswers> {
  const sections = registry.all()
  const modeStep: RunStep<Draft> = {
    asks: alwaysAsks,
    async run(io, draft) {
      const mode = await io.select<SetupMode>('How do you want to set up Delorun?', [
        { value: 'quick', label: MODE_LABELS.quick, hint: 'the model key and how careful prompts are' },
        { value: 'full', label: MODE_LABELS.full, hint: 'also the release check, background running, the profile name and the port' },
      ], draft.mode)
      // The mode question is the first step, so it offers no back choice.
      return { ...draft, mode: mode as SetupMode }
    },
  }
  const reviewStep: RunStep<Draft> = {
    asks: alwaysAsks,
    async run(io, draft): Promise<Draft | Back> {
      io.note(review(draft, sections), 'Review')
      const next = await io.select('Save these answers and set up Delorun?', [
        { value: 'save', label: 'Save and set up' },
        { value: 'cancel', label: 'Cancel', hint: 'nothing is written' },
      ], 'save')
      if (next === BACK) return BACK
      if (next === 'cancel') throw new SetupCancelled()
      return draft
    },
  }
  const initial: Draft = { mode: 'quick', answers: defaults, secret: undefined, keyCheckFailure: undefined }
  const done = await runSteps([modeStep, ...sections.map(section => askStep(section, environment)), reviewStep], initial, prompter)
  return { answers: done.answers, secret: done.secret }
}
