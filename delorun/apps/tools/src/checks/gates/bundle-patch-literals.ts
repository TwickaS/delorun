/**
 * Bundle-patch literals gate: a shipped Delorun bundle patch (`delorun/packages/<name>/cordis.patch.yml`) disables a
 * row only with a literal `true` or `false`. The update report reads such a patch statically and counts a `disabled`
 * `!!js` expression as "loads", so an expression that evaluates true on the target disables a row the report did not
 * name and the update rolls back unexplained. Run from anywhere inside the repository:
 * `node_modules/.bin/tsx delorun/apps/tools/src/checks/gates/bundle-patch-literals.ts`. It prints one line per
 * violation and exits 1.
 *
 * @module @delorun/tools/checks/gates/bundle-patch-literals
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import yaml from 'js-yaml'
import { repositoryRoot } from '../../git.ts'

/** The `!!js` tag of Cordis patch files, kept as a marker object. */
const JS_EXPRESSION = new yaml.Type('tag:yaml.org,2002:js', {
  kind: 'scalar',
  resolve: (data: unknown) => typeof data === 'string',
  construct: (data: string) => ({ __jsExpr: data }),
})
const PATCH_SCHEMA = yaml.DEFAULT_SCHEMA.extend([JS_EXPRESSION])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * The `disabled` expressions in one parsed patch: on an entry, on an inserted row, and on a row inside a group's
 * `config` list at any depth.
 * @param file - the repository-relative patch path, used in the messages.
 * @param entries - the patch's parsed entries.
 * @returns one message per `disabled` that is an expression; empty when every `disabled` is a literal.
 */
export function disabledExpressionErrors(file: string, entries: readonly unknown[]): string[] {
  const problems: string[] = []
  const visit = (value: unknown, path: string): void => {
    if (!isRecord(value)) return
    if (isRecord(value.disabled) && '__jsExpr' in value.disabled) {
      problems.push(`${file}${path}.disabled: a bundle patch may only disable a row with a literal true or false; the update report cannot predict an expression`)
    }
    for (const key of ['insert', 'config'] as const) {
      const rows = value[key]
      if (Array.isArray(rows)) rows.forEach((row: unknown, index) => visit(row, `${path}.${key}[${String(index)}]`))
    }
  }
  entries.forEach((entry, index) => visit(entry, `[${String(index)}]`))
  return problems
}

/**
 * The violations of a repository: every shipped bundle patch under `delorun/packages`.
 * @param root - the repository root.
 * @returns one message per `disabled` expression; empty when every patch uses literals.
 */
export function bundlePatchLiteralErrors(root: string): string[] {
  const packages = join(root, 'delorun/packages')
  if (!existsSync(packages)) return ['delorun/packages/: no Delorun packages at the repository root, so there are no patches to check']
  return readdirSync(packages).sort().flatMap((name) => {
    const file = `delorun/packages/${name}/cordis.patch.yml`
    if (!existsSync(join(root, file))) return []
    const document: unknown = yaml.load(readFileSync(join(root, file), 'utf8'), { schema: PATCH_SCHEMA })
    return Array.isArray(document) ? disabledExpressionErrors(file, document) : []
  })
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const errors = bundlePatchLiteralErrors(repositoryRoot(process.cwd()))
  for (const error of errors) console.error(`gates:bundle-patch-literals: ${error}`)
  if (errors.length === 0) console.log('gates:bundle-patch-literals: every shipped bundle patch disables rows with literals')
  process.exitCode = errors.length === 0 ? 0 : 1
}
