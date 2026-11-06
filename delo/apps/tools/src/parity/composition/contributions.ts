/**
 * The static part of `parity-switches`: where a Delo-owned source or a
 * ledgered upstream edit contributes to what the model sees, and whether a
 * built, model-visible C16 switch covers that file.
 *
 * A contribution is a call to one of upstream's model-visible registration
 * APIs ({@link CONTRIBUTION_APIS}): the system prompt's sections, contexts and
 * runtime-context suppression, the tool registry, `defineTool`, and listeners
 * of the events that change a model request or a tool's result. In a
 * Delo-owned file every such call counts. In a ledgered upstream file a
 * changed line counts when it lies in a top-level statement that holds such a
 * call, which covers a tool's description, parameters, output schema and
 * result rendering written inside its definition or its plugin's `apply`.
 *
 * @module @delo/tools/parity/composition/contributions
 */
import ts from 'typescript'
import type { ParitySwitchEntry } from '@delo/contract-parity-composition'

/** The registration APIs whose calls reach a model request. */
export const CONTRIBUTION_APIS = {
  /** Methods of a receiver named `systemPrompt`. */
  systemPrompt: ['section', 'context', 'suppressRuntimeContext'],
  /** Methods of a receiver named `tools`. */
  tools: ['register', 'restrict', 'setExecutor', 'guard'],
  /** Free functions. */
  functions: ['defineTool'],
  /** Events whose listeners, registered with `on`, change a model request, its context or a tool's execution or result. */
  events: ['system-prompt/assemble', 'agent/request', 'agent/pre-step', 'request/context', 'tools/execute', 'tools/pre-execute', 'tools/post-execute', 'tools/result'],
} as const

/** One model-visible contribution. */
export interface Contribution {
  /** Repository path. */
  readonly path: string
  /** 1-based line: the call in a Delo-owned file, the first changed line of the statement in an upstream edit. */
  readonly line: number
  /** The API, such as `systemPrompt.context` or `defineTool`. */
  readonly api: string
}

function receiverName(expression: ts.Expression): string | undefined {
  if (ts.isIdentifier(expression)) return expression.text
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text
  return undefined
}

/**
 * The registration API a call makes, if any.
 * @param call - a call expression.
 * @returns such as `tools.register`, or undefined for any other call.
 */
function contributionApi(call: ts.CallExpression): string | undefined {
  const callee = call.expression
  if (ts.isIdentifier(callee)) return (CONTRIBUTION_APIS.functions as readonly string[]).includes(callee.text) ? callee.text : undefined
  if (!ts.isPropertyAccessExpression(callee)) return undefined
  const method = callee.name.text
  const receiver = receiverName(callee.expression)
  if (receiver === 'systemPrompt' && (CONTRIBUTION_APIS.systemPrompt as readonly string[]).includes(method)) return `systemPrompt.${method}`
  if (receiver === 'tools' && (CONTRIBUTION_APIS.tools as readonly string[]).includes(method)) return `tools.${method}`
  const [event] = call.arguments
  if (method === 'on' && event !== undefined && ts.isStringLiteralLike(event) && (CONTRIBUTION_APIS.events as readonly string[]).includes(event.text)) return `on('${event.text}')`
  return undefined
}

/**
 * The contributions one file makes.
 * @param path - the repository path.
 * @param text - the file's TypeScript source.
 * @param changed - `all` for a Delo-owned or a new file; otherwise the 1-based lines a ledgered edit changed.
 * @returns one contribution per call, or per top-level statement with a changed line, in source order.
 */
export function findContributions(path: string, text: string, changed: 'all' | ReadonlySet<number>): Contribution[] {
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
  const lineOf = (position: number): number => source.getLineAndCharacterOfPosition(position).line + 1
  const found: Contribution[] = []
  for (const statement of source.statements) {
    const calls: { api: string; line: number }[] = []
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        const api = contributionApi(node)
        if (api !== undefined) calls.push({ api, line: lineOf(node.getStart(source)) })
      }
      ts.forEachChild(node, visit)
    }
    visit(statement)
    if (calls.length === 0) continue
    if (changed === 'all') {
      found.push(...calls.map(call => ({ path, ...call })))
      continue
    }
    const first = lineOf(statement.getStart(source))
    const last = lineOf(statement.getEnd())
    const line = [...changed].filter(candidate => candidate >= first && candidate <= last).sort((a, b) => a - b)[0]
    if (line !== undefined) found.push({ path, line, api: [...new Set(calls.map(call => call.api))].join(', ') })
  }
  return found
}

/**
 * The new-file lines a zero-context diff changes. A pure deletion counts as the line before it, so a removal inside a
 * statement still counts for that statement.
 * @param diff - `git diff --unified=0` output for one file.
 * @returns the 1-based lines.
 */
export function changedLines(diff: string): Set<number> {
  const lines = new Set<number>()
  for (const match of diff.matchAll(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gmu)) {
    const start = Number(match[1])
    const count = match[2] === undefined ? 1 : Number(match[2])
    if (count === 0) lines.add(Math.max(start, 1))
    for (let line = start; line < start + count; line += 1) lines.add(line)
  }
  return lines
}

/**
 * The contributions that no built, model-visible switch covers. A switch covers a contribution in a file its entry
 * lists in `sources`, when its parity value differs from its default.
 * @param contributions - the contributions found.
 * @param registry - the switch registry.
 * @returns one message per uncovered contribution.
 */
export function contributionErrors(contributions: readonly Contribution[], registry: readonly ParitySwitchEntry[]): string[] {
  return contributions.flatMap((contribution) => {
    const covering = registry.some(entry => entry.state === 'built' && entry.modelVisible && entry.parityValue !== entry.defaultValue
      && entry.sources.includes(contribution.path))
    return covering ? [] : [`${contribution.path}:${String(contribution.line)}: ${contribution.api} is a model-visible contribution that no built C16 switch turns off; register the switch in PARITY_SWITCHES with this file in its sources`]
  })
}
