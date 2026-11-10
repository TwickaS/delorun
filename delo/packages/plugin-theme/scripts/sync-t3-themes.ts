/**
 * Regenerates `src/palette/t3-themes.ts` from a T3 Code checkout's
 * `packages/shared/src/themePalettes.ts`, read as text and never run.
 *
 * Usage: `node_modules/.bin/tsx delo/packages/plugin-theme/scripts/sync-t3-themes.ts <t3code checkout> <commit>`
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseT3Themes } from '../src/palette/t3-source.ts'

const [checkout, commit] = process.argv.slice(2)
if (checkout === undefined || commit === undefined || !/^[0-9a-f]{7,40}$/.test(commit)) {
  throw new Error('usage: sync-t3-themes.ts <t3code checkout> <commit>')
}
const TARGET = fileURLToPath(new URL('../src/palette/t3-themes.ts', import.meta.url))
const themes = parseT3Themes(readFileSync(join(checkout, 'packages/shared/src/themePalettes.ts'), 'utf8'))
const colors = (values: Readonly<Record<string, string>>): string =>
  Object.entries(values).map(([role, value]) => `      ${role}: ${JSON.stringify(value)},`).join('\n')
const body = Object.entries(themes).map(([id, theme]) => `  ${JSON.stringify(id)}: {
    label: ${JSON.stringify(theme.label)},
    light: {
${colors(theme.light)}
    },
    dark: {
${colors(theme.dark)}
    },
  },`).join('\n')

writeFileSync(TARGET, `/**
 * T3 Code's themes, copied from T3 Code (MIT, © 2026 T3 Tools Inc.) at
 * commit \`${commit}\`, \`packages/shared/src/themePalettes.ts\`, by
 * \`scripts/sync-t3-themes.ts\`. Do not edit by hand.
 * @module @delo/plugin-theme/palette/t3-themes
 */
import type { T3Theme } from './t3-source.ts'

/** T3 Code's default theme (\`t3-code\`) and its built-in themes, each in both schemes, by T3 Code's ids. */
export const T3_THEMES = {
${body}
} as const satisfies Readonly<Record<string, T3Theme>>
`)
