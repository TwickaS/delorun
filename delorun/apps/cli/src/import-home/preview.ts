/**
 * The preview and the report of a stock-home import, as lines for a terminal.
 * Every name, path and text that comes from the stock home is printed with
 * every control, bidirectional control and line separator escaped
 * ({@link quoted}, {@link printable}), so a name a model or a cloned
 * repository wrote cannot move the cursor, clear a line or reorder what a
 * person reads. A credential is named and never shown.
 *
 * The preview has two parts: the data the import copies after one yes (chats,
 * attachments, the workspace list), and the categories that can change what
 * Delorun runs or what the agent is told, each asked about on its own and off
 * unless the person says yes. Before each category's question, the command
 * shows the whole text that lands ({@link categoryText}), a screenful at a
 * time. Every workspace is named with its folder, never by its title alone.
 *
 * @module @delorun/cli/import-home/preview
 */
import {
  DSH_IMPORT_SKIP_REASONS,
  DSH_IMPORT_SKIP_SENTENCES,
  HOLD_SENTENCES,
  type DshHomeImportPlan,
  type DshHomeImportReport,
  type DshImportCategory,
  type DshImportLayer,
  type DshImportPlugin,
  type DshImportSkill,
  type DshImportSkip,
  type DshImportSkipReason,
} from '@delorun/archive/dsh-import'
import { printable, quoted } from '../terminal-text.ts'

/** The paths the preview names per reason before it says how many more there are. */
export const PREVIEW_EXAMPLES = 5

/** How each plugin status reads in the preview. */
const STATUS_LABELS: Readonly<Record<DshImportPlugin['status'], string>> = {
  carried: 'carried    ',
  install: 'to install ',
  added: 'added      ',
  'not-carried': 'not carried',
}

/** What each layer is, for the preview. */
const LAYER_LABELS: Readonly<Record<DshImportLayer['kind'], string>> = {
  'profile-patch': 'the profile\'s patch layer',
  'home-patch': 'the home patch, which applies to every profile',
  settings: 'settings from an earlier release, which the next start moves into the profile',
}

/**
 * A count with its noun.
 * @param count - the count.
 * @param noun - the singular noun.
 * @param plural - the plural noun, when it is not the singular with an s.
 * @returns `1 chat`, `2 chats`.
 */
export function counted(count: number, noun: string, plural = `${noun}s`): string {
  return `${String(count)} ${count === 1 ? noun : plural}`
}

/** What the preview covers. */
export interface PreviewOptions {
  /** The sentence after the credential names: how the person decides whether they are copied. */
  readonly credentials: string
  /** Whether the preview lists the categories; setup copies the data alone and names the command that copies the rest. */
  readonly categories: boolean
}

/**
 * The preview of one plan.
 * @param plan - the plan.
 * @param options - the credentials sentence and whether the categories are listed.
 * @returns the lines, ending with a newline.
 */
export function previewText(plan: DshHomeImportPlan, options: PreviewOptions): string {
  const lines = [
    `DeepSeek Harness home: ${quoted(plan.source)} (read only; nothing in it changes)`,
    `Delorun home: ${quoted(plan.target)}`,
    '',
    'Your chats and workspaces:',
    `  Chats: ${counted(plan.chats.filter(chat => chat.state === 'new').length, 'chat')} to copy${presentNote(plan.chats.filter(chat => chat.state === 'present').length)}`,
    `  Attachments: ${counted(plan.attachments.length, 'file')} to copy${presentNote(plan.attachmentsPresent)}`,
    `  Workspaces: ${workspaceLine(plan)}`,
    ...workspaceLines(plan),
    ...plan.chats.length === 0 ? [] : ['  A chat that ran with full access opens on the safer preset until you allow full access for its workspace in Delorun.'],
    ...unfinishedLines(plan, '  '),
    '',
    ...options.categories ? categoryLines(plan, options) : ['Profiles, settings, instructions, skills and stored keys are not copied here; run delorun import-home to review each and copy what you choose.'],
    ...skippedLines(plan),
  ]
  return `${lines.join('\n')}\n`
}

/**
 * The lines of every category.
 * @param plan - the plan.
 * @param options - the credentials sentence.
 * @returns a heading and each category's summary.
 */
