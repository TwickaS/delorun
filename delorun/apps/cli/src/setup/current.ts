/**
 * The answers a finished setup holds now, for a re-run to preselect. Each answer comes from the live configuration
 * through the reader that pairs with the section's write: the profile's patch rows (release check, prompts, model
 * provider and model, studio port, remote access). The answers record ([progress](./progress.ts)) supplies only what
 * the configuration does not hold: the use case, the background choice, the choice between a typed key and a variable
 * of the same name, and the answers of a profile whose patch has no rows yet.
 *
 * @module @delorun/cli/setup/current
 */
import { PhonePowersReader } from '@delorun/home-auth'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { SETUP_DEFAULT_PORT, SETUP_DEFAULTS, type ReachAnswer, type SetupAnswers } from '@delorun/contract-setup-answers'
import { readReachRowAt } from '../reach/row.ts'
import { parseAnswers } from './answers.ts'
import { readPromptsRows } from './prompt-switches.ts'
import { readProviderAnswer } from './providers.ts'
import { ANSWERS_FILENAME } from './progress.ts'
import { profileStudioPort } from './sections.ts'
import { readUpdateCheckRow } from './update-check.ts'

/**
 * The answers a finished setup recorded for a profile.
 * @param directory - the profile's directory.
 * @returns the recorded answers, or the defaults when there is no usable record.
 */
export function recordedAnswers(directory: string): SetupAnswers {
  const path = join(directory, ANSWERS_FILENAME)
  if (!existsSync(path)) return SETUP_DEFAULTS
  try {
    const { version: _version, ...answers } = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
    const checked = parseAnswers(answers)
    return checked.success ? checked.data : SETUP_DEFAULTS
  } catch {
    // An unreadable record is rewritten by the section that runs now; the defaults stand in for it.
    return SETUP_DEFAULTS
  }
}

/**
 * @param directory - the profile's directory.
 * @param recorded - the recorded studio port answer.
 * @returns the studio port answer the patch holds, `null` for the default port.
 */
function livePort(directory: string, recorded: number | null): number | null {
  const port = profileStudioPort(directory, 'delorun setup')
  // A patch without a port, or with the system-chosen port 0, holds no answer the question can show.
  if (port === undefined || port === 0) return recorded
  return port === SETUP_DEFAULT_PORT ? null : port
}

/**
 * The answers a profile holds now.
 * @param directory - the CLI profile's directory.
 * @param home - the Delorun home, whose Phone powers record a re-run starts on.
 * @returns the answers, with the recorded section statuses.
 * @throws {CliError} `EXIT.failed` when the profile's patch is not a YAML patch list.
 */
export function currentAnswers(directory: string, home: string): SetupAnswers {
  const recorded = recordedAnswers(directory)
  const patch = join(directory, 'cordis.patch.yml')
  const reach: ReachAnswer = readReachRowAt(patch).enabled ? { option: 'tailscale-private', identityFactor: 'tailnet-membership' } : { option: 'none', identityFactor: null }
  const powers = new PhonePowersReader(join(home, 'secrets', 'home-auth')).current()
  return {
    ...recorded,
    // A level the person chose is what a re-run starts on; a level Delorun recorded for them is not an answer.
    phonePowers: powers.chosen ? powers.level : null,
    updateCheck: readUpdateCheckRow(patch),
    prompts: readPromptsRows(patch) ?? recorded.prompts,
    modelProvider: readProviderAnswer(patch, recorded.modelProvider),
    profile: { name: recorded.profile.name, port: livePort(directory, recorded.profile.port) },
    reach,
  }
}
