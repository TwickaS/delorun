/**
 * Git merge driver for the divergence ledger. Git runs it as `node_modules/.bin/tsx delo/apps/tools/src/ledger-merge.ts %O %A %B`
 * with the base, ours and theirs versions, and it writes the merge to ours. Entries merge by `path`, so branches that list
 * different paths merge without a conflict. An entry that both sides changed differently is wrapped in conflict markers, and
 * the command exits 1. The rules are in the tools README.
 *
 * @module @delo/tools/ledger-merge
 */
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { manifestErrors, parseManifest, type Patch, type PatchManifest, type RetiredEntry } from './fork-boundary.ts'

/** The outcome of merging three ledger versions. */
export interface LedgerMerge {
  /** The merged ledger text. Each conflicting element sits between git's conflict markers. */
  readonly text: string
  /** One message per conflict or failed validation. Empty when the merge is clean. */
  readonly errors: readonly string[]
}

/** The fields the merge reads from the base version. */
interface Ancestor {
  readonly $schema?: string | undefined
  readonly patches: readonly Patch[]
  readonly retired: readonly RetiredEntry[]
}

/** The base of a merge in which both sides added the file, which git passes as an empty file. */
const EMPTY_ANCESTOR: Ancestor = { patches: [], retired: [] }

/**
 * One merged element. A conflict keeps each side's value, and undefined marks a side that removed the element.
 */
type Merged<T> =
  | { readonly kind: 'value'; readonly value: T }
  | {
    readonly kind: 'conflict'
    readonly label: string
    readonly reason: string
    readonly ours: T | undefined
    readonly theirs: T | undefined
  }

/** The merged fields of a ledger, in the order the file writes them. */
interface MergedLedger {
  readonly schema: Merged<string> | undefined
  readonly upstream: Merged<PatchManifest['upstream']>
  readonly forkOwned: readonly string[]
  readonly patches: readonly Merged<Patch>[]
  readonly retired: readonly Merged<RetiredEntry>[]
}

const INDENT = '  '

/**
 * Merge three versions of the divergence ledger.
 *
 * Entries merge by `path`: an entry changed on one side takes that side's value, and identical changes on both sides merge
 * once. An entry that both sides changed differently is a conflict. `forkOwned` is the ordered union of both sides, and
 * `upstream` must be equal on both sides. A non-empty version is parsed with the ledger parser; an empty base is an empty
 * ledger. A conflict leaves markers around the conflicting elements; a failed validation leaves the merged text unmarked.
 *
 * @param baseText - the ancestor's JSON text, empty when both sides added the file.
 * @param oursText - our side's JSON text.
 * @param theirsText - their side's JSON text.
 * @returns the merged text and its errors.
 * @throws Error naming the version when a non-empty version is not a valid ledger.
 */
export function mergeLedgerTexts(baseText: string, oursText: string, theirsText: string): LedgerMerge {
  const ancestor = baseText.trim() === '' ? EMPTY_ANCESTOR : readVersion('base', baseText)
  const ours = readVersion('ours', oursText)
  const theirs = readVersion('theirs', theirsText)
  const merged = mergeLedger(ancestor, ours, theirs)
  const text = renderLedger(merged)
  const conflicts = conflictMessages(merged)
  const errors = conflicts.length > 0 ? conflicts : renderedErrors(text)
  return {
    text,
    errors: [...repeatedErrors(ancestor, 'base'), ...repeatedErrors(ours, 'ours'), ...repeatedErrors(theirs, 'theirs'), ...errors],
  }
}

/**
 * Parse one non-empty version of the ledger.
 * @param side - the version's name in the error: `base`, `ours` or `theirs`.
 * @param text - the version's JSON text.
 * @returns the parsed ledger.
 * @throws Error naming the side when the text is not a valid ledger.
 */
function readVersion(side: string, text: string): PatchManifest {
  try {
    return parseManifest(text)
  } catch (error) {
    throw new Error(`${side}: ${errorText(error)}`)
  }
}

