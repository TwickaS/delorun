/**
 * The background answer, read back by the commands that start Delorun.
 *
 * @module @delorun/cli/setup/background
 */
import { backgroundOf, readAnswersRecord } from '@delorun/setup-apply'

/**
 * Whether the person chose to keep Delorun running in the background after the terminal that started it closes. A profile
 * whose answers record is missing or unreadable keeps the default, which is yes.
 * @param profileDirectory - the CLI profile's directory.
 * @returns the answer.
 */
export function readBackgroundAnswer(profileDirectory: string): boolean {
  return backgroundOf(readAnswersRecord(profileDirectory))
}
