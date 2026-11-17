/** The replica's scoped token block, built from this repository's theme data: every look in both schemes, scoped to the wrapper, complete for what the replica reads. */
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { LOOKS, selector } from '../../../packages/site-design/scripts/looks.ts'
import { buildTokens, tokenInputs } from '../src/replica/build/tokens.ts'
import { WRAPPER_SELECTOR } from '../src/replica/wrapper.ts'

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url))
const REPLICA = fileURLToPath(new URL('../src/replica/', import.meta.url))
const block = buildTokens(tokenInputs(ROOT, REPLICA))

/**
 * The custom properties a rule of the block declares.
 * @param rule - the rule's selector, exactly as the block writes it.
 * @returns the declared names, or undefined when the block has no such rule.
 */
function declared(rule: string): readonly string[] | undefined {
  const start = block.indexOf(`${rule}{`)
  if (start < 0) return undefined
  const body = block.slice(start + rule.length + 1, block.indexOf('}', start))
  return [...body.matchAll(/(--[\w-]+):/g)].map(match => match[1]!)
}

describe('the replica token block', () => {
  it('holds Soft light in full on the wrapper, and only what Soft dark changes under .dark', () => {
    const light = declared(WRAPPER_SELECTOR)
    const dark = declared(`.dark ${WRAPPER_SELECTOR}`)
    expect(light?.length).toBeGreaterThan(20)
    expect(dark?.length).toBeGreaterThan(0)
    expect(dark!.length).toBeLessThan(light!.length)
  })

  it('declares every studio token any declared value reads', () => {
    const declaredNames = new Set(declared(WRAPPER_SELECTOR))
    // A read with its own fallback, such as the brand's `var(--dsw-font-mono, ui-monospace, …)`, may stay undeclared.
    const read = new Set([...block.matchAll(/var\((--dsw-[\w-]+)\)/g)].map(match => match[1]!))
    expect([...read].filter(name => !declaredNames.has(name))).toEqual([])
  })

  it('declares the Delorun look\'s spacing steps, which the real sections\' cards read for their padding', () => {
    const light = new Set(declared(WRAPPER_SELECTOR))
    expect(['--delorun-space-2', '--delorun-space-4', '--delorun-space-7'].filter(name => !light.has(name))).toEqual([])
  })

  it('has a rule for every look that differs from Soft, in each scheme, keyed on the page root', () => {
    // The custom look with the peach accent draws exactly Soft, so the block needs no rule for it.
    const same = new Set(['[data-look="soft"]', '[data-look="custom"][data-accent="peach"]'])
    const missing = LOOKS.map(selector).filter(each => !same.has(each))
      .flatMap(each => [`${each}:not(.dark) ${WRAPPER_SELECTOR}`, `${each}.dark ${WRAPPER_SELECTOR}`])
      .filter(rule => declared(rule) === undefined)
    expect(missing).toEqual([])
  })

  it('declares nothing outside the wrapper', () => {
    const selectors = [...block.matchAll(/([^{}]+)\{/g)].map(match => match[1]!.trim()).filter(each => !each.startsWith('/*'))
    expect(selectors.filter(each => !each.endsWith(WRAPPER_SELECTOR))).toEqual([])
  })
})