/**
 * Merge the fields of three ledger versions.
 * @param ancestor - the base version's fields.
 * @param ours - our side's parsed ledger.
 * @param theirs - their side's parsed ledger.
 * @returns the merged fields, with each conflict kept as an element.
 */
function mergeLedger(ancestor: Ancestor, ours: PatchManifest, theirs: PatchManifest): MergedLedger {
  return {
    schema: decide('$schema', ancestor.$schema, ours.$schema, theirs.$schema),
    upstream: same(ours.upstream, theirs.upstream)
      ? { kind: 'value', value: ours.upstream }
      : {
        kind: 'conflict',
        label: 'upstream',
        reason: 'the sides pin different upstream commits',
        ours: ours.upstream,
        theirs: theirs.upstream,
      },
    forkOwned: [...new Set([...ours.forkOwned, ...theirs.forkOwned])],
    patches: mergeByPath('patches', ancestor.patches, ours.patches, theirs.patches),
    retired: mergeByPath('retired', ancestor.retired, ours.retired, theirs.retired),
  }
}

/**
 * Merge two lists of entries keyed by `path`. Our entries keep their order, and the entries only their side has follow in
 * their order.
 * @param section - the ledger field the entries belong to, named in conflict messages.
 * @param ancestor - the base entries.
 * @param ours - our side's entries.
 * @param theirs - their side's entries.
 * @returns the merged elements in order, without the entries that the merge keeps neither of.
 */
function mergeByPath<T extends { readonly path: string }>(
  section: string,
  ancestor: readonly T[],
  ours: readonly T[],
  theirs: readonly T[],
): Merged<T>[] {
  const ancestorByPath = indexByPath(ancestor)
  const oursByPath = indexByPath(ours)
  const theirsByPath = indexByPath(theirs)
  const paths = [...oursByPath.keys(), ...[...theirsByPath.keys()].filter(path => !oursByPath.has(path))]
  return paths.flatMap((path) => {
    const merged = decide(`${section} entry ${path}`, ancestorByPath.get(path), oursByPath.get(path), theirsByPath.get(path))
    return merged === undefined ? [] : [merged]
  })
}

/**
 * Choose one merged element from its base, ours and theirs values. A value that one side left unchanged yields the other
 * side's value, so an element one side removed stays removed unless the other side changed it.
 * @param label - names the element in a conflict message.
 * @param ancestor - the element's value in the base, or undefined when the base lacks it.
 * @param ours - the element's value on our side, or undefined when our side lacks it.
 * @param theirs - the element's value on their side, or undefined when their side lacks it.
 * @returns the merged element, or undefined when the merge keeps none.
 */
function decide<T>(label: string, ancestor: T | undefined, ours: T | undefined, theirs: T | undefined): Merged<T> | undefined {
  if (same(theirs, ancestor) || same(ours, theirs)) return keep(ours)
  if (same(ours, ancestor)) return keep(theirs)
  return { kind: 'conflict', label, reason: conflictReason(ancestor, ours, theirs), ours, theirs }
}

/**
 * Wrap a present value as a merged element.
 * @param value - the value, or undefined for an element the merge removes.
 * @returns the element, or undefined when the value is undefined.
 */
function keep<T>(value: T | undefined): Merged<T> | undefined {
  return value === undefined ? undefined : { kind: 'value', value }
}

/**
 * Compare two values that may be absent. Both come from the parser, which writes keys in schema order, so equal JSON text
 * means equal values.
 * @param a - the first value, or undefined when absent.
 * @param b - the second value, or undefined when absent.
 * @returns true when both are absent, or both are present with equal JSON text.
 */
function same(a: unknown, b: unknown): boolean {
  if (a === undefined || b === undefined) return a === b
  return JSON.stringify(a) === JSON.stringify(b)
}

