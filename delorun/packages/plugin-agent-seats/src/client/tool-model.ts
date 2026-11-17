/**
 * View models for the records of a program's own tool calls (`claude_code.Bash`, `codex.commandExecution`, …). A
 * record's arguments and output come from a program, so they are parsed defensively; anything unrecognised falls back to
 * a generic card.
 * @module
 */

/** The record-name prefixes of the two programs. */
export const RECORD_PREFIXES = ['claude_code.', 'codex.'] as const

/** The program tools whose records get a card; any other record name shows the generic row. */
export const RECORD_TOOL_NAMES: readonly string[] = [
  ...['Bash', 'Read', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Grep', 'Glob', 'WebSearch', 'WebFetch', 'Task', 'TodoWrite'].map(name => `claude_code.${name}`),
  ...['commandExecution', 'fileChange', 'webSearch', 'mcpToolCall', 'plan', 'reasoning'].map(name => `codex.${name}`),
]

/** What a record's card shows. */
export type ToolCardKind = 'ran' | 'searched' | 'edited' | 'generic'

/** The settled state of the call. */
export type ToolCardState = 'running' | 'ok' | 'failed'

/** A frozen presentation of one record. */
export interface ToolCard {
  /** Which look the card takes. */
  readonly kind: ToolCardKind
  /** The command, search term, file path or tool name. */
  readonly subject: string
  /** Where a search looked, when it said. */
  readonly where: string | null
  /** The call's state. */
  readonly state: ToolCardState
  /** The exit code of a command, when the program reported one. */
  readonly exitCode: number | null
  /** Added and removed lines of an edit, when countable. */
  readonly diff: { readonly added: number; readonly removed: number } | null
  /** The number of matches a search reported. */
  readonly matches: number | null
  /** Seconds the call took, when both ends were recorded. */
  readonly seconds: number | null
  /** The call's output text, folded in the card. */
  readonly output: string | null
}

/** The part of a settled record the model reads. */
export interface ToolRecordInput {
  /** The record name with its prefix. */
  readonly name: string
  /** The raw JSON arguments. */
  readonly argsRaw: string
  /** The result, or null while the call runs. */
  readonly result: {
    readonly text: string
    readonly isError: boolean
    readonly seconds: number | null
  } | null
}

/**
 * Whether a tool name is a seat record.
 * @param name - the wire tool name.
 * @returns whether the name carries a program prefix.
 */
export function isRecordName(name: string): boolean {
  return RECORD_PREFIXES.some(prefix => name.startsWith(prefix))
}

function parseArgs(raw: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(raw)
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)) : {}
  } catch {
    // A program's half-written arguments show as a generic card.
    return {}
  }
}

function text(args: Record<string, unknown>, ...keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = args[key]
    if (typeof value === 'string' && value !== '') return value
  }
  return null
}

function lineCount(value: string | null): number {
  return value === null || value === '' ? 0 : value.split('\n').length
}

function kindOf(bare: string): ToolCardKind {
  const lower = bare.toLowerCase()
  if (lower === 'bash' || lower === 'commandexecution' || lower === 'shell') return 'ran'
  if (lower === 'grep' || lower === 'glob' || lower === 'websearch' || lower === 'search') return 'searched'
  if (lower === 'edit' || lower === 'write' || lower === 'multiedit' || lower === 'filechange') return 'edited'
  return 'generic'
}

/** Exit code in the output of a command card (`exit 1`), when the program put one in the text. */
const EXIT_LINE = /(?:^|\n)\s*exit(?: code)?[: ]+(-?\d+)\s*$/i

/**
 * Build the card of a record.
 * @param input - the record's name, arguments and result.
 * @returns the card's frozen presentation.
 */
export function toolCard(input: ToolRecordInput): ToolCard {
  const bare = input.name.slice(input.name.indexOf('.') + 1)
  const kind = kindOf(bare)
  const args = parseArgs(input.argsRaw)
  const output = input.result?.text ?? null
  const failed = input.result?.isError === true
  const exit = output === null ? null : EXIT_LINE.exec(output)
  const exitCode = exit === null ? null : Number(exit[1])
  const state: ToolCardState = input.result === null ? 'running' : failed || (exitCode !== null && exitCode !== 0) ? 'failed' : 'ok'
  let subject = bare
  let where: string | null = null
  let diff: ToolCard['diff'] = null
  let matches: number | null = null
  if (kind === 'ran') subject = text(args, 'command', 'cmd') ?? bare
  if (kind === 'searched') {
    subject = text(args, 'pattern', 'query', 'term') ?? bare
    where = text(args, 'path', 'glob')
    if (output !== null) matches = output === '' ? 0 : output.split('\n').filter(line => line !== '').length
  }
  if (kind === 'edited') {
    subject = text(args, 'file_path', 'path') ?? bare
    const next = text(args, 'new_string', 'content')
    diff = { added: lineCount(next), removed: lineCount(text(args, 'old_string')) }
  }
  return { kind, subject, where, state, exitCode, diff, matches, seconds: input.result?.seconds ?? null, output }
}
