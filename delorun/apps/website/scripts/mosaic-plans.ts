/**
 * Runs the home page's mosaic match once for each look the header's theme control steps through, for both layouts, and
 * writes `src/home/mosaic-plans.ts`, which the page reads instead of matching in the browser. Run it after
 * `shot-colours.ts`.
 *
 * Usage: `node scripts/mosaic-plans.ts`
 *
 * @module @delorun/website/scripts/mosaic-plans
 */
import { writeFileSync } from 'node:fs'
import { mosaic, NARROW, WIDE, type Part } from '../src/home/mosaic.ts'

/** The looks, by the ids the page and the captures share. */
const LOOKS = ['soft', 't3-code', 't3-chat', 'grove', 'ocean', 'ember', 'iris'] as const

const PART_LETTER: Readonly<Record<Part, string>> = { nut: 'n', hole: 'h', plug: 'p', out: 'o' }

const ids: string[] = []
const index = (id: string) => { const at = ids.indexOf(id); if (at >= 0) return at; ids.push(id); return ids.length - 1 }
const layouts: string[] = []
for (const [name, layout] of [['wide', WIDE], ['narrow', NARROW]] as const) {
  const plans = LOOKS.map(look => ({ look, plan: mosaic(layout, look) }))
  const first = plans[0]?.plan
  if (first === undefined) throw new Error('No looks')
  const parts = first.cells.map(cell => PART_LETTER[cell.part]).join('')
  const looks = plans.map(({ look, plan }) => {
    const mark = plan.cells.filter(cell => cell.part !== 'out' && cell.part !== 'hole')
    const share = (cells: typeof plan.cells) => Math.round(cells.filter(cell => cell.shot.look === look).length / cells.length * 100)
    console.log(`${name} ${look}: ${share(plan.cells)}% of all cells and ${share(mark.filter(cell => cell.part === 'nut'))}% of the nut in this look; ${new Set(mark.map(cell => cell.shot.id)).size} distinct in the mark; living cell ${plan.live}`)
    return `      '${look}': { cells: [${plan.cells.map(cell => index(cell.shot.id)).join(',')}], live: ${plan.live} },`
  })
  layouts.push(`  ${name}: {\n    parts: '${parts}',\n    looks: {\n${looks.join('\n')}\n    },\n  },`)
}

writeFileSync(new URL('../src/home/mosaic-plans.ts', import.meta.url), `/**
 * The home page's mosaic for each look, matched once by \`scripts/mosaic-plans.ts\`; do not edit by hand. Each
 * layout lists its cells' parts by row (\`n\` nut, \`h\` hole, \`p\` plug, \`o\` around), then for each look every cell's
 * picture as an index into {@link PLAN_IDS} and the living tile's cell.
 *
 * @module @delorun/website/home/mosaic-plans
 */

/** The pictures the plans use. */
export const PLAN_IDS: readonly string[] = [
${ids.map(id => `  '${id}',`).join('\n')}
]

/** The looks the plans cover. */
export const PLAN_LOOKS = [${LOOKS.map(look => `'${look}'`).join(', ')}] as const

/** The plans, by layout. */
export const MOSAIC_PLANS: Readonly<Record<'wide' | 'narrow', { readonly parts: string; readonly looks: Readonly<Record<(typeof PLAN_LOOKS)[number], { readonly cells: readonly number[]; readonly live: number }>> }>> = {
${layouts.join('\n')}
}
`)
console.log(`wrote plans for ${LOOKS.length} looks over ${ids.length} pictures`)
