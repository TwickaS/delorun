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
 * A `security` ledger entry may list `nonModelVisibleHunks`: the digest
 * ({@link DiffHunk}) of each zero-context hunk of the file's diff that touches
 * such a statement and that the lead reviewed as not model-visible, with a
 * one-line reason. `ledger-record.ts --non-model-visible-hunk` writes them. A
 * record passes the changed lines of one hunk with its digest, a deletion-only
 * hunk as any other. The hunks with one digest pass only when the records with
 * that digest are exactly as many, so a record covers no second hunk with the
 * same lines; a record that matches no such hunk fails as stale, and any
 * further change inside or next to a recorded hunk changes its digest, so its
 * lines count again.
 *
 * @module @delo/tools/parity/composition/contributions
 */
import ts from 'typescript'
import type { ParitySwitchEntry } from '@delo/contract-parity-composition'
import type { NonModelVisibleHunk } from '../../fork-boundary.ts'
import { patchDigest } from '../../ledger-digests.ts'

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
  /** In an upstream edit, the statement's changed lines, ascending; absent in a Delo-owned or a new file. */
  readonly lines?: readonly number[]
}

/** One hunk of a ledgered upstream file's zero-context diff against the pinned commit. */
export interface DiffHunk {
  /** The 1-based new-file lines the hunk is read at: the lines it adds, or for a deletion-only hunk the line before it. */
  readonly lines: readonly number[]
  /**
   * The SHA-256 of `@@ -<old count> +<new count> @@` followed by each of the hunk's lines as git prints them, `-`, `+`
   * or `\` marker included, every line ending in `\n`. The start lines and the function context are left out, so an
   * edit elsewhere that shifts the hunk keeps its digest.
   */
  readonly sha256: string
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
    const lines = [...changed].filter(candidate => candidate >= first && candidate <= last).sort((a, b) => a - b)
    const [line] = lines
    if (line !== undefined) found.push({ path, line, api: [...new Set(calls.map(call => call.api))].join(', '), lines })
  }
  return found
}

/**
 * Read the hunks of a zero-context diff of one file.
 * @param diff - `git diff --unified=0` output for one file.
 * @returns the hunks, in diff order.
 */
export function diffHunks(diff: string): DiffHunk[] {
  const hunks: DiffHunk[] = []
  let open: { lines: number[]; text: string[] } | undefined
  const close = (): void => {
    if (open !== undefined) hunks.push({ lines: open.lines, sha256: patchDigest(open.text.map(line => `${line}\n`).join('')) })
  }
  for (const line of diff.split('\n')) {
    const header = /^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/u.exec(line)
    if (header !== null) {
      close()
      const start = Number(header[2])
      const count = header[3] === undefined ? 1 : Number(header[3])
      const lines = count === 0 ? [Math.max(start, 1)] : Array.from({ length: count }, (_, index) => start + index)
      open = { lines, text: [`@@ -${header[1] ?? '1'} +${String(count)} @@`] }
    } else if (open !== undefined && /^[-+\\]/u.test(line)) {
      open.text.push(line)
    }
  }
  close()
  return hunks
}

/**
 * The changed lines of a file's hunks.
 * @param hunks - the file's hunks.
 * @returns every line a hunk is read at.
 */
export function hunkLines(hunks: readonly DiffHunk[]): Set<number> {
  return new Set(hunks.flatMap(hunk => hunk.lines))
}

/**
 * The hunks a non-model-visible hunk record may pass: those read at a changed line of a statement that registers a
 * contribution.
 * @param contributions - one file's contributions, as {@link findContributions} gives them for an upstream edit.
 * @param hunks - the file's hunks.
 * @returns the hunks by digest, each list in diff order.
 */
export function recordableHunks(contributions: readonly Contribution[], hunks: readonly DiffHunk[]): Map<string, DiffHunk[]> {
  const statementLines = new Set(contributions.flatMap(contribution => contribution.lines ?? []))
  const byDigest = new Map<string, DiffHunk[]>()
  for (const hunk of hunks.filter(candidate => candidate.lines.some(line => statementLines.has(line)))) {
    byDigest.set(hunk.sha256, [...byDigest.get(hunk.sha256) ?? [], hunk])
  }
  return byDigest
}

/**
 * Pass the changed lines of one ledgered upstream file that its security entry's non-model-visible hunk records cover.
 * The hunks with one digest pass when the records with that digest are exactly as many; otherwise none of them pass.
 * @param path - the repository path.
 * @param contributions - the file's contributions, as {@link findContributions} gives them.
 * @param edited - the file's hunks, or `all` for a file the pinned commit lacks, whose records pass nothing.
 * @param records - the entry's records.
 * @returns the contributions that keep a changed line of an unpassed hunk, each at its first such line, and one message
 * per digest whose record count differs from the number of recordable hunks with that digest.
 */
export function passNonModelVisibleHunks(
  path: string, contributions: readonly Contribution[], edited: 'all' | readonly DiffHunk[], records: readonly NonModelVisibleHunk[],
): { readonly contributions: Contribution[]; readonly errors: string[] } {
  if (records.length === 0) return { contributions: [...contributions], errors: [] }
  const recordable = recordableHunks(contributions, edited === 'all' ? [] : edited)
  const counts = new Map<string, number>()
  for (const record of records) counts.set(record.sha256, (counts.get(record.sha256) ?? 0) + 1)
  const errors: string[] = []
  for (const [digest, count] of counts) {
    const hunks = recordable.get(digest) ?? []
    if (hunks.length === count) {
      recordable.delete(digest)
    } else if (hunks.length === 0) {
      errors.push(`${path}: the non-model-visible hunk record ${digest} matches no hunk of the edit in a statement that registers a model-visible contribution; it is stale, so remove it`)
    } else {
      errors.push(`${path}: ${String(count)} non-model-visible hunk record(s) ${digest} for ${String(hunks.length)} hunk(s) with that digest, read at line(s) ${hunks.map(hunk => hunk.lines[0]).join(', ')}; each hunk needs one record, which \`ledger-record.ts --non-model-visible-hunk\` writes`)
    }
  }
  const open = new Set([...recordable.values()].flat().flatMap(hunk => hunk.lines))
  return {
    contributions: contributions.flatMap((contribution) => {
      if (contribution.lines === undefined) return [contribution]
      const [line] = contribution.lines.filter(candidate => open.has(candidate))
      return line === undefined ? [] : [{ ...contribution, line }]
    }),
    errors,
  }
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
