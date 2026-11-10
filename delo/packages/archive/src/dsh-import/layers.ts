/**
 * The configuration layers of a stock home, split into what the import carries
 * and what it holds back. A layer is data: a profile's `cordis.patch.yml`, the
 * home patch, which applies over every profile, the CLI profile's included,
 * and the earlier `settings.yaml`, whose sections the next start writes into
 * the active profile. Each is parsed and never evaluated.
 *
 * What lands is decided by an allow list, never by matching names against
 * what looks dangerous. A row lands only when it is an `id` with a `config`
 * whose every setting is a pair of that id and a setting path in
 * {@link CARRIED_SETTINGS}, with a plain value: the looks and layout of the
 * studio, the language, and the default model chosen by name. A font family
 * holds letters, digits, spaces, commas, hyphens and quotes alone, because the
 * studio writes it into its styles. Every other row
 * is held back: a row or section the list does not name, a setting the list
 * does not name for that row, a `disabled` flag, a plugin swap, an inserted
 * row of any package, an expression or a loader tag anywhere, and any value
 * that is not a short plain string, a number or a boolean. A layer that cannot
 * be split safely, because it does not parse, uses anchors, aliases or merge
 * keys, or is not the list or map its loader reads, is held back whole. Held
 * rows are written to an inert file no loader reads, so nothing held back
 * takes effect until the person applies it.
 *
 * @module @delo/archive/dsh-import/layers
 */
import { Document, isMap, isPair, isScalar, isSeq, parseDocument, stringify, visit, type Node, type YAMLMap, type YAMLSeq } from 'yaml'
import { hasControlCharacter } from '../text.ts'

/** Why a row or a whole layer is held back. */
export type HoldReason =
  | 'expression'
  | 'code'
  | 'plugin-swap'
  | 'not-understood'
  | 'unparseable'
  | 'anchors'
  | 'shape'
  | 'taken'

/** One sentence per reason, which the preview prints after the row. */
export const HOLD_SENTENCES: Readonly<Record<HoldReason, string>> = {
  expression: 'it holds a !!js expression, which runs when the profile starts',
  code: 'it loads a plugin row, which the import never carries; add it again yourself if you trust it',
  'plugin-swap': 'it changes which plugin a row loads',
  'not-understood': 'it is not one of the settings the import carries: the studio\'s looks and layout, the language and the default model by name',
  unparseable: 'the file is not YAML the import reads',
  anchors: 'the file uses YAML anchors, aliases or merge keys, so its rows cannot be told apart safely',
  shape: 'the file is not the list of rows, or the map of sections, its loader reads',
  taken: 'the Delo home holds its own file of that name, which the import never replaces',
}

/** One held-back row, as the preview lists it. */
export interface HeldRow {
  /** The row's id, inserted plugin name or settings section, or its position when it names none. */
  readonly label: string
  /** Why it is held back. */
  readonly reason: HoldReason
  /** What the reason is about, such as the setting the list does not name. */
  readonly detail?: string
}

/** One layer, split. */
export interface SplitLayer {
  /** The layer as it lands: the carried rows only, or `undefined` when the whole layer is held back. */
  readonly carried: string | undefined
  /** The carried rows, by id or section. */
  readonly carriedLabels: readonly string[]
  /** The held-back rows; for a layer held back whole, one entry naming the file's reason. */
  readonly held: readonly HeldRow[]
  /** The held-back rows as YAML with the reason before each, for the inert file; `undefined` when nothing is held back. */
  readonly heldText: string | undefined
  /** The `!!js` expressions the layer holds. */
  readonly expressions: number
}

/**
 * The settings the import carries, by row id: each a `.`-separated path inside the row's `config`. They hold data a
 * person chose and nothing that decides what runs, where requests go or what a guard allows: the studio's theme and
 * fonts, how the chat and the composer show things, the language, and the default model by provider and model name.
 * Every row and setting not named here is held back.
 */