function categoryLines(plan: DshHomeImportPlan, options: PreviewOptions): string[] {
  return [
    'Asked about one by one, and copied only if you say yes:',
    ...profileLines(plan),
    ...plan.layers.length === 0 ? ['  Settings: none to copy'] : ['  Settings:', ...plan.layers.flatMap(layer => layerLines(layer, '    '))],
    `  Instructions: ${instructionLine(plan)}`,
    ...plan.skills.length === 0
      ? ['  Skills: none to copy']
      : ['  Skills (a skill can tell the agent what to do and which commands to run):', ...plan.skills.map(skill => `    ${quoted(skill.path.slice('skills/'.length))}: ${counted(skill.files.length, 'file')}, ${counted(skill.bytes, 'byte')}${skill.description === undefined ? '' : `; ${quoted(skill.description)}`}`)],
    ...credentialLines(plan, options),
    `  In all ${counted(plan.bytes, 'byte')} to copy if you say yes to everything.`,
  ]
}

/**
 * The note of what the Delorun home already holds.
 * @param count - how many it holds.
 * @returns the note, or nothing when it holds none.
 */
function presentNote(count: number): string {
  return count === 0 ? '' : `; ${String(count)} already in the Delorun home`
}

/**
 * Every workspace of the stock list with its folder, what it carries, and why it is held back when it is.
 * @param plan - the plan.
 * @returns one line per workspace; none when the stock home holds no list.
 */
function workspaceLines(plan: DshHomeImportPlan): string[] {
  return (plan.registry?.listed ?? []).map(workspace => `    ${quoted(workspace.title)} at ${quoted(workspace.path)}: ${workspace.held === undefined
    ? counted(workspace.chats, 'chat')
    : `held back, with its chats: ${printable(workspace.held)}`}`)
}

/**
 * The workspace line.
 * @param plan - the plan.
 * @returns how the registrations land.
 */
function workspaceLine(plan: DshHomeImportPlan): string {
  if (plan.registry === undefined) return 'none to copy'
  const count = counted(plan.registry.workspaces, 'registration')
  if (plan.registry.mode === 'copy') return `${count}, copied as the Delorun home's workspace list`
  if (plan.registry.mode === 'merge') return `${count}, added to the Delorun home's workspace list`
  return `${count}, already in the Delorun home's workspace list`
}

/**
 * The lines of one layer: where its carried rows land and every row held back.
 * @param layer - the layer.
 * @param indent - the indentation.
 * @returns the lines.
 */
function layerLines(layer: DshImportLayer, indent: string): string[] {
  const lands = layer.state === 'taken'
    ? 'nothing lands: the Delorun home holds its own file of that name'
    : layer.state === 'present'
      ? 'already in the Delorun home'
      : layer.carried === undefined ? 'nothing lands' : `lands with ${counted(layer.carriedLabels.length, 'row')}${layer.carriedLabels.length === 0 ? '' : `: ${layer.carriedLabels.map(quoted).join(', ')}`}`
  return [
    `${indent}${quoted(layer.target)} (${LAYER_LABELS[layer.kind]}): ${lands}`,
    ...layer.expressions === 0 ? [] : [`${indent}  It holds ${counted(layer.expressions, '!!js expression')}; none of them is carried.`],
    ...layer.heldPath === undefined ? [] : [`${indent}  Held back, written where nothing reads it, ${quoted(layer.heldPath)}:`],
    ...layer.held.map(row => `${indent}    ${quoted(row.label)}: ${HOLD_SENTENCES[row.reason]}${row.detail === undefined ? '' : ` (${printable(row.detail)})`}`),
  ]
}

/**
 * The lines of every profile.
 * @param plan - the plan.
 * @returns a heading and each profile's packages, layers, notes and install command.
 */
function profileLines(plan: DshHomeImportPlan): string[] {
  if (plan.profiles.length === 0) return ['  Profiles: none to copy']
  return ['  Profiles (each keeps its name and loads no script, path or link of the stock profile):', ...plan.profiles.flatMap(profile => [
    `    ${quoted(profile.name)}:`,
    ...profile.plugins.map(plugin => `      ${STATUS_LABELS[plugin.status]}  ${quoted(plugin.name)} (${printable(plugin.note)})`),
    ...profile.patch === undefined ? [] : layerLines(profile.patch, '      '),
    ...profile.carry.map(note => `      ${printable(note)}`),
    ...profile.plugins.some(plugin => plugin.status === 'install')
      ? [`      After the import, delorun plugin --profile ${printable(profile.name)} install installs its plugins with pnpm. A plugin's install script runs only after you approve it.`]
      : [],
  ])]
}

/**
 * The instructions line.
 * @param plan - the plan.
 * @returns what lands.
 */
