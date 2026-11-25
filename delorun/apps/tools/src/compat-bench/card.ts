/**
 * The compatibility card, `delorun.compat-card/1`: what one run of the bench saw for one plugin on one host. This module
 * holds the schema and its validator, the verdict rule, the Markdown render of a card (the public one leaves out what is
 * under embargo, A570 and L154) and the one-row render the table uses. Wording says what was seen, never what is
 * allowed or what a plugin can only do (L141); the independence line is A574's.
 *
 * @module @delorun/tools/compat-bench/card
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import type { Marker, StageName } from './observer.ts'

/** The schema identifier every card carries. */
export const CARD_SCHEMA = 'delorun.compat-card/1'

/** A574's public line: the one wording of the independence claim, shortened but keeping its disclaimer. */
export const INDEPENDENCE_LINE = 'Delorun is an independent, community-driven continuation of DeepSeek Harness. Delorun is not a DeepSeek product, and DeepSeek does not endorse it.'

/** The fixed line under the privacy markers (A587). */
export const PRIVACY_LINE = 'Plugins run with Delorun\'s full access. Markers show what it did, not what it could.'

/** What a card says when no observer ran. */
export const PRIVACY_NOT_RECORDED = 'privacy markers not recorded'

/** The stages of a run, in order. */
export const STAGE_NAMES = ['install', 'start', 'harness', 'screens', 'feature', 'restart', 'update', 'clashes', 'cost', 'uninstall'] as const satisfies readonly StageName[]

/** The fix classes of a failure. */
export const FIX_CLASSES = ['delorun-fix', 'delorun-shim', 'upstream', 'by-design', 'parked'] as const

/** The verdicts of a card. */
export const VERDICTS = ['works', 'works-partly-tested', 'works-with-delorun-fix', 'blocked', 'by-design', 'parked'] as const

/** The words of each verdict in the table and the card. */
export const VERDICT_WORDS: Readonly<Record<(typeof VERDICTS)[number], string>> = {
  works: 'Worked in the test',
  'works-partly-tested': 'Worked in the test, partly tested',
  'works-with-delorun-fix': 'Works once a Delorun fix lands',
  blocked: 'Did not work in the test',
  'by-design': 'Differs by design',
  parked: 'Parked',
}

/** One cause from `causes.json`. */
export interface Cause {
  /** The kebab-case id the cards name. */
  readonly id: string
  /** What the cause means, in a sentence. */
  readonly summary: string
  /** The fix class a failure with this cause usually has. */
  readonly fixClass: (typeof FIX_CLASSES)[number]
}

/**
 * Read the cause list that ships beside this module.
 * @returns the causes.
 */
export function loadCauses(): readonly Cause[] {
  const path = join(dirname(fileURLToPath(import.meta.url)), 'causes.json')
  return z.array(z.strictObject({ id: z.string().regex(/^[a-z][a-z0-9-]*$/), summary: z.string().min(1), fixClass: z.enum(FIX_CLASSES) })).parse(JSON.parse(readFileSync(path, 'utf8')))
}

const fixClass = z.enum(FIX_CLASSES)
const failure = z.strictObject({
  signature: z.string().min(1),
  evidence: z.array(z.string()),
  cause: z.string().min(1),
  fixClass,
  /** The plugin's file and line when the evidence points at one. */
  location: z.string().optional(),
  /** True when this item is a real undocumented flaw held back under A570: the public render omits it. */
  embargoed: z.boolean().optional(),
})

const stage = z.strictObject({
  name: z.enum(STAGE_NAMES),
  status: z.enum(['pass', 'fail', 'skipped', 'not-applicable']),
  /** Why a stage was skipped or does not apply. */
  reason: z.string().optional(),
  durationMs: z.number().int().nonnegative(),
  failures: z.array(failure).default([]),
  /** Short facts the stage measured, for example the screen sizes. */
  facts: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
  /** Screenshot paths relative to the run folder. */
  shots: z.array(z.string()).optional(),
})

