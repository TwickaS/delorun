/**
 * The prompts answer setup recorded for a profile. The patch rows an answer writes are `@delorun/setup-apply`'s.
 *
 * @module @delorun/cli/setup/prompt-switches
 */
import type { PromptsAnswer } from '@delorun/contract-setup-answers'
import { promptsOf, readAnswersRecord } from '@delorun/setup-apply'

/**
 * The prompts answer setup recorded for a profile, which the start holds the prompt rows to. A profile without an
 * answers record, or with one that does not name a known answer, has setup's default, "Ask me first"; `delorun
 * setup prompts` records the answer again.
 * @param profileDirectory - the CLI profile's directory.
 * @returns the answer.
 */
export function readPromptsAnswer(profileDirectory: string): PromptsAnswer {
  return promptsOf(readAnswersRecord(profileDirectory))
}
