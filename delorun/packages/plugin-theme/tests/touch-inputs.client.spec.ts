// @vitest-environment jsdom
/** The touch-input rule: one style element, 16px floor on touch screens, no viewport zoom lock. */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { TOUCH_INPUTS_ATTRIBUTE, TOUCH_INPUTS_RULE, installTouchInputs } from '../src/client/touch-inputs.ts'

describe('the touch-input rule', () => {
  it('is added once to the head and removed on dispose', () => {
    const remove = installTouchInputs(document)
    expect(document.head.querySelectorAll(`style[${TOUCH_INPUTS_ATTRIBUTE}]`)).toHaveLength(1)
    remove()
    expect(document.head.querySelector(`style[${TOUCH_INPUTS_ATTRIBUTE}]`)).toBeNull()
  })

  it('floors text fields, text areas, selectors and editable regions at 16px on coarse pointers only', () => {
    expect(TOUCH_INPUTS_RULE.startsWith('@media (pointer: coarse)')).toBe(true)
    for (const target of ['input:not(', 'textarea', 'select', '[contenteditable]:not([contenteditable="false"])']) expect(TOUCH_INPUTS_RULE).toContain(target)
    expect(TOUCH_INPUTS_RULE).toContain('font-size: max(16px, 1em) !important')
    expect(TOUCH_INPUTS_RULE).toContain(':not([type="checkbox"])')
  })

  it('leaves pinch zoom to the person: the page viewport tag does not lock the scale', () => {
    const html = readFileSync(resolve(import.meta.dirname, '../../../../apps/web/index.html'), 'utf8')
    expect(html).not.toMatch(/maximum-scale|user-scalable/)
  })
})
