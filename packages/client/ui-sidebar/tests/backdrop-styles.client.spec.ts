// @vitest-environment jsdom
/** The backdrop's rules, read from SidebarRoot.module.css and matched against DOM shaped as the slot outlet renders it. */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const css = readFileSync(resolve(import.meta.dirname, '../src/client/SidebarRoot.module.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, ' ')

/**
 * A selector list's selectors, split at its top-level commas only.
 * @param list - the selector list.
 * @returns the selectors, whitespace collapsed.
 */
function selectorsOf(list: string): string[] {
  const found: string[] = []
  let depth = 0
  let current = ''
  for (const character of list) {
    if (character === '(') depth += 1
    if (character === ')') depth -= 1
    if (character === ',' && depth === 0) {
      found.push(current)
      current = ''
    } else {
      current += character
    }
  }
  return [...found, current].map(selector => selector.trim().replace(/\s+/g, ' '))
}

/** Each rule's selectors and body, in source order. */
const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([, selectors = '', body = '']) => ({ selectors: selectorsOf(selectors), body }))

/** The selector that hides the backdrop box while it holds no art. */
const HIDE = rules.find(rule => rule.selectors.some(selector => selector.startsWith('.backdrop')) && /display:\s*none/.test(rule.body))?.selectors[0]
/** The selector that turns the brand row light over art. */
const LIGHT = rules.find(rule => rule.selectors.some(selector => selector.endsWith(' .logoRow') && selector.includes('.backdrop')))?.selectors
  .find(selector => selector.endsWith(' .logoRow'))

afterEach(() => { document.body.innerHTML = '' })

/**
 * Mount the column with the backdrop's outlet holding the given markup inside its `[data-slot]` anchor, as the slot
 * renderer draws every occupant.
 * @param occupant - the markup inside the anchor.
 * @returns the backdrop box and the brand row.
 */
function mount(occupant: string): { backdrop: Element; logoRow: Element } {
  document.body.innerHTML = `<div class="root"><div class="backdrop"><div data-slot="sidebar.backdrop" style="display: contents">${occupant}</div></div><div class="logoRow"></div></div>`
  const [backdrop, logoRow] = [document.querySelector('.backdrop'), document.querySelector('.logoRow')]
  if (backdrop === null || logoRow === null) throw new Error('the column did not mount')
  return { backdrop, logoRow }
}

describe('the sidebar backdrop through the slot anchor', () => {
  it('finds both rules in the stylesheet', () => {
    expect(HIDE).toBeDefined()
    expect(LIGHT).toBeDefined()
  })

  it('hides the box and leaves the brand\'s colours while the anchor holds no art', () => {
    for (const occupant of ['', '<div data-slot-error="sidebar.backdrop"></div>']) {
      const { backdrop, logoRow } = mount(occupant)
      expect(backdrop.matches(HIDE ?? ''), occupant).toBe(true)
      expect(logoRow.matches(LIGHT ?? ''), occupant).toBe(false)
    }
  })

  it('shows the box and turns the brand light over art', () => {
    const { backdrop, logoRow } = mount('<div class="art"><svg></svg></div>')
    expect(backdrop.matches(HIDE ?? '')).toBe(false)
    expect(logoRow.matches(LIGHT ?? '')).toBe(true)
  })

  it('leaves the brand\'s colours when the art marks any of its elements plain', () => {
    for (const occupant of ['<span data-backdrop-plain><svg></svg></span>', '<div class="art"></div><div data-backdrop-plain></div>']) {
      const { backdrop, logoRow } = mount(occupant)
      expect(backdrop.matches(HIDE ?? ''), occupant).toBe(false)
      expect(logoRow.matches(LIGHT ?? ''), occupant).toBe(false)
    }
  })
})
