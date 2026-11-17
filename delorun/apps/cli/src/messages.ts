/**
 * Sentences several commands print for the same situation, so each situation has one wording.
 *
 * @module @delorun/cli/messages
 */

/**
 * The sentence for a command that needs a running home process when none runs.
 * @param profile - the profile the command acts on.
 * @returns the sentence without a line ending; it names `--profile` only for a profile other than `default`.
 */
export function notRunningText(profile: string): string {
  return `Delorun isn't running. Start it with: delorun start${profile === 'default' ? '' : ` --profile ${profile}`}`
}

/** What a command that needs remote access prints when it is off. */
export const REMOTE_ACCESS_OFF = '! Remote access is off, so no phone can reach this studio. Turn it on first: delorun reach on tailscale'
