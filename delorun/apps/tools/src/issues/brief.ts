/**
 * The work brief: the fields of Delorun's single brief template, the rules a set of briefs meets before an issue is created
 * from it, and the Markdown body a GitHub issue form submission would produce.
 *
 * A briefs file is a JSON array of objects. Each object holds the template's fields under their labels, and also a
 * `title`, the `labels` the issue carries and its `milestone`.
 *
 * @module @delorun/tools/issues/brief
 */
import { z } from 'zod'
import { LABELS_PATH } from './labels.ts'
import { linkReferences, referenceErrors, type ReferenceContext } from './references.ts'

/** The field whose paths the package changes, so it may name files that the tree does not track yet. */
const OWNED_FIELD: BriefField = 'You own'

/** The fields of the brief template, in the order that the issue body and the issue form present them. */
export const BRIEF_FIELDS = [
  'Package',
  'Size and review',
  'Model',
  'Repository and branch',
  'Read first',
  'Goal',
  'You own',
  'Contracts consumed',
  'Interfaces',
  'Pattern to follow',
  'Steps',
  'Acceptance',
  'Security notes',
  'Documentation',
  'Report',
  'Never',
] as const

/** A brief field's label, which is also its heading in the issue body. */
export type BriefField = (typeof BRIEF_FIELDS)[number]

/** The model and effort values the template allows. Opus at max effort is not one of them. */
export const MODEL_VALUES: readonly string[] = [
  'Haiku at medium effort',
  'Haiku at high effort',
  'Haiku at max effort',
  'Opus at medium effort',
  'Opus at high effort',
]

const MODEL_SET: ReadonlySet<string> = new Set(MODEL_VALUES)

/** The label every brief carries. */
export const BRIEF_LABEL = 'brief'

/** The longest issue title GitHub accepts, in characters. */
const MAX_TITLE_LENGTH = 256

const TITLE_RANGE_HINT = `is longer than ${String(MAX_TITLE_LENGTH)} characters`

const text = z.string({ error: issue => (issue.input === undefined ? 'is missing' : 'must be text') })
  .trim()
  .min(1, { error: 'is empty' })

const fieldShape = Object.fromEntries(BRIEF_FIELDS.map(field => [field, text])) as Record<BriefField, typeof text>

/**
 * One brief as the briefs file holds it. Unknown keys are refused, so a misspelt field name is reported and is not
 * taken for a missing field.
 */
export const briefSchema = z.strictObject({
  ...fieldShape,
  title: text.max(MAX_TITLE_LENGTH, { error: TITLE_RANGE_HINT }),
  labels: z.array(text, { error: 'must be a list of label names' }).min(1, { error: 'lists no labels' }),
  milestone: text,
})

/** A brief whose fields passed the parser. Text values have their surrounding whitespace removed. */
export type Brief = z.infer<typeof briefSchema>

/** What a set of briefs is checked against: the tree's references and the defined labels. */
export interface BriefContext extends ReferenceContext {
  /** The label names that `.github/labels.yml` defines. */
  readonly labels: ReadonlySet<string>
}

/**
 * Parse the text of a briefs file.
 * @param json - the file's text: a JSON array of briefs.
 * @returns the parsed briefs, or none when any problem is found, and one message per problem.
 */
export function parseBriefs(json: string): { briefs: Brief[]; errors: string[] } {
  let value: unknown
  try {
    value = JSON.parse(json)
  } catch (error) {
    return { briefs: [], errors: [`the briefs file is not JSON: ${error instanceof Error ? error.message : String(error)}`] }
  }
  const parsed = z.array(briefSchema).safeParse(value)
  if (!parsed.success) return { briefs: [], errors: parsed.error.issues.map(describeIssue) }
  if (parsed.data.length === 0) return { briefs: [], errors: ['the briefs file holds no briefs'] }
  return { briefs: parsed.data, errors: [] }
}

/**
 * The message for one zod issue of the briefs file.
 * @param issue - the issue as zod reports it.
 * @returns the message, prefixed by the issue's position such as `briefs[0].Goal`.
 */
function describeIssue(issue: z.core.$ZodIssue): string {
  const location = issue.path.map(part => (typeof part === 'number' ? `[${String(part)}]` : `.${String(part)}`)).join('')
  if (issue.code === 'unrecognized_keys') return `briefs${location}: unknown key(s) ${issue.keys.join(', ')}`
  return `briefs${location} ${issue.message}`
}

/**
 * The problems with the label list of one brief.
 * @param labels - the brief's labels.
 * @param defined - the label names that `.github/labels.yml` defines.
 * @returns one message per problem; empty when the brief carries `brief` and only defined labels, none of them a kind.
 */
function labelProblems(labels: readonly string[], defined: ReadonlySet<string>): string[] {
  const problems: string[] = []
  if (!labels.includes(BRIEF_LABEL)) problems.push(`labels must include "${BRIEF_LABEL}"`)
  for (const label of labels) {
    if (!defined.has(label)) problems.push(`label "${label}" is not defined in ${LABELS_PATH}`)
    else if (label.startsWith('kind/')) problems.push(`label "${label}" marks a pull request; an issue carries its native Issue Type instead`)
  }
  return problems
}

/**
 * The problems with a set of parsed briefs: a model outside the template's values, a field that adds a heading to the
 * body, a reference that is not public or does not exist, an unknown or misplaced label, and a repeated title.
 * @param briefs - the briefs parsed from one file.
 * @param context - the tree's references and the defined labels.
 * @returns one message per problem, each naming the brief by its position; empty when every brief passes.
 */
export function briefErrors(briefs: readonly Brief[], context: BriefContext): string[] {
  const errors: string[] = []
  const firstIndex = new Map<string, number>()
  briefs.forEach((brief, index) => {
    const where = `briefs[${String(index)}]`
    const first = firstIndex.get(brief.title)
    if (first === undefined) firstIndex.set(brief.title, index)
    else errors.push(`${where}: title "${brief.title}" repeats briefs[${String(first)}]`)
    if (/[\r\n]/u.test(brief.title)) errors.push(`${where}: title is not one line`)
    for (const problem of referenceErrors(brief.title, context)) errors.push(`${where}: title: ${problem}`)
    if (!MODEL_SET.has(brief.Model)) errors.push(`${where}: Model "${brief.Model}" is not allowed; use one of: ${MODEL_VALUES.join(', ')}`)
    for (const field of BRIEF_FIELDS) {
      const value = brief[field]
      if (/^#{1,6}[ \t]/mu.test(value)) errors.push(`${where}: ${field}: a line is a Markdown heading; a field cannot add a heading to the issue body`)
      for (const problem of referenceErrors(value, context, { ownedPaths: field === OWNED_FIELD })) errors.push(`${where}: ${field}: ${problem}`)
    }
    for (const problem of labelProblems(brief.labels, context.labels)) errors.push(`${where}: ${problem}`)
  })
  return errors
}

/**
 * The issue body that a GitHub issue form submission would produce for a brief: each field under a `###` heading, in
 * the template's order, with the field's tracked references linked to the `main` branch.
 * @param brief - a parsed brief.
 * @param context - the tree's files and directories.
 * @returns the Markdown body, ending with one newline.
 */
export function renderBody(brief: Brief, context: ReferenceContext): string {
  return BRIEF_FIELDS.map(field => `### ${field}\n\n${linkReferences(brief[field], context)}\n`).join('\n')
}
