/**
 * The sentence for each reason a screen shows in place: one sentence per problem, in the person's words.
 * @module @delorun/plugin-new-workspace/client/problems
 */
import { assertNever, type Problem } from './flow.ts'
import type { Translate } from './locales.ts'

/**
 * The sentence that says why something did not happen and what to do instead.
 * @param t - this plugin's copy.
 * @param problem - the reason.
 * @returns the sentence.
 */
export function problemText(t: Translate, problem: Problem): string {
  switch (problem.kind) {
    case 'place': return t(`problem.${problem.problem}`)
    case 'create': return problem.problem === 'name-form' || problem.problem === 'exists' ? t(`new.problem.${problem.problem}`) : t(`problem.${problem.problem}`)
    case 'clone': {
      const refusal = problem.problem
      return refusal === 'url-form' || refusal === 'url-credentials' || refusal === 'name-form' || refusal === 'branch-form' || refusal === 'not-empty' || refusal === 'busy'
        ? t(`clone.problem.${refusal}`)
        : t(`problem.${refusal}`)
    }
    case 'clone-failed': return t(`clone.failure.${problem.failure}`)
    case 'clone-lost': return t('clone.lost')
    case 'locked': return t('problem.locked')
    case 'refused-arrival': return t('problem.refusedArrival')
    case 'failed': return t('problem.failed')
    default: return assertNever(problem)
  }
}
