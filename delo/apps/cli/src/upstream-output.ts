/**
 * Upstream's plugin operation prints one line that names `dsh`, the command it belongs to: it announces a profile it
 * initialized. `delorun` is the command a person ran, so the line is rewritten to name it, in the output of
 * `delorun plugin` and of the profile `delorun setup` links its bundles into. Upstream's source is unchanged.
 *
 * @module @delo/cli/upstream-output
 */

/** The start of the line upstream prints when a plugin operation initializes a profile. */
const UPSTREAM_INITIALIZED = 'dsh: initialized profile '

/**
 * Rewrite upstream's profile-initialized line to name `delorun`; any other text passes through.
 * @param text - one write of upstream's operation output, as it passes it to `process.stderr` or to `onOutput`.
 * @returns the text, with `delorun:` in place of `dsh:` when it begins with the initialized line.
 */
export function brandUpstreamOutput(text: string): string {
  return text.startsWith(UPSTREAM_INITIALIZED) ? `delorun: ${text.slice('dsh: '.length)}` : text
}

/**
 * Run upstream's plugin command with the lines it writes to standard error passed through {@link brandUpstreamOutput}.
 * Standard error is restored when the command ends or throws.
 * @param run - the command.
 * @returns what the command returns.
 */
export async function withBrandedStderr<T>(run: () => Promise<T>): Promise<T> {
  const original = process.stderr.write
  process.stderr.write = function write(this: typeof process.stderr, chunk: Parameters<typeof original>[0], ...rest: unknown[]): boolean {
    const branded = typeof chunk === 'string' ? brandUpstreamOutput(chunk) : chunk
    return (original as (...args: unknown[]) => boolean).call(this, branded, ...rest)
  } as typeof process.stderr.write
  try {
    return await run()
  } finally {
    process.stderr.write = original
  }
}