export const CARRIED_SETTINGS: Readonly<Record<string, readonly string[]>> = {
  'ui-theme': ['preference', 'fontSize', 'codeFontSize', 'terminalFontSize', 'textFontFamily', 'codeFontFamily', 'terminalFontFamily'],
  locale: ['preference'],
  'ui-chat': [
    'transcriptView',
    'collapseTiming',
    'foldedReplies',
    'performanceUsage',
    'linkOpening',
    'customDisplay.thinking',
    'customDisplay.thinkingWindowLines',
    'customDisplay.stepGrouping',
    'customDisplay.liveProcessDetail',
    'customDisplay.openTerminalCards',
    'customDisplay.foldCompletedTurns',
  ],
  'ui-conversation': ['busyEnter'],
  'agent-default-model': ['provider', 'model', 'reasoningEffort'],
}

/** The longest string a carried setting holds: a font family, a model name. */
const MAX_SETTING_TEXT = 200

/**
 * The text a carried font family may hold, which the studio writes into its styles: letters, digits, spaces, commas,
 * hyphens and quotes, at most 100 characters, so it names fonts and can carry nothing a style sheet would read as more.
 */
const FONT_FAMILY = /^[A-Za-z0-9 ,'"-]{0,100}$/u

/** The settings whose text the studio writes into its styles, by row id and setting path. */
const STYLE_SETTINGS: ReadonlySet<string> = new Set(['ui-theme.textFontFamily', 'ui-theme.codeFontFamily', 'ui-theme.terminalFontFamily'])

/**
 * Whether one setting of one row is on the allow list.
 * @param id - the row id or settings section.
 * @param path - the setting's `.`-separated path inside the row's `config`.
 * @returns true when {@link CARRIED_SETTINGS} names it.
 */
export function isCarriedSetting(id: string, path: string): boolean {
  return Object.hasOwn(CARRIED_SETTINGS, id) && (CARRIED_SETTINGS[id] as readonly string[]).includes(path)
}

/**
 * The first setting of a row's `config` the import does not carry.
 * @param id - the row id or settings section.
 * @param config - the row's parsed `config`.
 * @param prefix - the path of `config` inside the row's settings.
 * @returns the setting's path, or `undefined` when every setting is on the allow list with a plain value.
 */
function uncarriedSetting(id: string, config: unknown, prefix = ''): string | undefined {
  if (typeof config !== 'object' || config === null || Array.isArray(config)) return '(its settings are not a map)'
  for (const [key, value] of Object.entries(config)) {
    const path = prefix === '' ? key : `${prefix}.${key}`
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      const inner = uncarriedSetting(id, value, path)
      if (inner !== undefined) return inner
    } else if (!isCarriedSetting(id, path) || !isPlainValue(value) || (STYLE_SETTINGS.has(`${id}.${path}`) && !FONT_FAMILY.test(String(value)))) {
      return path
    }
  }
  return undefined
}

/**
 * Whether a setting's value is plain: a boolean, a finite number, or a short string without a control character.
 * @param value - the value.
 * @returns true for such a value.
 */
