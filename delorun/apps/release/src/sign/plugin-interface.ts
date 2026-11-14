/**
 * The plugin-facing interface inventory, `delorun/packages/contract-plugin-versions/plugin-interface.json`
 * (`delorun.plugin-interface/1`), and the source checks behind it: which members of Cordis's `interface Context` (services)
 * and `interface Events` (events) a source file declares inside `declare module '@deepseek-ai/cordis'`, and whether a
 * source file reads a plugin manifest field. The patch rule (`patch-rule.ts`) and the inventory's drift spec both use
 * these checks, so the inventory and the rule read sources the same way.
 *
 * @module @delorun/release/sign/plugin-interface
 */
import { PLUGIN_INTERFACE_SCHEMA, type PluginInterface, type PluginInterfaceEntry } from '@delorun/contract-plugin-versions'
import ts from 'typescript'
import { z } from 'zod'
import { canonicalJson, parseStrictJson, toJsonValue } from '@delorun/release-formats/sign/json'

/** The inventory's path relative to the repository root. */
export const PLUGIN_INTERFACE_PATH = 'delorun/packages/contract-plugin-versions/plugin-interface.json'

/** The module name whose `interface Context` and `interface Events` augmentations declare services and events. */
export const CORDIS_MODULE = '@deepseek-ai/cordis'

/** The Cordis interface whose members each declared entry kind names. */
export const CORDIS_INTERFACES = { service: 'Context', event: 'Events' } as const

/** A Cordis interface the inventory reads members of. */
export type CordisInterface = (typeof CORDIS_INTERFACES)[keyof typeof CORDIS_INTERFACES]

/** The inventory's size limit before parsing. */
const PLUGIN_INTERFACE_SIZE_LIMIT = 256 * 1024

/** A repository-relative TypeScript source path: `/`-separated segments, none starting with `.`, so never `..`. */
const sourcePath = z.string().max(512).regex(/^[A-Za-z0-9_@-][A-Za-z0-9._@-]*(?:\/[A-Za-z0-9_@-][A-Za-z0-9._@-]*)*\.tsx?$/u, 'a repository-relative .ts or .tsx path')

const entrySchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('service'), name: z.string().regex(/^[A-Za-z_$][\w$]*$/u), side: z.enum(['host', 'browser']), source: sourcePath }),
  z.strictObject({ kind: z.literal('event'), name: z.string().max(128).regex(/^[A-Za-z0-9_$@][\w$@./:-]*$/u), side: z.enum(['host', 'browser']), source: sourcePath }),
  z.strictObject({ kind: z.literal('manifest-field'), name: z.string().regex(/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+$/u), source: sourcePath }),
])

/** The inventory file's content. */
export const PluginInterfaceSchema = z.strictObject({
  schema: z.literal(PLUGIN_INTERFACE_SCHEMA),
  covered: z.array(entrySchema),
  internal: z.array(entrySchema),
})

/**
 * Read an inventory file.
 * @param bytes - the file's bytes.
 * @returns the inventory.
 * @throws Error when the file is above 256 KiB, is not strict JSON (a duplicate key included) or does not match
 * `delorun.plugin-interface/1`.
 */
export function readPluginInterface(bytes: Uint8Array): PluginInterface {
  const parsed = PluginInterfaceSchema.safeParse(parseStrictJson(bytes, PLUGIN_INTERFACE_SIZE_LIMIT))
  if (!parsed.success) throw new Error(`not a ${PLUGIN_INTERFACE_SCHEMA} inventory: ${z.prettifyError(parsed.error).replaceAll('\n', '; ')}`)
  return parsed.data
}

/**
 * An entry's identity, which two inventories compare: its canonical JSON.
 * @param entry - the entry.
 * @returns the entry's RFC 8785 canonical JSON.
 */
export function entryKey(entry: PluginInterfaceEntry): string {
  return canonicalJson(toJsonValue(entry))
}

/**
 * An entry as a person reads it in a refusal.
 * @param entry - the entry.
 * @returns such as `service delorunStudio (browser, in delorun/packages/plugin-theme/src/client/index.ts)`.
 */
export function describeEntry(entry: PluginInterfaceEntry): string {
  switch (entry.kind) {
    case 'service':
    case 'event':
      return `${entry.kind} ${entry.name} (${entry.side}, in ${entry.source})`
    case 'manifest-field':
      return `manifest field ${entry.name} (read in ${entry.source})`
  }
}

function parse(fileName: string, text: string): ts.SourceFile {
  return ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
}

/**
 * The members of a Cordis interface that a source file declares inside `declare module '@deepseek-ai/cordis'`: of
 * `Context`, its services; of `Events`, its events. Members named by an identifier or a string literal count; index
 * signatures and computed names do not.
 * @param fileName - the file's name, whose `.tsx` extension selects JSX parsing; a `.d.ts` file parses as TypeScript.
 * @param text - the file's text.
 * @param name - the interface, `Context` or `Events`.
 * @returns the member names in declaration order, repeated when the file declares one twice.
 */
export function declaredCordisMembers(fileName: string, text: string, name: CordisInterface): string[] {
  const members: string[] = []
  // A file that never names the module declares nothing in it, and parsing it is the cost of a drift check.
  if (!text.includes(CORDIS_MODULE)) return members
  for (const statement of parse(fileName, text).statements) {
    if (!ts.isModuleDeclaration(statement) || !ts.isStringLiteral(statement.name) || statement.name.text !== CORDIS_MODULE) continue
    if (statement.body === undefined || !ts.isModuleBlock(statement.body)) continue
    for (const declaration of statement.body.statements) {
      if (!ts.isInterfaceDeclaration(declaration) || declaration.name.text !== name) continue
      for (const member of declaration.members) {
        const key = member.name
        if (key !== undefined && (ts.isIdentifier(key) || ts.isStringLiteral(key))) members.push(key.text)
      }
    }
  }
  return members
}

/** The names of a property-access chain, such as `['manifest', 'engines', 'delorun']`; `?` stands for any other expression. */
function chainNames(expression: ts.Expression): string[] {
  if (ts.isPropertyAccessExpression(expression)) return [...chainNames(expression.expression), expression.name.text]
  if (ts.isIdentifier(expression)) return [expression.text]
  return ['?']
}

/**
 * Whether a source file reads a manifest field: a property access whose last names are the field's dotted path, such
 * as `engines.delorun` or `manifest.engines.delorun`.
 * @param fileName - the file's name, whose `.tsx` extension selects JSX parsing.
 * @param text - the file's text.
 * @param field - the field's dotted path.
 * @returns true when such an access occurs outside comments and strings.
 */
export function readsManifestField(fileName: string, text: string, field: string): boolean {
  const path = field.split('.')
  let found = false
  const visit = (node: ts.Node): void => {
    if (found) return
    if (ts.isPropertyAccessExpression(node) && chainNames(node).slice(-path.length).join('.') === field) {
      found = true
      return
    }
    ts.forEachChild(node, visit)
  }
  visit(parse(fileName, text))
  return found
}

/**
 * Whether a source file still offers an entry: a service or an event it declares, or a manifest field it reads.
 * @param entry - the entry.
 * @param text - the text of the entry's source file.
 * @returns true when the source declares the service or the event, or reads the field.
 */
export function sourceOffers(entry: PluginInterfaceEntry, text: string): boolean {
  switch (entry.kind) {
    case 'service':
    case 'event':
      return declaredCordisMembers(entry.source, text, CORDIS_INTERFACES[entry.kind]).includes(entry.name)
    case 'manifest-field':
      return readsManifestField(entry.source, text, entry.name)
  }
}
