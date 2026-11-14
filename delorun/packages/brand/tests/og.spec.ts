/** The website's social card source is the builder's output, and it holds the mark's drawing and no brand literal. */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { MARK } from '../src/mark.tsx'
import { ogHtml } from '../src/og.ts'

const committed = (): string => readFileSync(new URL('../../../apps/website/scripts/og.html', import.meta.url), 'utf8')

describe('the social card source', () => {
  it('is what apps/website/scripts holds, so a change to the mark must be re-rendered', () => {
    expect(committed()).toBe(ogHtml())
  })

  it('refuses a copy whose mark has drifted', () => {
    const drifted = committed().replace(MARK.nut, MARK.nut.replace('M16 2.5', 'M16 3'))
    expect(drifted).not.toBe(ogHtml())
  })

  it('draws the mark and reads the brand colours from custom properties', () => {
    expect(ogHtml()).toContain(MARK.nut)
    expect(ogHtml()).not.toMatch(/#[0-9a-f]{6}\b/i)
  })
})