const marker = z.strictObject({ state: z.enum(['not-seen', 'seen', 'declared', 'not-checked']), summary: z.string(), evidence: z.array(z.string()) })
const markerKeys = ['code', 'chats', 'modelKeys', 'otherSecrets', 'sendsOut', 'actsForYou', 'opensADoor', 'leavesBehind'] as const
const privacy = z.strictObject({
  markers: z.strictObject(Object.fromEntries(markerKeys.map(key => [key, marker])) as Record<(typeof markerKeys)[number], typeof marker>),
  contentsChecked: z.boolean(),
  /** What was seen but not declared, in words. */
  findings: z.array(z.string()).optional(),
  declared: z.partialRecord(z.enum(markerKeys), z.string()).optional(),
})

/** The card's schema. */
export const cardSchema = z.strictObject({
  schema: z.literal(CARD_SCHEMA),
  runId: z.string().min(1),
  startedAt: z.iso.datetime(),
  plugin: z.strictObject({
    package: z.string().min(1),
    version: z.string().optional(),
    integrity: z.string().optional(),
    repository: z.string().optional(),
    licence: z.string().optional(),
    engines: z.strictObject({ delorun: z.string().optional(), dsh: z.string().optional() }).optional(),
    /** The npm downloads in the last month when the board asked for them; kept for the board's ranking. */
    downloads: z.number().int().nonnegative().optional(),
  }),
  host: z.strictObject({
    kind: z.enum(['delorun', 'delorun-prev', 'stock']),
    version: z.string().min(1),
    commit: z.string().optional(),
    shims: z.boolean(),
  }),
  stages: z.array(stage).min(1),
  privacy: privacy.optional(),
  /** What the author declared in the optional `dsh.access` block (A553). */
  declared: z.record(z.string(), z.unknown()).optional(),
  verdict: z.enum(VERDICTS),
  notes: z.array(z.string()).default([]),
  /** The date (YYYY-MM-DD) until which a real undocumented flaw is held back (A570, L154); the public render omits the card's details until then. */
  embargo: z.iso.date().optional(),
})

/** One failure of a stage. */
export type StageFailure = z.infer<typeof failure>
/** One stage of a run. */
export type StageResult = z.infer<typeof stage>
/** A card. */
export type Card = z.infer<typeof cardSchema>
/** A card's verdict. */
export type Verdict = (typeof VERDICTS)[number]

/**
 * Check a parsed card against the schema and the cause list.
 * @param value - the parsed JSON.
 * @param causes - the causes a failure may name; the shipped list by default.
 * @returns the card, or the list of problems, one line each.
 */
export function validateCard(value: unknown, causes: readonly Cause[] = loadCauses()): { readonly ok: true, readonly card: Card } | { readonly ok: false, readonly problems: readonly string[] } {
  const parsed = cardSchema.safeParse(value)
  if (!parsed.success) return { ok: false, problems: parsed.error.issues.map(issue => `${issue.path.join('.') || '(card)'}: ${issue.message}`) }
  const known = new Set(causes.map(cause => cause.id))
  const problems: string[] = []
  const seen = new Set<string>()
  for (const each of parsed.data.stages) {
    if (seen.has(each.name)) problems.push(`stages.${each.name}: appears twice`)
    seen.add(each.name)
    if (each.status === 'fail' && each.failures.length === 0) problems.push(`stages.${each.name}: a failed stage names at least one failure`)
    if ((each.status === 'skipped' || each.status === 'not-applicable') && (each.reason ?? '') === '') problems.push(`stages.${each.name}: ${each.status} needs a reason`)
    for (const one of each.failures) if (!known.has(one.cause)) problems.push(`stages.${each.name}: unknown cause "${one.cause}"`)
  }
  return problems.length > 0 ? { ok: false, problems } : { ok: true, card: parsed.data }
}

/**
 * The verdict a set of stages earns.
 * @param stages - the stage results.
 * @returns `works` when every stage passed or does not apply; `works-partly-tested` when the rest passed and some stage was skipped; for failures, `by-design` or `parked` when every failure is of that class, `works-with-delorun-fix` when the plugin installed, started and answered a chat and every failure is Delorun's to fix or shim, otherwise `blocked`.
 */
