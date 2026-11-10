import { describe, expect, it } from 'vitest'
import { gatePath, runTsx, scratchRepo } from './support.ts'

describe('gates:erasable-syntax command', () => {
  it('exits 1 with the violation and 0 on a clean tree, from the command line', (test) => {
    const bad = scratchRepo(test)
    bad.write({ 'delo/packages/home/src/errors.ts': 'export class A { constructor(readonly code: string) {} }\n' })
    const failed = runTsx(bad.root, gatePath('erasable-syntax'))
    expect(failed.status).toBe(1)
    expect(failed.output).toContain('delo/packages/home/src/errors.ts:1:30')

    const good = scratchRepo(test)
    good.write({ 'delo/packages/home/src/errors.ts': 'export class A { readonly code: string; constructor(code: string) { this.code = code } }\n' })
    expect(runTsx(good.root, gatePath('erasable-syntax')).status).toBe(0)
  }, 60_000)
})
