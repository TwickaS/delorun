import { describe, expect, it } from 'vitest'
import { refuseStandIns } from '../deploy-guard.ts'

describe('the deploy guard', () => {
  it('passes an environment without the stand-in variable', () => {
    expect(() => { refuseStandIns({ PATH: '/bin' }) }).not.toThrow()
  })

  it('refuses the variable set to anything at all, including 1, 0, an empty string and true', () => {
    for (const value of ['1', '0', '', 'true', 'false', ' ']) {
      expect(() => { refuseStandIns({ SITE_ALLOW_STANDINS: value }) }, JSON.stringify(value)).toThrow(/SITE_ALLOW_STANDINS/)
    }
  })

  it('is called when the deploy stack loads', async () => {
    const { readFileSync } = await import('node:fs')
    const text = readFileSync(new URL('../alchemy.run.ts', import.meta.url), 'utf8')
    expect(text).toContain("refuseStandIns(process.env)")
  })
})
