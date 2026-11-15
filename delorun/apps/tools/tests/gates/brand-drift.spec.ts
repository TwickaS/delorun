import { describe, expect, it } from 'vitest'
import { fileErrors, isScanned, lineFindings, type Allowlist } from '../../src/checks/gates/brand-drift.ts'

const NONE: Allowlist = { entries: [] }
// The literals are assembled at run time, so this file holds none for the gate to find.
const PEACH = ['#E57', '34A'].join('')
const TEXT_PEACH = ['#b84', 'a1b'].join('')
const NUT = ['M16 2.5L27.7', ' 9.25V22.75'].join('')

describe('the brand drift gate', () => {
  it('refuses a brand colour in any letter case, a named typeface in font-family and a copy of the mark', () => {
    expect(lineFindings(`a { color: ${PEACH}; }`).map(finding => finding.rule)).toEqual(['colour'])
    expect(lineFindings(`a { color: ${TEXT_PEACH}; }`).map(finding => finding.rule)).toEqual(['colour'])
    expect(lineFindings("body { font-family: 'Inter', sans-serif; }").map(finding => finding.rule)).toEqual(['font'])
    expect(lineFindings(`<path d="${NUT}Z"/>`).map(finding => finding.rule)).toEqual(['mark'])
  })

  it('accepts custom properties, an unquoted generic family and a colour that is not a brand colour', () => {
    expect(lineFindings('a { color: var(--dl-accent); font-family: var(--dl-font-sans); }')).toEqual([])
    expect(lineFindings('a { font-family: system-ui, sans-serif; background: #123456; }')).toEqual([])
  })

  it('reads package and site sources but not the brand package, tests or other trees', () => {
    expect(isScanned('delorun/packages/plugin-theme/src/client/x.css')).toBe(true)
    expect(isScanned('delorun/apps/website/src/styles/app.css')).toBe(true)
    expect(isScanned('delorun/packages/site-design/src/tokens.css')).toBe(true)
    expect(isScanned('delorun/packages/home-auth/assets/sign-in.css')).toBe(true)
    expect(isScanned('delorun/packages/home-auth/assets/sign-in.html')).toBe(true)
    expect(isScanned('delorun/packages/home-auth/tests/x.ts')).toBe(false)
    expect(isScanned('delorun/apps/website/scripts/og.html')).toBe(true)
    expect(isScanned('delorun/apps/website/scripts/export-subscribers.ts')).toBe(true)
    expect(isScanned('delorun/apps/docs/scripts/check-links.mjs')).toBe(false)
    expect(isScanned('delorun/packages/brand/src/tokens.css')).toBe(false)
    expect(isScanned('delorun/packages/plugin-theme/tests/x.ts')).toBe(false)
    expect(isScanned('delorun/packages/plugin-theme/src/client/font.woff2')).toBe(false)
  })

  it('reports path, line and reason, and lets the allowlist exempt one rule of one file', () => {
    const path = 'delorun/apps/docs/src/x.css'
    const text = `a { color: ${PEACH}; }\nb { font-family: "Inter"; }`
    expect(fileErrors(path, text, NONE)).toHaveLength(2)
    expect(fileErrors(path, text, NONE)[0]).toContain(`${path}:1:`)
    const exempt: Allowlist = { entries: [{ path, rule: 'colour', reason: 'test' }] }
    expect(fileErrors(path, text, exempt)).toEqual([`${path}:2: a named typeface in font-family; use \`var(--dl-font-sans)\` or \`var(--dl-font-mono)\``])
    expect(fileErrors('delorun/packages/brand/src/tokens.css', text, NONE)).toEqual([])
  })

  it('refuses a second copy of the mark or a brand colour in a website script, and accepts the allowlisted generated card', () => {
    const path = 'delorun/apps/website/scripts/og.html'
    const copy = `<svg><path d="${NUT}Z"/><circle fill="${PEACH}"/></svg>`
    expect(fileErrors(path, copy, NONE)).toHaveLength(2)
    const generated: Allowlist = { entries: [{ path, rule: 'mark', reason: 'generated' }] }
    expect(fileErrors(path, copy, generated)).toHaveLength(1)
    expect(fileErrors('delorun/apps/website/scripts/x.ts', `const c = '${PEACH}'`, generated)).toHaveLength(1)
  })
})
