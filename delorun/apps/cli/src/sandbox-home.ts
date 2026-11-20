/**
 * The refusal for a home that looks laxer than 0700 only because the command runs inside a Delorun chat sandbox.
 * bubblewrap mounts an empty tmpfs over the protected home there, so the folder shows mode 0755 although its real mode
 * is 0700; the usual `HOME_MODE` advice (`chmod 700`) is wrong and an agent reading it would send the person to change a
 * folder that is already private. The commands that need the home say instead where to run them.
 *
 * @module @delorun/cli/sandbox-home
 */
import { HomeLayoutError, SANDBOX_VIEW_ENV } from '@delorun/home'
import { CliError, EXIT } from './exit.ts'

/** What a command that needs the home tells the person when the chat sandbox hides it. */
export const SANDBOX_HOME_MESSAGE = 'Delorun\'s folder is hidden inside the chat sandbox, so this command cannot use it here. Run this command in the studio\'s terminal outside the sandbox, or from a chat with full access. The folder itself is fine; do not change its permissions.'

/**
 * Whether a failure is the home-mode refusal a chat sandbox's fake mode bits cause: a `HOME_MODE` refusal that
 * carries the `chmod` fix (the mode-bits case; a symbolic link or another user's folder carries none), raised while
 * Delorun's own launcher marker is set.
 * @param error - the failure.
 * @param env - the environment that may carry the launcher's marker.
 * @returns true for a mode-bits refusal inside a Delorun chat sandbox.
 */
export function isSandboxHomeMode(error: unknown, env: Readonly<Record<string, string | undefined>>): error is HomeLayoutError {
  return error instanceof HomeLayoutError && error.code === 'HOME_MODE' && error.fix !== undefined && env[SANDBOX_VIEW_ENV] === '1'
}

/**
 * Replace a sandbox-caused home-mode refusal with the honest one.
 * @param error - the failure a command raised.
 * @param env - the environment that may carry the launcher's marker.
 * @returns {@link SANDBOX_HOME_MESSAGE} as a failure for a sandbox-caused refusal; `error` itself otherwise.
 */
export function sandboxHomeFailure(error: unknown, env: Readonly<Record<string, string | undefined>>): unknown {
  return isSandboxHomeMode(error, env) ? new CliError(EXIT.failed, SANDBOX_HOME_MESSAGE) : error
}
