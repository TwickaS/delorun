/**
 * Runs the home page's mosaic match once for each look the header's theme control steps through, in the light and the
 * dark mode, for both layouts, and
 * writes `src/home/mosaic-plans.ts`, which the page reads instead of matching in the browser. Run it after
 * `shot-colours.ts`.
 *
 * Usage: `node scripts/mosaic-plans.ts`
 *
 * @module @delorun/website/scripts/mosaic-plans
 */
import { writeFileSync } from 'node:fs'
import { mosaic, NARROW, WIDE, type Mode, type Part } from '../src/home/mosaic.ts'

/** The looks, by the ids the page and the captures share. */
const LOOKS = ['soft', 't3-code', 't3-chat', 'grove', 'ocean', 'ember', 'iris'] as const

const PART_LETTER: Readonly<Record<Part, string>> = { nut: 'n', hole: 'h', plug: 'p', out: 'o' }

/** The colour schemes a plan covers. */
const MODES: readonly Mode[] = ['light', 'dark']

const ids: string[] = []
const index = (id: string) => { const at = ids.indexOf(id); if (at >= 0) return at; ids.push(id); return ids.length - 1 }
/** A picture's index as two base 36 digits, so a plan is one short string. */
const code = (id: string) => index(id).toString(36).padStart(2, '0')
const layouts: string[] = []
for (const [name, layout] of [['wide', WIDE], ['narrow', NARROW]] as const) {
  const plans = LOOKS.map(look => ({ look, plans: MODES.map(mode => ({ mode, plan: mosaic(layout, look, mode) })) }))
  const first = plans[0]?.plans[0]?.plan
  if (first === undefined) throw new Error('No looks')
  const parts = first.cells.map(cell => PART_LETTER[cell.part]).join('')
  const looks = plans.map(({ look, plans: modes }) => {
    const entries = modes.map(({ mode, plan }) => {
      const mark = plan.cells.filter(cell => cell.part !== 'out' && cell.part !== 'hole')
      const share = (cells: typeof plan.cells) => Math.round(cells.filter(cell => cell.shot.look === look).length / cells.length * 100)
      console.log(`${name} ${look} ${mode}: ${share(plan.cells)}% of all cells in this look; ${new Set(mark.map(cell => cell.shot.id)).size} distinct in the mark; living cell ${plan.live}`)
      return `        '${mode}': { cells: '${plan.cells.map(cell => code(cell.shot.id)).join('')}', live: ${plan.live} },`
    })
    return `      '${look}': {\n${entries.join('\n')}\n      },`
  })
  layouts.push(`  ${name}: {\n    parts: '${parts}',\n    looks: {\n${looks.join('\n')}\n    },\n  },`)
}

writeFileSync(new URL('../src/home/mosaic-plans.ts', import.meta.url), `/**
 * The home page's mosaic for each look and colour scheme, matched once by \`scripts/mosaic-plans.ts\`; do not edit by
 * hand. Each layout lists its cells' parts by row (\`n\` nut, \`h\` hole, \`p\` plug, \`o\` around), then for each look and
 * mode every cell's picture as an index into {@link PLAN_IDS} written as two base 36 digits, and the living tile's cell.
 * \`plans.ts\` reads them.
 *
 * @module @delorun/website/home/mosaic-plans
 */

/** The pictures the plans use. */
export const PLAN_IDS: readonly string[] = [
${ids.map(id => `  '${id}',`).join('\n')}
]

/** The looks the plans cover. */
export const PLAN_LOOKS = [${LOOKS.map(look => `'${look}'`).join(', ')}] as const

/** The colour schemes the plans cover. */
export const PLAN_MODES = [${MODES.map(mode => `'${mode}'`).join(', ')}] as const

/** One plan: its cells as base 36 pairs, and the living tile's cell. */
export interface PlanData { readonly cells: string; readonly live: number }

/** The plans, by layout. */
export const MOSAIC_PLANS: Readonly<Record<'wide' | 'narrow', { readonly parts: string; readonly looks: Readonly<Record<(typeof PLAN_LOOKS)[number], Readonly<Record<(typeof PLAN_MODES)[number], PlanData>>>> }>> = {
${layouts.join('\n')}
}
`)
console.log(`wrote plans for ${LOOKS.length} looks and ${MODES.length} modes over ${ids.length} pictures`)
