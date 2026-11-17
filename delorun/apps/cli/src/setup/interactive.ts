/**
 * The questions of `delorun setup` in a terminal (contract C11, "Questions"). The first screen asks how the person
 * will use Delorun; the answer sets the defaults and decides which sections ask in the main flow. Then each section asks
 * its question, with a way back to the previous one, and a review screen lists every answer. The review offers "More
 * settings", which opens the sections the main flow left out. The answers come back as one {@link SetupAnswers}, the
 * same value the `--yes` and `--config` forms produce, so the three forms write identical profiles.
 *
 * @module @delorun/cli/setup/interactive
 */
import { SETUP_DEFAULTS, type SetupAnswers, type SetupUseCase } from '@delorun/contract-setup-answers'
import { BACK, runSteps, type Back, type RunStep } from './steps.ts'
import { SetupCancelled, type Prompter } from './prompts.ts'
import { choiceNote, USE_CASE_EXPLAIN, USE_CASE_HINT, USE_CASE_ORDER, USE_CASE_QUESTION, USE_CASE_REVIEW, USE_CASE_TEXT } from './choices.ts'
import { withRecord, type Draft, type SectionEnvironment, type SectionRegistry, type SetupPhase, type SetupSection } from './sections.ts'

/** What the interactive form returns: the answers, and the model key the person typed, which is never stored in them. */
export interface InteractiveAnswers {
  /** The answers, the same value `--yes` and `--config` produce for the same choices. */
  readonly answers: SetupAnswers
  /** The typed key, when the key section took one; `undefined` otherwise. */
  readonly secret: string | undefined
  /** True when the key section kept the key saved in the home. */
  readonly keepSavedKey: boolean
}

/** The value of the choice that explains the others. */
const EXPLAIN = 'explain'

/**
 * @returns true: a step that always asks.
 */
const alwaysAsks = (): boolean => true

/** What a review line ends with when a re-run changed its answer. */
const CHANGED_MARK = ' (changed)'

/** The sentence that ends the review: nothing has been written yet. */
export const NOTHING_SAVED_LINE = 'Nothing is saved until you choose Save and set up.'

/**
 * The answers a use case sets before any section asks.
 * @param useCase - the use case.
 * @param base - the answers the run started from.
 * @returns the answers with the use case's defaults: scripts keep no studio running, so they start with background running off.
 */
export function useCaseAnswers(useCase: SetupUseCase, base: SetupAnswers): SetupAnswers {
  return { ...base, useCase, background: useCase !== 'automation' }
}

/**
 * Whether a section is asked in a phase of a draft.
 * @param section - the section.
 * @param draft - the answers so far, which carry the use case and the phase the run is in.
 * @param phase - the phase the step belongs to.
 * @param environment - what the section may look at.
 * @returns true when the draft is in that phase, the use case's plan puts the section there and it applies on this computer.
 */
function isAsked(section: SetupSection, draft: Draft, phase: Exclude<SetupPhase, 'single'>, environment: SectionEnvironment): boolean {
  if (draft.phase !== phase) return false
  const plan = section.plan[draft.answers.useCase]
  const placed = phase === 'main' ? plan === 'asked' || plan === 'note' : plan === 'more' || plan === 'note'
  return placed && section.appliesTo(environment)
}

/**
 * The step of one section in one phase.
 * @param section - the section.
 * @param phase - the phase the step belongs to.
 * @param environment - what the section may look at.
 * @returns the step: in the main flow it records a section it passes over as skipped, unless a record exists already.
 */