/**
 * Describe why an element conflicts.
 * @param ancestor - the element's base value, or undefined when the base lacks it.
 * @param ours - our side's value, or undefined when our side lacks it.
 * @param theirs - their side's value, or undefined when their side lacks it.
 * @returns a phrase that completes `<label>: `.
 */
function conflictReason(ancestor: unknown, ours: unknown, theirs: unknown): string {
  if (ours === undefined || theirs === undefined) return 'removed on one side and changed on the other'
  return ancestor === undefined ? 'added with different values on both sides' : 'changed differently on both sides'
}

/**
 * Index entries by their path. A repeated path keeps its last entry; `repeatedErrors` reports the repetition.
 * @param entries - the entries to index.
 * @returns the entries keyed by path.
 */
function indexByPath<T extends { readonly path: string }>(entries: readonly T[]): Map<string, T> {
  return new Map(entries.map((entry): [string, T] => [entry.path, entry]))
}

/**
 * Report each list that names one path more than once within the same list.
 * @param ledger - the version's fields.
 * @param side - the version's name in the messages.
 * @returns one message per repeated path.
 */
function repeatedErrors(ledger: Ancestor, side: string): string[] {
  return [...repeatedPaths(`${side} patches`, ledger.patches), ...repeatedPaths(`${side} retired`, ledger.retired)]
}

/**
 * Report each path that one list names more than once.
 * @param label - the list's name in the messages, such as `ours patches`.
 * @param entries - the list's entries.
 * @returns one message per repeated path.
 */
function repeatedPaths(label: string, entries: readonly { readonly path: string }[]): string[] {
  const seen = new Set<string>()
  const repeated = new Set<string>()
  for (const { path } of entries) {
    if (seen.has(path)) repeated.add(path)
    seen.add(path)
  }
  return [...repeated].map(path => `${label} lists ${path} more than once`)
}

/**
 * Validate merged text that has no conflict markers, with the ledger parser and its entry rules.
 * @param text - the merged text.
 * @returns one message per problem; empty when the text is a valid ledger.
 */
function renderedErrors(text: string): string[] {
  try {
    return manifestErrors(parseManifest(text))
  } catch (error) {
    return [errorText(error)]
  }
}

/**
 * Describe each conflict in the merged fields.
 * @param merged - the merged fields.
 * @returns one message per conflict, in field order.
 */
function conflictMessages(merged: MergedLedger): string[] {
  const elements: ReadonlyArray<Merged<unknown> | undefined> = [merged.schema, merged.upstream, ...merged.patches, ...merged.retired]
  return elements.flatMap(element => element?.kind === 'conflict' ? [`${element.label}: ${element.reason}`] : [])
}

/**
 * Render merged fields as ledger JSON. Without conflicts the text equals `JSON.stringify(ledger, null, 2)` followed by one newline.
 * @param merged - the merged fields.
 * @returns the ledger text, with each conflicting element between git's conflict markers.
 */
function renderLedger(merged: MergedLedger): string {
  const { schema, upstream, forkOwned, patches, retired } = merged
  const fields: Array<(comma: boolean) => string[]> = []
  if (schema !== undefined) fields.push(comma => elementLines(schema, '$schema', INDENT, comma))
  fields.push(comma => elementLines(upstream, 'upstream', INDENT, comma))
  fields.push(comma => listLines('forkOwned', forkOwned.map((entry): Merged<string> => ({ kind: 'value', value: entry })), comma))
  fields.push(comma => listLines('patches', patches, comma))
  fields.push(comma => listLines('retired', retired, comma))
  const body = fields.flatMap((render, index) => render(index < fields.length - 1))
  return ['{', ...body, '}'].join('\n') + '\n'
}

/**
 * The lines of one merged element. A conflict renders each side's value between the markers, and a side that removed the
 * element renders nothing.
 * @param element - the merged element.
 * @param key - the field name, or undefined for a list element.
 * @param indent - the indentation of the element's first line.
 * @param comma - whether another element follows, so the element's last line ends with a comma.
 * @returns the lines.
 */