function isPlainValue(value: unknown): boolean {
  if (typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  return typeof value === 'string' && value.length <= MAX_SETTING_TEXT && !hasControlCharacter(value)
}

/**
 * Whether a node holds a `!!js` or `!js` tag at any depth.
 * @param node - a YAML node.
 * @returns how many tagged nodes it holds.
 */
function expressionsIn(node: unknown): number {
  let count = 0
  visit(new Document(node), {
    Node(_key, inner) {
      if (inner.tag === 'tag:yaml.org,2002:js' || inner.tag === '!js') count += 1
    },
  })
  return count
}

/** The tags of plain values, which a carried row may name explicitly. */
const PLAIN_TAGS: ReadonlySet<string> = new Set(['str', 'int', 'float', 'bool', 'null', 'seq', 'map'].map(name => `tag:yaml.org,2002:${name}`))

/**
 * Whether a node holds an explicit tag other than a plain value's at any depth, such as a loader's own tag.
 * @param node - a YAML node.
 * @returns true when it holds one.
 */
function hasForeignTag(node: unknown): boolean {
  let foreign = false
  visit(new Document(node), {
    Node(_key, inner) {
      if (inner.tag !== undefined && !PLAIN_TAGS.has(inner.tag)) foreign = true
    },
  })
  return foreign
}

/**
 * Parse one layer, refusing what cannot be split safely.
 * @param text - the layer's text.
 * @returns the document, or the reason the whole layer is held back.
 */
function parseLayer(text: string): Document | HoldReason {
  const document = parseDocument(text, { uniqueKeys: true, merge: false, logLevel: 'error' })
  if (document.errors.length > 0) return 'unparseable'
  let shared = false
  visit(document, {
    Alias() { shared = true },
    Node(_key, node) { if (node.anchor !== undefined) shared = true },
    Pair(_key, pair) { if (isScalar(pair.key) && pair.key.value === '<<') shared = true },
  })
  return shared ? 'anchors' : document
}

/**
 * Split one patch layer: a profile's `cordis.patch.yml` or the home patch.
 * @param text - the layer's text, read through the guarded reader.
 * @returns the carried layer, the held rows and their inert file.
 */
export function splitPatchLayer(text: string): SplitLayer {
  const document = parseLayer(text)
  if (typeof document === 'string') return wholeHeld(text, document)
  const root = document.contents
  if (root === null) return { carried: '[]\n', carriedLabels: [], held: [], heldText: undefined, expressions: 0 }
  if (!isSeq(root)) return wholeHeld(text, 'shape')
  const carried: unknown[] = []
  const carriedLabels: string[] = []
  const held: { row: HeldRow, node: unknown }[] = []
  root.items.forEach((node, index) => {
    const label = rowLabel(node, index)
    const reason = rowHold(node)
    if (reason === undefined) {
      carried.push((node as Node).toJSON())
      carriedLabels.push(label)
    } else {
      held.push({ row: { label, ...reason }, node })
    }
  })
  return {
    carried: stringify(carried),
    carriedLabels,
    held: held.map(entry => entry.row),
    heldText: heldDocument(held, (seq, node) => { (seq as YAMLSeq).items.push(node) }, []),
    expressions: expressionsIn(root),
  }
}

/**
 * Split the earlier settings document, whose sections the next start writes into the active profile's rows.
 * @param text - the document's text, read through the guarded reader.
 * @returns the carried sections, the held sections and their inert file.
 */
export function splitSettingsLayer(text: string): SplitLayer {
  const document = parseLayer(text)
  if (typeof document === 'string') return wholeHeld(text, document)
  const root = document.contents
  if (root === null) return { carried: '{}\n', carriedLabels: [], held: [], heldText: undefined, expressions: 0 }
  if (!isMap(root)) return wholeHeld(text, 'shape')
  const carried: Record<string, unknown> = {}
  const carriedLabels: string[] = []
  const held: { row: HeldRow, node: unknown }[] = []
  for (const pair of (root as YAMLMap).items) {
    const label = isScalar(pair.key) ? String(pair.key.value) : '(a section without a name)'
    const reason = !isScalar(pair.key) || typeof pair.key.value !== 'string' ? { reason: 'not-understood' as const, detail: 'a section without a name' } : sectionHold(label, pair.value)
    if (reason === undefined) {
      carried[label] = (pair.value as Node).toJSON()
      carriedLabels.push(label)
    } else {
      held.push({ row: { label, ...reason }, node: pair })
    }
  }
  return {
    carried: stringify(carried),
    carriedLabels,
    held: held.map(entry => entry.row),
    heldText: heldDocument(held, (map, pair) => { (map as YAMLMap).items.push(pair as never) }, {}),
    expressions: expressionsIn(root),
  }
}

/**
 * A layer held back whole.
 * @param text - the layer's text.
 * @param reason - why.
 * @returns the split, which carries nothing.
 */
export function wholeHeld(text: string, reason: HoldReason): SplitLayer {
  const expressions = (text.match(/!!?js\b/gu) ?? []).length
  return {
    carried: undefined,
    carriedLabels: [],
    held: [{ label: 'the whole file', reason }],
    heldText: `# Held back by the import of a DeepSeek Harness home: ${HOLD_SENTENCES[reason]}.\n# Nothing here takes effect. Review it, and copy what you want into your own file.\n${text}`,
    expressions,
  }
}

/**
 * The inert file of a layer's held rows.
 * @param held - the held rows with their nodes.
 * @param add - adds one node to the collection.
 * @param empty - the empty collection the layer's root is.
 * @returns the file's text, or `undefined` when nothing is held back.
 */
function heldDocument(held: readonly { row: HeldRow, node: unknown }[], add: (collection: unknown, node: unknown) => void, empty: unknown[] | Record<string, never>): string | undefined {
  if (held.length === 0) return undefined
  const document = new Document(empty)
  for (const { row, node } of held) {
    const target = isPair(node) ? node.key as Node : node as Node
    target.commentBefore = ` held back: ${HOLD_SENTENCES[row.reason]}${row.detail === undefined ? '' : ` (${row.detail})`}`
    add(document.contents, node)
  }
  document.commentBefore = ' Held back by the import of a DeepSeek Harness home. Nothing here takes effect.\n Review each row, and copy what you want into your own file.'
  return document.toString()
}

/**
 * The name the preview gives a row.
 * @param node - the row's node.
 * @param index - its position in the layer.
 * @returns its id, else the first inserted plugin's name, else its position.
 */
function rowLabel(node: unknown, index: number): string {
  if (isMap(node)) {
    const id = node.get('id')
    if (typeof id === 'string') return id
    const insert = node.get('insert')
    if (isSeq(insert)) {
      const first = insert.items[0]
      if (isMap(first) && typeof first.get('name') === 'string') return `insert ${String(first.get('name'))}`
    }
  }
  return `row ${String(index + 1)}`
}

/** The fields of a patch row the import reads. */
const ROW_FIELDS = new Set(['id', 'config', 'disabled', 'insert', 'name'])

/**
 * Why one patch row is held back.
 * @param node - the row's node.
 * @returns the reason and its detail, or `undefined` when the row is carried.
 */
function rowHold(node: unknown): { readonly reason: HoldReason, readonly detail?: string } | undefined {
  if (expressionsIn(node) > 0) return { reason: 'expression' }
  if (hasForeignTag(node)) return { reason: 'not-understood', detail: 'a tag' }
  if (!isMap(node) || !node.items.every(pair => isScalar(pair.key) && ROW_FIELDS.has(String(pair.key.value)))) return { reason: 'not-understood', detail: 'a field a row does not hold' }
  const row = node.toJSON() as Record<string, unknown>
  if (row['insert'] !== undefined) return { reason: 'code' }
  if (row['name'] !== undefined) return { reason: 'plugin-swap' }
  if (row['disabled'] !== undefined) return { reason: 'not-understood', detail: 'disabled' }
  if (typeof row['id'] !== 'string') return { reason: 'not-understood', detail: 'a row without an id' }
  return settingsHold(row['id'], row['config'] ?? {})
}

/**
 * Why a row's settings are held back.
 * @param id - the row id or settings section.
 * @param config - its parsed settings.
 * @returns the reason with the first setting it does not carry, or `undefined` when every setting is carried.
 */
function settingsHold(id: string, config: unknown): { readonly reason: HoldReason, readonly detail?: string } | undefined {
  if (!Object.hasOwn(CARRIED_SETTINGS, id)) return { reason: 'not-understood', detail: 'a row the import does not carry' }
  const setting = uncarriedSetting(id, config)
  return setting === undefined ? undefined : { reason: 'not-understood', detail: setting }
}

/**
 * Why one settings section is held back.
 * @param section - the section's name, an entry id.
 * @param value - its node.
 * @returns the reason, or `undefined` when it is carried.
 */
function sectionHold(section: string, value: unknown): { readonly reason: HoldReason, readonly detail?: string } | undefined {
  if (expressionsIn(value) > 0) return { reason: 'expression' }
  if (hasForeignTag(value)) return { reason: 'not-understood', detail: 'a tag' }
  return settingsHold(section, isMap(value) || isSeq(value) || isScalar(value) ? value.toJSON() : value)
}