export function deriveVerdict(stages: readonly StageResult[]): Verdict {
  const failures = stages.flatMap(each => each.failures.map(one => ({ stage: each.name, ...one })))
  if (failures.length === 0 && !stages.some(each => each.status === 'fail')) return stages.some(each => each.status === 'skipped') ? 'works-partly-tested' : 'works'
  if (failures.length > 0 && failures.every(one => one.fixClass === 'by-design')) return 'by-design'
  if (failures.length > 0 && failures.every(one => one.fixClass === 'parked')) return 'parked'
  const core = ['install', 'start', 'harness'] as const
  const coreFailed = stages.some(each => (core as readonly string[]).includes(each.name) && each.status === 'fail')
  const delorunOnly = failures.length > 0 && failures.every(one => one.fixClass === 'delorun-fix' || one.fixClass === 'delorun-shim' || one.fixClass === 'by-design')
  return !coreFailed && delorunOnly ? 'works-with-delorun-fix' : 'blocked'
}

/** The labels of the privacy markers, in the order the card shows them (A587). */
export const MARKER_LABELS: Readonly<Record<(typeof markerKeys)[number], string>> = {
  code: 'Your code',
  chats: 'Your chats',
  modelKeys: 'Model keys',
  otherSecrets: 'Other secrets',
  sendsOut: 'Sends out',
  actsForYou: 'Acts for you',
  opensADoor: 'Opens a door',
  leavesBehind: 'Leaves behind',
}

/** The words of each marker state. */
export const MARKER_STATE_WORDS: Readonly<Record<Marker['state'], string>> = {
  'not-seen': 'not seen',
  seen: 'seen in test',
  declared: 'declared by author',
  'not-checked': 'contents not checked',
}

/**
 * Whether a card's embargo still holds.
 * @param card - the card.
 * @param now - the time to compare with.
 * @returns true when the card has an embargo date that is today or later.
 */
export function embargoActive(card: Card, now: Date): boolean {
  return card.embargo !== undefined && card.embargo >= now.toISOString().slice(0, 10)
}

/**
 * The line that says which run a card is from.
 * @param card - the card.
 * @returns for example `Seen in one test run (stages 1–10, shims off)`.
 */
function runHeader(card: Card): string {
  const ran = card.stages.filter(each => each.status === 'pass' || each.status === 'fail').length
  return `Seen in one test run (${String(ran)} of ${String(card.stages.length)} stages run, shims ${card.host.shims ? 'on' : 'off'})`
}

/**
 * Render a card's privacy section.
 * @param section - the section, or undefined when no observer ran.
 * @returns Markdown lines.
 */
function renderPrivacy(section: z.infer<typeof privacy> | undefined): string[] {
  if (section === undefined) return ['## Privacy', '', `_${PRIVACY_NOT_RECORDED}._`]
  const lines = ['## Privacy', '', `_${PRIVACY_LINE}_`, '', '| Marker | What was seen |', '| --- | --- |']
  for (const key of markerKeys) {
    const one = section.markers[key]
    lines.push(`| ${MARKER_LABELS[key]} | ${MARKER_STATE_WORDS[one.state]}${one.summary === '' ? '' : `: ${one.summary}`} |`)
  }
  const details = markerKeys.filter(key => section.markers[key].evidence.length > 0)
  if (details.length > 0) {
    lines.push('', '<details><summary>Details</summary>', '')
    for (const key of details) lines.push(`- **${MARKER_LABELS[key]}**: ${section.markers[key].evidence.join('; ')}`)
    lines.push('', '</details>')
  }
  if (!section.contentsChecked) lines.push('', 'Contents of encrypted traffic were not checked.')
  return lines
}

/**
 * Render a card as Markdown.
 * @param card - the card.
 * @param options - `public` leaves out what is under embargo (A570, L154); `now` is the clock for the embargo date.
 * @returns the Markdown text.
 */
