/**
 * Delorun's label set, read from `.github/labels.yml`. Each entry gives a label's name, colour and description. The names
 * follow the unified label taxonomy: a closed set of `kind/*` labels, `area/*` labels in lowercase kebab case, the
 * `wave/0` to `wave/3` labels, and Delorun's own plain labels. The aliases the taxonomy retired never reappear here.
 *
 * @module @delorun/tools/issues/labels
 */
import { load } from 'js-yaml'
import { z } from 'zod'

/** The label file, relative to the repository root. */
export const LABELS_PATH = '.github/labels.yml'

/** The `kind/*` labels: a pull request carries exactly one, and an issue carries its native Issue Type instead. */
export const KINDS: readonly string[] = [
  'kind/feature',
  'kind/bug-fix',
  'kind/doc',
  'kind/testing',
  'kind/cleanup',
  'kind/dependency',
]

/** The plain labels Delorun defines besides the namespaced families. */
const PLAIN_LABELS: readonly string[] = ['brief', 'security', 'upstream-merge', 'parity']

/** The aliases that the taxonomy retired; a label file that names one is refused. */
const RETIRED_LABELS: readonly string[] = [
  'kind/bug',
  'kind/documentation',
  'feature',
  'bug-fix',
  'doc',
  'cleanup',
  'testing',
  'dependencies',
  'ci',
  'cli',
  'llm',
  'web-search',
]

/** The longest label description GitHub accepts, in characters. */
const MAX_DESCRIPTION_LENGTH = 100

const AREA_NAME = /^area\/[a-z0-9]+(?:-[a-z0-9]+)*$/u
const WAVE_NAME = /^wave\/[0-3]$/u

/** A text field of a label entry: a missing key is reported as missing, and a non-string value as not text. */
const entryText = (notText: string): z.ZodString => z.string({ error: issue => (issue.input === undefined ? 'is missing' : notText) })

const labelSchema = z.strictObject({
  name: entryText('must be text').min(1, { error: 'is empty' }),
  color: entryText('must be a six-digit hex colour, quoted').regex(/^[0-9a-fA-F]{6}$/u, { error: 'must be a six-digit hex colour' }),
  description: entryText('must be text')
    .min(1, { error: 'is empty' })
    .max(MAX_DESCRIPTION_LENGTH, { error: `is longer than ${String(MAX_DESCRIPTION_LENGTH)} characters` }),
})

/** One entry of the label file. */
export interface LabelDefinition {
  /** The label's name, such as `kind/feature`. */
  readonly name: string
  /** The six-digit hex colour without `#`. */
  readonly color: string
  /** The description GitHub shows beside the label. */
  readonly description: string
}

/**
 * Why a label name is outside Delorun's label set.
 * @param name - the label's name.
 * @returns the problem, or undefined when the name is in the set.
 */
function nameProblem(name: string): string | undefined {
  if (RETIRED_LABELS.includes(name)) return 'is a retired alias'
  if (name.startsWith('kind/')) return KINDS.includes(name) ? undefined : 'is not one of the kind labels'
  if (name.startsWith('area/')) return AREA_NAME.test(name) ? undefined : 'is not area/ followed by a lowercase kebab-case name'
  if (name.startsWith('wave/')) return WAVE_NAME.test(name) ? undefined : 'is not wave/0, wave/1, wave/2 or wave/3'
  return PLAIN_LABELS.includes(name) ? undefined : 'is not a label in Delorun\'s label set'
}

/**
 * The problems with the names of a label list: names outside the set, and names listed twice.
 * @param labels - the parsed entries, in file order.
 * @returns one message per problem, each naming the entry's position; empty when the names are valid and unique.
 */
export function labelErrors(labels: readonly LabelDefinition[]): string[] {
  const seen = new Set<string>()
  const problems: string[] = []
  labels.forEach((label, index) => {
    const where = `${LABELS_PATH} labels[${String(index)}]`
    const problem = nameProblem(label.name)
    if (problem !== undefined) problems.push(`${where} "${label.name}" ${problem}`)
    if (seen.has(label.name)) problems.push(`${where} "${label.name}" is listed more than once`)
    seen.add(label.name)
  })
  return problems
}

/**
 * Parse the text of the label file.
 * @param yamlText - the file's text, a YAML list of label entries.
 * @returns the entries that parsed, and one message per problem.
 */
export function parseLabels(yamlText: string): { labels: LabelDefinition[]; errors: string[] } {
  let value: unknown
  try {
    value = load(yamlText)
  } catch (error) {
    return { labels: [], errors: [`${LABELS_PATH} is not valid YAML: ${error instanceof Error ? error.message : String(error)}`] }
  }
  const parsed = z.array(labelSchema).safeParse(value)
  if (!parsed.success) {
    const errors = parsed.error.issues.map(issue => `${LABELS_PATH} labels${formatPath(issue.path)}: ${issue.message}`)
    return { labels: [], errors }
  }
  return { labels: parsed.data, errors: labelErrors(parsed.data) }
}

/**
 * Render the part of a zod issue path after the array, such as `[0].color`.
 * @param path - the issue's path, which holds array indices and property names.
 * @returns the path with each index in brackets and each property after a dot.
 */
function formatPath(path: readonly PropertyKey[]): string {
  return path.map(part => (typeof part === 'number' ? `[${String(part)}]` : `.${String(part)}`)).join('')
}
