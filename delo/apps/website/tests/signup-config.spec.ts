import { describe, expect, it } from 'vitest'
import { resolveSending } from '../src/site/sending.ts'
import { cell, databaseName, EXPORT_SQL, toCsv } from '../scripts/export-subscribers.ts'

describe('the sending flag', () => {
  it('is on for prod and off for staging unless set', () => {
    expect(resolveSending('prod', {})).toEqual({ sending: true, publicOrigin: 'https://delorun.com' })
    expect(resolveSending('staging', {})).toEqual({ sending: false, publicOrigin: undefined })
    expect(resolveSending('prod', { WEBSITE_CONFIRMATION_EMAIL: 'off' }).sending).toBe(false)
  })

  it('lets a staging stage turn sending on only with an origin for the links', () => {
    expect(() => resolveSending('staging', { WEBSITE_CONFIRMATION_EMAIL: 'on' })).toThrow(/WEBSITE_PUBLIC_ORIGIN/)
    expect(resolveSending('staging', { WEBSITE_CONFIRMATION_EMAIL: 'on', WEBSITE_PUBLIC_ORIGIN: 'https://x.workers.dev' })).toEqual({ sending: true, publicOrigin: 'https://x.workers.dev' })
  })

  it('refuses any other value', () => {
    expect(() => resolveSending('prod', { WEBSITE_CONFIRMATION_EMAIL: 'true' })).toThrow(/"on" or "off"/)
  })
})

describe('the subscriber export', () => {
  it('reads confirmed rows only', () => {
    expect(EXPORT_SQL).toContain("status = 'confirmed'")
    expect(EXPORT_SQL).not.toMatch(/pending|unsubscribed/)
  })

  it('quotes cells and neutralises spreadsheet formulas', () => {
    expect(cell(null)).toBe('')
    expect(cell('a,b')).toBe('"a,b"')
    expect(cell('say "hi"')).toBe('"say ""hi"""')
    expect(cell('=SUM(A1)')).toBe("'=SUM(A1)")
    expect(toCsv([{ email: 'ada@example.com', first_name: null, confirmed_at: '2026-11-13T10:00:00.000Z' }])).toBe('email,first_name,confirmed_at\nada@example.com,,2026-11-13T10:00:00.000Z\n')
  })

  it('names the database as the stack does and refuses anything else as a stage', () => {
    expect(databaseName('prod')).toBe('delo-website-prod-subscribers')
    expect(() => databaseName('prod; DROP')).toThrow(/not a stage name/)
  })
})
