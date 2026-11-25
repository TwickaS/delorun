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
 * Print how to open the studio and, when asked, open it. A computer with no browser to open gets the one line that
 * names `delorun open --print` instead of the hint and a refusal, so the two never contradict each other.
 * @param home - the Delorun home.
 * @param profile - the CLI profile.
 * @param open - whether to open the studio in the browser now.
 * @param output - where the start writes.
 * @param opener - how the link is obtained and opened.
 * @param hint - whether to print the line that names `delorun open`; false when the caller has printed it already.
 */
export async function announceStudio(home: string, profile: string, open: boolean, output: CommandOutput, opener: StudioOpener, hint = true): Promise<void> {
  // No browser here: the hint would name a command that cannot work, so the refusal's own line stands alone.
  if (open && !opener.canOpen()) {
    output.stderr(describeOpening({ kind: 'no-browser' }, profile))
    return
  }
  if (hint) output.stdout(openHint(profile))
  if (!open) return
  const outcome = await openStudio(home, profile, opener)
  if (outcome.kind === 'opened') output.stdout(describeOpening(outcome, profile))
  else output.stderr(describeOpening(outcome, profile))
}
