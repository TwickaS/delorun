/**
 * Delorun's repository guards on upstream's workflows, read back to the conditions and runner selectors upstream wrote.
 *
 * Delorun's fork runs upstream's workflows in its own repository. A job that needs DeepSeek's secrets or infrastructure
 * carries `if: github.repository == 'deepseek-ai/deepseek-harness'`, combined as `<guard> && (<upstream condition>)`
 * when upstream's job had a condition, and each job of `ci.yml` selects its runner with
 * `${{ <guard> && (<upstream selector>) || '<hosted label>' }}` (delorun/apps/tools/README.md#workflows). Upstream's
 * workflow specs read a guarded field through these functions, so their assertions apply to upstream's own text, as
 * the job behaves in upstream's repository, and the read fails when Delorun's guard is missing or malformed.
 */

/** The repository whose jobs keep upstream's conditions and runners. */
export const UPSTREAM_REPOSITORY = 'deepseek-ai/deepseek-harness'

/** The expression Delorun's guard tests. */
export const REPOSITORY_GUARD = `github.repository == '${UPSTREAM_REPOSITORY}'`

const OPEN = '${{ '
const CLOSE = ' }}'

/**
 * The job condition upstream wrote, from the condition Delorun's guard wraps.
 * @param condition - the guarded job's `if` value.
 * @returns the upstream condition, in its own `${{ }}` form when Delorun's guarded condition used that form, or
 * `undefined` when upstream's job had no condition.
 * @throws Error when the condition is not Delorun's guard alone or `<guard> && (<condition>)`.
 */
export function upstreamCondition(condition: string | undefined): string | undefined {
  if (condition === REPOSITORY_GUARD) return undefined
  const wrapped = condition !== undefined && condition.startsWith(OPEN) && condition.endsWith(CLOSE)
  const body = wrapped ? condition.slice(OPEN.length, -CLOSE.length) : condition ?? ''
  const prefix = `${REPOSITORY_GUARD} && (`
  if (!body.startsWith(prefix) || !body.endsWith(')')) throw new Error(`the job condition lacks Delorun's repository guard: ${String(condition)}`)
  const inner = body.slice(prefix.length, -1).trim()
  return wrapped ? `${OPEN}${inner}${CLOSE}` : inner
}

/**
 * The runner selector upstream wrote, from the selector Delorun routes outside upstream's repository.
 * @param selector - the routed job's `runs-on` value.
 * @param hosted - the GitHub-hosted label the job runs on in any other repository.
 * @returns upstream's `${{ }}` selector.
 * @throws Error when the selector is not `${{ <guard> && (<selector>) || '<hosted>' }}`.
 */
export function upstreamRunsOn(selector: string, hosted: 'ubuntu-latest' | 'windows-latest'): string {
  const text = selector.trim()
  const prefix = `${OPEN}${REPOSITORY_GUARD} && (`
  const suffix = `) || '${hosted}'${CLOSE}`
  const end = text.lastIndexOf(')')
  if (!text.startsWith(prefix) || text.slice(end) !== suffix) throw new Error(`the runner selector lacks Delorun's routing to ${hosted}: ${selector}`)
  return `${OPEN}${text.slice(prefix.length, end).trim()}${CLOSE}`
}