function instructionLine(plan: DshHomeImportPlan): string {
  const instructions = plan.instructions
  if (instructions === undefined) return 'none to copy'
  if (instructions.state === 'present') return `${quoted(instructions.source.file.path)}, already in the Delorun home`
  return `${quoted(instructions.source.file.path)}, ${counted(instructions.lines, 'line')}, which every chat reads; shown before you are asked`
}

/**
 * The credential lines.
 * @param plan - the plan.
 * @param options - the sentence after the names.
 * @returns the names with their states; the values are never read here.
 */
function credentialLines(plan: DshHomeImportPlan, options: PreviewOptions): string[] {
  if (plan.credentials === undefined || plan.credentials.entries.length === 0) return []
  const states = {
    offered: 'can be copied',
    present: 'already in the Delorun home',
    taken: 'not copied: the Delorun home holds another value',
    'not-carried': 'not copied: only the DeepSeek key is offered; add other keys again in Delorun',
  } as const
  return [
    `  Stored keys (${options.credentials}):`,
    ...plan.credentials.entries.map(entry => `    ${quoted(entry.name)}: ${states[entry.state]}`),
  ]
}

/**
 * The lines of what stays behind, grouped by reason.
 * @param plan - the plan, whose list is bounded per reason and whose totals count every entry.
 * @returns a heading and one group per reason, naming at most {@link PREVIEW_EXAMPLES} paths each.
 */
function skippedLines(plan: DshHomeImportPlan): string[] {
  const totals = DSH_IMPORT_SKIP_REASONS.flatMap((reason): [DshImportSkipReason, number][] => {
    const total = plan.skippedTotals[reason]
    return total === undefined ? [] : [[reason, total]]
  })
  if (totals.length === 0) return ['', 'Nothing is left behind.']
  const groups = new Map<DshImportSkipReason, DshImportSkip[]>()
  for (const entry of plan.skipped) groups.set(entry.reason, [...groups.get(entry.reason) ?? [], entry])
  return ['', 'What stays behind, and why:', ...totals.flatMap(([reason, total]) => {
    const entries = groups.get(reason) ?? []
    return [
      `  ${counted(total, 'entry', 'entries')}: ${DSH_IMPORT_SKIP_SENTENCES[reason]}`,
      ...entries.slice(0, PREVIEW_EXAMPLES).map(entry => `    ${quoted(entry.path)}${entry.detail === undefined ? '' : `: ${printable(entry.detail)}`}`),
      ...total > PREVIEW_EXAMPLES ? [`    and ${String(total - PREVIEW_EXAMPLES)} more`] : [],
    ]
  })]
}

/**
 * Whether a plan holds anything of one category to copy.
 * @param plan - the plan.
 * @param category - the category.
 * @returns true when a yes would land something.
 */
export function categoryOffered(plan: DshHomeImportPlan, category: DshImportCategory): boolean {
  switch (category) {
    case 'profiles':
      return plan.profiles.length > 0
    case 'settings':
      return plan.layers.some(layer => (layer.state === 'new' && layer.carried !== undefined) || layer.heldText !== undefined)
    case 'instructions':
      return plan.instructions?.state === 'new'
    case 'skills':
      return plan.skills.length > 0
    case 'credentials':
      return plan.credentials?.entries.some(entry => entry.state === 'offered') === true
  }
}

/**
 * The whole text one category lands, which a person reads before the question about it: each profile's manifest
 * and patch layer, each settings layer, and the instructions; for skills, each file with its size. Every line is
 * escaped. A skill's own instructions are shown on request ({@link skillInstructionLines}).
 * @param plan - the plan.
 * @param category - the category.
 * @returns the lines; empty when the preview already shows all of it.
 */
export function categoryText(plan: DshHomeImportPlan, category: DshImportCategory): string[] {
  switch (category) {
    case 'profiles':
      return plan.profiles.flatMap(profile => [
        `${quoted(`profiles/${profile.name}/package.json`)} lands as:`,
        ...textLines(profile.manifest),
        ...profile.patch?.carried === undefined ? [] : [`${quoted(profile.patch.target)} lands as:`, ...textLines(profile.patch.carried)],
      ])
    case 'settings':
      return plan.layers.flatMap(layer => layer.state !== 'new' || layer.carried === undefined
        ? []
        : [`${quoted(layer.target)} lands as:`, ...textLines(layer.carried)])
    case 'instructions': {
      const instructions = plan.instructions as NonNullable<DshHomeImportPlan['instructions']>
      return [`${quoted(instructions.source.file.path)} in full:`, ...textLines(instructions.text)]
    }
    case 'skills':
      return plan.skills.flatMap(skill => [
        `${quoted(skill.path)}:`,
        ...skill.files.map(file => `  ${quoted(file.path.slice(skill.path.length + 1))}: ${counted(file.size, 'byte')}`),
      ])
    case 'credentials':
      return []
  }
}