function elementLines<T>(element: Merged<T>, key: string | undefined, indent: string, comma: boolean): string[] {
  if (element.kind === 'value') return valueLines(element.value, indent, key, comma)
  return [
    '<<<<<<< ours',
    ...(element.ours === undefined ? [] : valueLines(element.ours, indent, key, comma)),
    '=======',
    ...(element.theirs === undefined ? [] : valueLines(element.theirs, indent, key, comma)),
    '>>>>>>> theirs',
  ]
}

/**
 * The lines of a list field, with its elements indented one level deeper than the field.
 * @param key - the field name.
 * @param items - the merged elements.
 * @param comma - whether another field follows the list.
 * @returns the lines.
 */
function listLines<T>(key: string, items: readonly Merged<T>[], comma: boolean): string[] {
  const close = comma ? ',' : ''
  if (items.length === 0) return [`${INDENT}${JSON.stringify(key)}: []${close}`]
  const itemIndent = `${INDENT}${INDENT}`
  const lines = [`${INDENT}${JSON.stringify(key)}: [`]
  items.forEach((item, index) => lines.push(...elementLines(item, undefined, itemIndent, index < items.length - 1)))
  lines.push(`${INDENT}]${close}`)
  return lines
}

/**
 * The JSON lines of one value, indented to a depth, preceded by its field name, and followed by a comma when another element follows.
 * @param value - the value to render.
 * @param indent - the indentation of the first line.
 * @param key - the field name, or undefined for a list element.
 * @param comma - whether a comma closes the value.
 * @returns the lines.
 */
function valueLines(value: unknown, indent: string, key: string | undefined, comma: boolean): string[] {
  const lines = JSON.stringify(value, null, 2).split('\n')
  const lead = key === undefined ? '' : `${JSON.stringify(key)}: `
  return lines.map((line, index) => {
    const text = `${indent}${index === 0 ? lead : ''}${line}`
    return index === lines.length - 1 && comma ? `${text},` : text
  })
}

/**
 * The message of an error, whatever was thrown.
 * @param error - the caught value.
 * @returns the error's message, or its string form when it is not an Error.
 */
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Merge the three files that git names and write the merge to the ours file.
 * @param argv - the base, ours and theirs paths, in the order `%O %A %B` expands them.
 * @returns the exit status: 0 for a clean merge, 1 when an entry needs a person or a version is invalid, 2 for a usage error.
 */
function main(argv: readonly string[]): number {
  const [basePath, oursPath, theirsPath, ...extra] = argv
  if (basePath === undefined || oursPath === undefined || theirsPath === undefined || extra.length > 0) {
    process.stderr.write('usage: ledger-merge.ts <base> <ours> <theirs>\n')
    return 2
  }
  let merge: LedgerMerge
  try {
    merge = mergeLedgerTexts(readFileSync(basePath, 'utf8'), readFileSync(oursPath, 'utf8'), readFileSync(theirsPath, 'utf8'))
  } catch (error) {
    process.stderr.write(`ledger-merge: ${errorText(error)}\n`)
    return 1
  }
  writeFileSync(oursPath, merge.text)
  for (const message of merge.errors) process.stderr.write(`ledger-merge: ${message}\n`)
  return merge.errors.length === 0 ? 0 : 1
}

/**
 * Whether a script path names this file. Both paths are resolved through symlinks, so a symlink to the driver runs the merge.
 * @param script - the script path from the command line, or undefined when there is none.
 * @returns true when the script is this module's file.
 */
function isEntryPoint(script: string | undefined): boolean {
  if (script === undefined || !existsSync(script)) return false
  return realpathSync(script) === realpathSync(fileURLToPath(import.meta.url))
}

if (isEntryPoint(process.argv[1])) process.exitCode = main(process.argv.slice(2))
