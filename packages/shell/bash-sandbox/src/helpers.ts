/** Shell-result projection over shared sandbox diagnostics. */
import type { ShellRunResult } from '@deepseek-ai/dsh-shell'
import { denialOf } from '@deepseek-ai/dsh-sandbox'
export { denialOf, isRunnerSpawnFailure, classifyRunnerFailure, matchesSignature } from '@deepseek-ai/dsh-sandbox'

/**
 * Classify a failed run against the selected backend's denial dialect, then the environment's.
 * @param result - settled foreground run.
 * @param signatures - case-insensitive denial substrings from the active wrap.
 * @param environment - the environment's denial substrings from the active wrap.
 * @returns `denied`, with `deniedBy: 'environment'` when only the environment's matched.
 */
export function classifyDenial(
  result: ShellRunResult,
  signatures: readonly string[],
  environment: readonly string[] = [],
): ReturnType<typeof denialOf> {
  return denialOf(result.exitCode, result.stderr.text, signatures, environment)
}