/**
 * The whole text of one skill's instructions, escaped.
 * @param skill - the skill.
 * @returns its `SKILL.md` with a heading, or one line saying it holds none.
 */
export function skillInstructionLines(skill: DshImportSkill): string[] {
  if (skill.instructions === undefined) return [`${quoted(skill.path)} holds no SKILL.md.`]
  return [`${quoted(`${skill.path}/SKILL.md`)} in full:`, ...textLines(skill.instructions)]
}

/**
 * A text's lines, each escaped and marked as quoted text.
 * @param text - the text.
 * @returns one line per line of the text, without a last empty one.
 */
function textLines(text: string): string[] {
  const lines = text.split(/\r?\n/u)
  if (lines.at(-1) === '') lines.pop()
  return lines.map(line => `  | ${printable(line)}`)
}

/**
 * The question about one category.
 * @param plan - the plan.
 * @param category - the category.
 * @returns the question, ending with the default no.
 */
export function categoryQuestion(plan: DshHomeImportPlan, category: DshImportCategory): string {
  switch (category) {
    case 'profiles':
      return `Copy ${counted(plan.profiles.length, 'profile')} as shown, with their held-back rows written where nothing reads them? [y/N] `
    case 'settings':
      return 'Copy these settings into the Delorun home, with the held-back rows written where nothing reads them? [y/N] '
    case 'instructions':
      return 'Copy these instructions? Every chat in Delorun reads them. [y/N] '
    case 'skills':
      return `Copy ${counted(plan.skills.length, 'skill')}? A skill can tell the agent what to do. [y/N] `
    case 'credentials': {
      const offered = plan.credentials?.entries.filter(entry => entry.state === 'offered') ?? []
      return `Copy ${counted(offered.length, 'stored key')} (${offered.map(entry => printable(entry.name)).join(', ')}) into the Delorun home's credentials document, readable by you alone? [y/N] `
    }
  }
}

/**
 * The lines about the chats that stay behind because their log ends inside a turn, and where the person can still read
 * them.
 * @param plan - the plan.
 * @param indent - the indentation.
 * @returns the lines, none when no chat stopped inside a turn.
 */
function unfinishedLines(plan: DshHomeImportPlan, indent: string): string[] {
  const count = plan.skippedTotals['unfinished-turn'] ?? 0
  if (count === 0) return []
  return [`${indent}${counted(count, 'chat')} stopped in the middle of a turn and ${count === 1 ? 'stays' : 'stay'} behind, because continuing ${count === 1 ? 'it' : 'them'} here would offer ${count === 1 ? 'its' : 'their'} unfinished tool calls for retry. You can still read ${count === 1 ? 'it' : 'them'} in DeepSeek Harness, whose home ${quoted(plan.source)} the import leaves untouched; finish or close ${count === 1 ? 'it' : 'them'} there and import again to bring ${count === 1 ? 'it' : 'them'} over.`]
}

/**
 * The report of a completed import.
 * @param report - what the import did.
 * @param plan - the plan it carried out, for the next steps.
 * @returns the lines, ending with a newline.
 */
export function reportText(report: DshHomeImportReport, plan: DshHomeImportPlan): string {
  const install = plan.profiles.filter(profile => report.profiles.includes(profile.name) && profile.plugins.some(plugin => plugin.status === 'install'))
  const lines = [
    `Imported ${counted(report.chats, 'chat')}, ${counted(report.attachments, 'attachment file')}, ${counted(report.workspaces.mode === 'present' || report.workspaces.mode === 'none' ? 0 : report.workspaces.count, 'workspace registration')}, ${counted(report.profiles.length, 'profile')}, ${counted(report.documents.length, 'document')}, ${counted(report.skills, 'skill')} and ${counted(report.credentials.length, 'stored key')}.`,
    `${counted(report.skipped, 'entry', 'entries')} stayed behind. The DeepSeek Harness home was only read, and still holds everything.`,
    ...unfinishedLines(plan, ''),
    ...report.held.length === 0 ? [] : [`Held-back rows are in ${report.held.map(quoted).join(', ')}; nothing there takes effect.`],
    ...install.map(profile => `To install the plugins of the profile ${quoted(profile.name)}: delorun plugin --profile ${printable(profile.name)} install`),
    ...report.profiles.map(name => `To start the profile ${quoted(name)}: delorun --profile ${printable(name)}`),
  ]
  return `${lines.join('\n')}\n`
}
