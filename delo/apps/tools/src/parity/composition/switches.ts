/**
 * The C16 switch registry held against the tree. A switch's Config field is a
 * property of an interface named `Config` whose JSDoc names it as
 * `C16 switch \`<id>\``, and whose schema in the same file declares
 * `<key>: z.boolean().default(<value>)`. The checks compare those fields with
 * `PARITY_SWITCHES` in both directions.
 *
 * @module @delo/tools/parity/composition/switches
 */
import ts from 'typescript'
import type { ParitySwitchEntry } from '@delo/contract-parity-composition'

/** One Config field whose JSDoc names a C16 switch. */
export interface SwitchMarker {
  /** Repository path of the file declaring it. */
  readonly path: string
  /** 1-based line of the property. */
  readonly line: number
  /** The switch id the JSDoc names. */
  readonly id: string
  /** The Config key. */
  readonly key: string
  /** The schema default in the same file, when it is a boolean literal. */
  readonly defaultValue: boolean | undefined
}

const MARKER = /C16 switch\s+`([a-z][a-z0-9_]*)`/u

function leadingComment(text: string, node: ts.Node): string {
  return (ts.getLeadingCommentRanges(text, node.getFullStart()) ?? [])
    .map(range => text.slice(range.pos, range.end))
    .join('\n')
    .replace(/^\s*\/\*\*?|\*\/\s*$/gmu, '')
    .replace(/^\s*\*/gmu, '')
    .replace(/\s+/gu, ' ')
}

function propertyName(name: ts.PropertyName): string | undefined {
  return ts.isIdentifier(name) || ts.isStringLiteral(name) ? name.text : undefined
}

/**
 * The boolean schema defaults a file declares, by key: each `<key>: <expression>.default(true|false)` property.
 * @param source - the parsed file.
 * @returns the defaults; a key declared twice keeps its last value.
 */
function schemaDefaults(source: ts.SourceFile): Map<string, boolean> {
  const defaults = new Map<string, boolean>()
  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAssignment(node)) {
      const key = propertyName(node.name)
      const init = node.initializer
      if (key !== undefined && ts.isCallExpression(init) && ts.isPropertyAccessExpression(init.expression)
        && init.expression.name.text === 'default' && init.arguments.length === 1) {
        const [value] = init.arguments
        if (value?.kind === ts.SyntaxKind.TrueKeyword) defaults.set(key, true)
        if (value?.kind === ts.SyntaxKind.FalseKeyword) defaults.set(key, false)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return defaults
}

/**
 * The C16 switch fields one file declares.
 * @param path - the repository path, reported with each marker.
 * @param text - the file's TypeScript source.
 * @returns one marker per `Config` property whose JSDoc names a switch.
 */
export function switchMarkers(path: string, text: string): SwitchMarker[] {
  if (!text.includes('C16 switch')) return []
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
  const defaults = schemaDefaults(source)
  const markers: SwitchMarker[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isInterfaceDeclaration(node) && node.name.text === 'Config') {
      for (const member of node.members) {
        if (!ts.isPropertySignature(member)) continue
        const key = propertyName(member.name)
        const id = MARKER.exec(leadingComment(text, member))?.[1]
        if (key === undefined || id === undefined) continue
        const line = source.getLineAndCharacterOfPosition(member.getStart(source)).line + 1
        markers.push({ path, line, id, key, defaultValue: defaults.get(key) })
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return markers
}

/**
 * The switch-on scenario a model-visible switch must name.
 * @param id - the switch id.
 * @returns the scenario directory name, `delo-` and the id with hyphens.
 */
export function scenarioName(id: string): string {
  return `delo-${id.replaceAll('_', '-')}`
}

const PROFILES = ['acp', 'sdk', 'session', 'web'] as const

/**
 * Every disagreement between the registry and the switch fields in the tree.
 * @param registry - the switch registry.
 * @param markers - the switch fields found in the scanned files.
 * @param exists - whether a repository path names a file.
 * @returns one message per disagreement; empty when they agree.
 */
export function registryErrors(registry: readonly ParitySwitchEntry[], markers: readonly SwitchMarker[], exists: (path: string) => boolean): string[] {
  const errors: string[] = []
  const ids = new Set<string>()
  for (const entry of registry) {
    if (!/^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/u.test(entry.id)) errors.push(`${entry.id}: a switch id is lower snake case`)
    if (ids.has(entry.id)) errors.push(`${entry.id}: two registry entries share the id`)
    ids.add(entry.id)
    if (entry.parityValue === entry.defaultValue) errors.push(`${entry.id}: the parity value equals the default value, so the switch turns nothing off`)
    if (entry.modelVisible) {
      const expected = PROFILES.map(profile => `${profile}/${scenarioName(entry.id)}`)
      if (entry.scenario === undefined || !expected.includes(entry.scenario)) errors.push(`${entry.id}: a model-visible switch names its switch-on scenario as <profile>/${scenarioName(entry.id)}, with a profile of ${PROFILES.join(', ')}`)
    } else if (entry.scenario !== undefined) {
      errors.push(`${entry.id}: a feature switch is not model-visible and names no switch-on scenario`)
    }
    if (entry.state === 'planned') {
      for (const marker of markers.filter(found => found.id === entry.id)) {
        errors.push(`${marker.path}:${String(marker.line)}: Config field ${marker.key} names C16 switch ${entry.id}, whose registry entry is still planned; make it built with this field`)
      }
      continue
    }
    const { field } = entry
    if (!exists(field.source)) {
      errors.push(`${entry.id}: its field's source ${field.source} does not exist`)
      continue
    }
    const at = markers.filter(found => found.path === field.source && found.key === field.key)
    const marker = at.find(found => found.id === entry.id)
    if (marker === undefined) {
      errors.push(`${entry.id}: ${field.source} has no Config field ${field.key} whose JSDoc names C16 switch \`${entry.id}\``)
    } else if (marker.defaultValue === undefined) {
      errors.push(`${entry.id}: ${field.source} declares no boolean schema default for ${field.key}`)
    } else if (marker.defaultValue !== entry.parityValue) {
      errors.push(`${entry.id}: the Config default of ${field.key} is ${String(marker.defaultValue)}, not the parity value ${String(entry.parityValue)}`)
    }
    for (const path of entry.sources) {
      if (!exists(path)) errors.push(`${entry.id}: its source ${path} does not exist`)
    }
    if (entry.modelVisible && entry.sources.length === 0) errors.push(`${entry.id}: a model-visible switch names the files whose contributions it turns off`)
    if (!entry.modelVisible && entry.sources.length > 0) errors.push(`${entry.id}: a feature switch turns off no model-visible contribution and names no source`)
  }
  for (const marker of markers) {
    const entry = registry.find(candidate => candidate.id === marker.id)
    if (entry === undefined) {
      errors.push(`${marker.path}:${String(marker.line)}: Config field ${marker.key} names C16 switch ${marker.id}, which is not in PARITY_SWITCHES`)
    } else if (entry.state === 'built' && (entry.field.source !== marker.path || entry.field.key !== marker.key)) {
      errors.push(`${marker.path}:${String(marker.line)}: Config field ${marker.key} names C16 switch ${marker.id}, whose registry field is ${entry.field.source} ${entry.field.key}`)
    }
  }
  return errors
}
