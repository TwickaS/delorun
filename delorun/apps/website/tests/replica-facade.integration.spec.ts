import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { buildFacade } from '../src/replica/build/facade.ts'
import { STUDIO_COMPONENTS } from '../src/replica/studio/components.ts'

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url)).replace(/\/$/u, '')
const COMMITTED = fileURLToPath(new URL('../src/replica/studio/facade.d.ts', import.meta.url))

describe('the replica studio facade', () => {
  it('is what the generator writes from the components', () => {
    const text = buildFacade(ROOT)
    expect(readFileSync(COMMITTED, 'utf8'), 'facade.d.ts is out of date; run node_modules/.bin/tsx delorun/apps/website/src/replica/build/facade.ts').toBe(text)
    for (const { name } of STUDIO_COMPONENTS) expect(text).toContain(`export const ${name}:`)
  })
})