export function renderCard(card: Card, options: { readonly public?: boolean, readonly now?: Date } = {}): string {
  const held = options.public === true && embargoActive(card, options.now ?? new Date())
  const name = `${card.plugin.package}${card.plugin.version === undefined ? '' : `@${card.plugin.version}`}`
  const hostName = card.host.kind === 'stock' ? `stock DSH ${card.host.version}` : `Delorun ${card.host.version}${card.host.kind === 'delorun-prev' ? ' (previous release)' : ''}`
  const lines = [`# ${name} on ${hostName}`, '']
  if (options.public === true) lines.push(`_${INDEPENDENCE_LINE}_`, '')
  if (held) {
    lines.push(`**${VERDICT_WORDS.parked}.** Details are held back until ${card.embargo ?? ''}.`, '')
    return `${lines.join('\n')}\n`
  }
  lines.push(`**${VERDICT_WORDS[card.verdict]}.** ${runHeader(card)}.`, '')
  if (card.plugin.repository !== undefined || card.plugin.licence !== undefined || card.plugin.engines !== undefined) {
    lines.push('| Plugin | |', '| --- | --- |')
    if (card.plugin.repository !== undefined) lines.push(`| Repository | ${card.plugin.repository} |`)
    if (card.plugin.licence !== undefined) lines.push(`| Licence | ${card.plugin.licence} |`)
    if (card.plugin.integrity !== undefined) lines.push(`| Integrity | \`${card.plugin.integrity}\` |`)
    if (card.plugin.engines?.delorun !== undefined) lines.push(`| engines.delorun | \`${card.plugin.engines.delorun}\` |`)
    if (card.plugin.engines?.dsh !== undefined) lines.push(`| engines.dsh | \`${card.plugin.engines.dsh}\` |`)
    lines.push('')
  }
  lines.push('## Stages', '', '| Stage | Result | Time | What was seen |', '| --- | --- | --- | --- |')
  for (const each of card.stages) {
    const shown = each.failures.filter(one => options.public !== true || one.embargoed !== true)
    const withheld = each.failures.length - shown.length
    const detail = [
      ...(each.reason === undefined ? [] : [each.reason]),
      ...shown.map(one => `${one.cause}: ${one.signature}${one.location === undefined ? '' : ` (${one.location})`}`),
      ...(withheld > 0 ? [`${String(withheld)} item${withheld === 1 ? '' : 's'} held back`] : []),
      ...Object.entries(each.facts ?? {}).map(([key, value]) => `${key} ${String(value)}`),
    ].join('; ')
    lines.push(`| ${each.name} | ${each.status} | ${(each.durationMs / 1000).toFixed(1)} s | ${detail.replaceAll('|', '\\|')} |`)
  }
  const shots = card.stages.flatMap(each => each.shots ?? [])
  if (shots.length > 0) lines.push('', '## Screenshots', '', ...shots.map(path => `![${path}](${path})`))
  const evidence = card.stages.flatMap(each => each.failures.filter(one => (options.public !== true || one.embargoed !== true) && one.evidence.length > 0).map(one => ({ stage: each.name, one })))
  if (evidence.length > 0) {
    lines.push('', '<details><summary>Evidence</summary>', '')
    for (const { stage: stageName, one } of evidence) lines.push(`- **${stageName}, ${one.cause}** (${one.fixClass}): ${one.evidence.join(' | ')}`)
    lines.push('', '</details>')
  }
  lines.push('', ...renderPrivacy(card.privacy))
  if (card.declared !== undefined) lines.push('', '## Declared by the author', '', '```json', JSON.stringify(card.declared, null, 2), '```')
  const notes = options.public === true ? card.notes.filter(note => !/^embargoed:/i.test(note)) : card.notes
  if (notes.length > 0) lines.push('', '## Notes', '', ...notes.map(note => `- ${note}`))
  return `${lines.join('\n')}\n`
}

/**
 * The main cause of a card: the first failure's cause, in stage order.
 * @param card - the card.
 * @returns the cause id, or undefined when nothing failed.
 */
export function mainCause(card: Card): string | undefined {
  return card.stages.flatMap(each => each.failures)[0]?.cause
}
