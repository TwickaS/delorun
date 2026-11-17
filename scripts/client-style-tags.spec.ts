import { describe, expect, it } from 'vitest'
import { claimStyleTag, styleTagId } from './client-style-tags.ts'

const root = '/repo'

describe('client style tag ids', () => {
  it('keeps same-named stylesheets from different packages apart', () => {
    const brand = styleTagId('@x/onboarding', '/repo/brand/src/components/Notice.module.css', root)
    const own = styleTagId('@x/onboarding', '/repo/onboarding/src/client/ui/Notice.module.css', root)
    expect(brand).toBe('@x/onboarding/brand/src/components/Notice.module.css')
    expect(own).not.toBe(brand)
  })

  it('rejects two different stylesheets claiming one id', () => {
    const claims = new Map<string, string>()
    claimStyleTag(claims, 'p/Notice.module.css', '/a/Notice.module.css')
    expect(() => claimStyleTag(claims, 'p/Notice.module.css', '/b/Notice.module.css')).toThrow(/collision/)
  })

  it('accepts the same stylesheet loaded twice', () => {
    const claims = new Map<string, string>()
    claimStyleTag(claims, 'p/a.css', '/a.css')
    expect(() => claimStyleTag(claims, 'p/a.css', '/a.css')).not.toThrow()
  })
})