function askStep(section: SetupSection, phase: Exclude<SetupPhase, 'single'>, environment: SectionEnvironment): RunStep<Draft> {
  return {
    asks: draft => isAsked(section, draft, phase, environment) && section.asks(phase),
    async run(io, draft) {
      if (!isAsked(section, draft, phase, environment)) {
        if (phase === 'more' || draft.answers.sections.some(record => record.id === section.id)) return draft
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
 * The sections the review lists: those the use case does not leave out and that apply on this computer.
 * @param draft - the answers.
 * @param sections - every registered section.
 * @param environment - what the sections may look at.
 * @returns the sections, in flow order.
 */
function listed(draft: Draft, sections: readonly SetupSection[], environment: SectionEnvironment): SetupSection[] {
  return sections.filter(section => section.plan[draft.answers.useCase] !== 'never' && section.appliesTo(environment))
}

/**
 * The review screen's lines.
 * @param draft - the answers.
 * @param sections - every registered section.
 * @param environment - what the sections may look at.
 * @param before - the answers a re-run started from; the lines of answers that differ from them end with a mark.
 * @returns the use case, then one line per section the use case keeps, with the answer or the default, and the line that says nothing is saved yet.
 */
export function review(draft: Draft, sections: readonly SetupSection[], environment: SectionEnvironment, before?: SetupAnswers): string {
  const mark = (section: SetupSection): string => (before !== undefined && section.unchanged?.(before, draft.answers, draft.secret !== undefined) === false ? CHANGED_MARK : '')
  return [
    `How you use Delorun: ${USE_CASE_REVIEW[draft.answers.useCase]}${before !== undefined && before.useCase !== draft.answers.useCase ? CHANGED_MARK : ''}`,
    ...listed(draft, sections, environment).flatMap(section => (section.review === undefined ? [] : [`${section.review(draft.answers, draft)}${mark(section)}`])),
    '',
    NOTHING_SAVED_LINE,
  ].join('\n')
}

/**
 * Ask every question and return the answers.
 * @param prompter - the prompter.
 * @param registry - the sections.
 * @param environment - what the sections may look at.
 * @param defaults - the answers each question starts from; setup's defaults unless a command-line flag changed one.
 * @param before - the answers of a finished setup that this run asks again: the use case keeps its other defaults when unchanged, and the review marks changed answers.
 * @returns the answers and the typed key.
 * @throws {SetupCancelled} when the person cancels a question or declines the review.
 */
export async function askAnswers(prompter: Prompter, registry: SectionRegistry, environment: SectionEnvironment, defaults: SetupAnswers = SETUP_DEFAULTS, before?: SetupAnswers): Promise<InteractiveAnswers> {
  const sections = registry.all()
  const useCaseStep: RunStep<Draft> = {
    asks: alwaysAsks,
    async run(io, draft) {
      const options = [...USE_CASE_ORDER.map(each => ({ value: each, label: USE_CASE_TEXT[each].label, hint: USE_CASE_HINT[each] })), { value: EXPLAIN, label: USE_CASE_EXPLAIN }]
      let useCase = await io.select<SetupUseCase | typeof EXPLAIN>(USE_CASE_QUESTION, options, draft.answers.useCase)
      while (useCase === EXPLAIN) {
        io.note(choiceNote(USE_CASE_ORDER.map(each => USE_CASE_TEXT[each])), 'What each one means')
        useCase = await io.select<SetupUseCase | typeof EXPLAIN>(USE_CASE_QUESTION, options, draft.answers.useCase)
      }
      // The use-case question is the first step, so it offers no back choice.
      return { ...draft, answers: before !== undefined && useCase === before.useCase ? defaults : useCaseAnswers(useCase as SetupUseCase, defaults) }
    },
  }
  const reviewStep = (final: boolean): RunStep<Draft> => ({
    asks: draft => (final ? draft.phase === 'more' : true),
    async run(io, draft): Promise<Draft | Back> {
      if (final && draft.phase !== 'more') return draft
      io.note(review(draft, sections, environment, before), 'Review')
      const more = final ? [] : sections.filter(section => section.plan[draft.answers.useCase] !== 'asked' && section.plan[draft.answers.useCase] !== 'never' && section.appliesTo(environment))
      const next = await io.select('Save these answers and set up Delorun?', [
        { value: 'save', label: 'Save and set up' },
        ...more.length === 0 ? [] : [{ value: 'more', label: 'More settings', hint: more.map(section => section.title.toLowerCase()).join(', ') }],
        { value: 'cancel', label: 'Cancel', hint: 'nothing is saved' },
      ], 'save')
      if (next === BACK) return BACK
      if (next === 'cancel') throw new SetupCancelled()
      return next === 'more' ? { ...draft, phase: 'more' } : draft
    },
  })
  const initial: Draft = { phase: 'main', answers: defaults, secret: undefined, keyCheckFailure: undefined, keepSavedKey: false }
  const steps = [
    useCaseStep,
    ...sections.map(section => askStep(section, 'main', environment)),
    reviewStep(false),
    ...sections.map(section => askStep(section, 'more', environment)),
    reviewStep(true),
  ]
  const done = await runSteps(steps, initial, prompter)
  return { answers: done.answers, secret: done.secret, keepSavedKey: done.keepSavedKey === true }
}
