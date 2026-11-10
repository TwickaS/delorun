/**
 * The background answer, read back by the commands that start Delorun.
 *
 * @module @delo/cli/setup/background
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { SETUP_DEFAULTS } from '@delo/contract-setup-answers'
import { ANSWERS_FILENAME } from './progress.ts'

/**
 * Whether the person chose to keep Delorun running in the background after the terminal closes. A profile whose
 * answers record is missing or unreadable keeps the default, which is yes.
 * @param profileDirectory - the CLI profile's directory.
 * @returns the answer.
 */
export function readBackgroundAnswer(profileDirectory: string): boolean {
  const path = join(profileDirectory, ANSWERS_FILENAME)
  if (!existsSync(path)) return SETUP_DEFAULTS.background
  try {
    const record = JSON.parse(readFileSync(path, 'utf8')) as { background?: unknown }
    return typeof record.background === 'boolean' ? record.background : SETUP_DEFAULTS.background
  } catch {
    // An unreadable record is not setup's answer; the default applies and `delorun setup background` rewrites it.
    return SETUP_DEFAULTS.background
  }
}
