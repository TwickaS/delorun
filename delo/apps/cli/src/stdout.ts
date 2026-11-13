/**
 * Standard output that closes early, as when a reader such as `head -1` ends the pipe: the write fails with `EPIPE`,
 * which ends `delorun` with exit 0 and no report, since the person chose to stop reading. Every other stream error
 * is rethrown, so the last-resort handler ([last-resort](./last-resort.ts)) reports it.
 *
 * @module @delo/cli/stdout
 */

/** The error code a write to a closed pipe carries. */
const CLOSED_PIPE = 'EPIPE'

/**
 * Listen for errors on a standard output stream, and end the process quietly when its reader has closed.
 * @param stream - the stream whose errors are watched; this process's standard output by default.
 * @param exit - ends the process with a code; this process's exit by default.
 */
export function endQuietlyWhenStdoutCloses(
  stream: NodeJS.EventEmitter = process.stdout,
  exit: (code: number) => void = code => process.exit(code),
): void {
  stream.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code !== CLOSED_PIPE) throw error
    exit(0)
  })
}
