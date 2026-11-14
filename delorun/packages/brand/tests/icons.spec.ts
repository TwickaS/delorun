/** The committed icon SVGs are the builders' output, and the favicons keep the mark's drawing. */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { faviconIcon, macosIcon, plainIcon, windowsIcon } from '../src/icons.ts'
import { MARK } from '../src/mark.tsx'

const read = (path: string): string => readFileSync(new URL(`../../../../${path}`, import.meta.url), 'utf8')

describe('the application icons', () => {
  it('are what apps/desktop and apps/web hold, so a change to the mark or the colours must be re-rendered', () => {
    expect(read('apps/desktop/resources/icon-macos.svg')).toBe(macosIcon())
    expect(read('apps/desktop/resources/icon-windows.svg')).toBe(windowsIcon())
    expect(read('apps/desktop/resources/icon.svg')).toBe(plainIcon())
    expect(read('apps/web/public/favicon.svg')).toBe(faviconIcon('light'))
    expect(read('apps/web/public/favicon-dark.svg')).toBe(faviconIcon('dark'))
  })

  it('draw the mark and keep the tray glyph group the tray renderer scales', () => {
    for (const svg of [macosIcon(), windowsIcon(), plainIcon(), faviconIcon('light')]) expect(svg).toContain(MARK.nut)
    expect(windowsIcon()).toContain('<g id="tray-glyph">')
  })
})
