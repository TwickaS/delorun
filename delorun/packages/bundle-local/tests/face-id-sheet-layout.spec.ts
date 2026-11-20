/**
 * The Face ID sheet's place on a phone screen. jsdom lays out no dynamic viewport, so this reads the stylesheet: the
 * top-layer dialog must sit on the visible viewport's bottom with the dynamic viewport's height, or the sheet's last
 * control and its safe-area padding end below the screen (e2e at 390x844: the bottom edge at 852-865px).
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const css = readFileSync(new URL('../src/client/FaceId.module.css', import.meta.url), 'utf8')

/**
 * @param selector - a rule's exact selector.
 * @returns the declarations of its first rule outside any at-rule.
 */
function declarations(selector: string): Readonly<Record<string, string>> {
  const match = new RegExp(`^${selector.replace(/[.[\]]/g, '\\$&')} \\{([^}]*)\\}`, 'm').exec(css)
  if (match === null) throw new Error(`no rule for ${selector}`)
  return Object.fromEntries((match[1] ?? '').split(';').map(line => line.trim()).filter(line => line !== '' && !line.startsWith('/*')).map((line) => {
    const colon = line.indexOf(':')
    return [line.slice(0, colon).trim(), line.slice(colon + 1).trim()]
  }))
}

describe('the Face ID sheet on a phone screen', () => {
  it('puts the dialog on the visible viewport\'s bottom with the dynamic viewport\'s height', () => {
    expect(declarations('.scrim')).toMatchObject({ position: 'fixed', inset: 'auto 0 0', height: '100dvh', 'max-height': '100dvh', margin: '0' })
  })

  it('keeps the bottom safe-area inset inside the card and sizes nothing by 100vh', () => {
    expect(declarations('.sheet').padding).toContain('env(safe-area-inset-bottom')
    expect(declarations('.sheet')['max-height']).toMatch(/dvh$/)
    expect(css).not.toMatch(/100vh/)
  })
})
