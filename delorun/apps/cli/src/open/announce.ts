/**
 * What a start prints about the studio once the home process runs: the line that names `delorun open`, never a
 * link, and, when the start was asked to open the studio, the outcome of opening it through the home process
 * ([studio](./studio.ts)).
 *
 * @module @delorun/cli/open/announce
 */
import type { CommandOutput } from '../command.ts'
import { describeOpening, openHint, openStudio, type StudioOpener } from './studio.ts'

/**
 * Print how to open the studio and, when asked, open it.
 * @param home - the Delorun home.
 * @param profile - the CLI profile.
 * @param open - whether to open the studio in the browser now.
 * @param output - where the start writes.
 * @param opener - how the link is obtained and opened.
 */
export async function announceStudio(home: string, profile: string, open: boolean, output: CommandOutput, opener: StudioOpener): Promise<void> {
  output.stdout(openHint(profile))
  if (!open) return
  const outcome = await openStudio(home, profile, opener)
  if (outcome.kind === 'opened') output.stdout(describeOpening(outcome, profile))
  else output.stderr(describeOpening(outcome, profile))
}
