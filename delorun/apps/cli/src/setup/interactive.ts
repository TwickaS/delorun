/**
 * The questions of `delorun setup` in a terminal (contract C11, "Questions"). Each section the main flow asks puts its
 * question, with a way back to the previous one; a section the main flow leaves out keeps the answer it starts from and
 * is asked by `delorun setup <section>`. The answers come back as one {@link SetupAnswers}, the same value the `--yes`
 * and `--config` forms produce, so the three forms write identical profiles.
 *
 * @module @delorun/cli/setup/interactive
 */
import { SETUP_DEFAULTS, type SetupAnswers } from '@delorun/contract-setup-answers'
import { BACK, runSteps, type RunStep } from './steps.ts'
import type { Prompter } from './prompts.ts'
import { placementOf, withRecord, type Draft, type SectionEnvironment, type SectionRegistry, type SetupSection } from './sections.ts'

/** What the interactive form returns: the answers, and the model key the person typed, which is never stored in them. */
export interface InteractiveAnswers {
  /** The answers, the same value `--yes` and `--config` produce for the same choices. */
  readonly answers: SetupAnswers
  /** The typed key, when the key section took one; `undefined` otherwise. */
  readonly secret: string | undefined
  /** True when the key section kept the key saved in the home. */
  readonly keepSavedKey: boolean
}

/**
 * Whether a section is asked, or shows its note, in the main flow for a draft.
 * @param section - the section.
 * @param draft - the answers so far.
 * @param environment - what the section may look at.
 * @returns true when the draft is in the main flow, the section's placement is not `never` and it applies on this computer.
 */
function isInMainFlow(section: SetupSection, draft: Draft, environment: SectionEnvironment): boolean {
  return placementOf(section, draft) !== 'never' && section.appliesTo(environment)
}

/**
 * The step of one section in the main flow.
 * @param section - the section.
 * @param environment - what the section may look at.
 * @returns the step: it records a section it passes over as skipped, unless a record exists already.
 */
function askStep(section: SetupSection, environment: SectionEnvironment): RunStep<Draft> {
  return {
    asks: draft => isInMainFlow(section, draft, environment) && section.asks('main'),
    async run(io, draft) {
      if (!isInMainFlow(section, draft, environment)) {
        if (draft.answers.sections.some(record => record.id === section.id)) return draft
        return { ...draft, answers: { ...draft.answers, sections: withRecord(draft.answers.sections, section.id, 'skipped') } }
      }
      const given = await section.ask(io, draft, environment)
      if (given === BACK) return BACK
      return {
        phase: draft.phase,
        answers: { ...draft.answers, ...given.answers, sections: withRecord(draft.answers.sections, section.id, given.status) },
        secret: given.secret ?? draft.secret,
        keyCheckFailure: given.keyCheckFailure ?? draft.keyCheckFailure,
        keepSavedKey: given.keepSavedKey ?? draft.keepSavedKey,
      }
    },
  }
}

/**
 * Ask every question and return the answers.
 * @param prompter - the prompter.
 * @param registry - the sections.
 * @param environment - what the sections may look at.
 * @param defaults - the answers each question starts from; setup's defaults unless a command-line flag or a finished setup changed one.
 * @returns the answers and the typed key.
 * @throws {SetupCancelled} when the person cancels a question.
 */
export async function askAnswers(prompter: Prompter, registry: SectionRegistry, environment: SectionEnvironment, defaults: SetupAnswers = SETUP_DEFAULTS): Promise<InteractiveAnswers> {
  const initial: Draft = { phase: 'main', answers: defaults, secret: undefined, keyCheckFailure: undefined, keepSavedKey: false }
  const done = await runSteps(registry.all().map(section => askStep(section, environment)), initial, prompter)
  return { answers: done.answers, secret: done.secret, keepSavedKey: done.keepSavedKey === true }
}
