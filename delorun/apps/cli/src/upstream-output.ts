/**
 * Upstream's plugin operation writes standard-error lines that name `dsh`, the command it belongs to: it announces a
 * profile it initialized, warns, reports a failed command, and names `dsh plugin` in its hints. `delorun` is the command
 * a person ran, so those lines are rewritten to name it, in the output of `delorun plugin` and of the profile
 * `delorun setup` links its bundles into. Upstream's source is unchanged.
 *
 * @module @delorun/cli/upstream-output
 */

/** One rewrite of upstream's output: the text it matches and what it becomes. */
interface OutputRewrite {
  readonly pattern: RegExp
  readonly replacement: string
}

/**
 * The rewrites {@link brandUpstreamOutput} applies in order. The first names the command at the start of a line, such as
 * `dsh: warning: …`; the second names the command in a hint, such as `dsh plugin allow-version …`, which
 * `delorun plugin --profile <name> allow-version` runs through upstream's parser.
 */
const REWRITES: readonly OutputRewrite[] = [
  { pattern: /^dsh: /gm, replacement: 'delorun: ' },
  { pattern: /\bdsh plugin /g, replacement: 'delorun plugin ' },
]

/**
 * Rewrite the parts of upstream's output that name `dsh` to name `delorun`; any other text passes through.
 * @param text - one write of upstream's operation output, as it passes it to `process.stderr` or to `onOutput`; a write
 *   can hold several lines.
 * @returns the text with each {@link REWRITES} rule applied.
 */
export function brandUpstreamOutput(text: string): string {
  return REWRITES.reduce((branded, { pattern, replacement }) => branded.replace(pattern, replacement), text)
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
