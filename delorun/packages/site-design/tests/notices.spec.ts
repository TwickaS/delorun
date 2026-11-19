import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { fontNotice, readNotices, t3Notice } from '../scripts/notices.ts'

const packages = fileURLToPath(new URL('../..', import.meta.url))

describe('the notices', () => {
  const notices = readNotices({ packages, sonnerLicence: fileURLToPath(new URL('../../../apps/website/node_modules/sonner/LICENSE.md', import.meta.url)) })

  it('carry the T3 Code copyright line and licence', () => {
    const t3 = notices.find(each => each.id === 't3-code')
    expect(t3?.copyright).toMatch(/^Copyright \(c\) \d{4} T3 Tools Inc\.$/)
    expect(t3?.text).toContain('Permission is hereby granted, free of charge')
  })

  it('carry the Open Font Licence of both typefaces with their copyright lines', () => {
    for (const id of ['schibsted-grotesk', 'jetbrains-mono']) {
      const font = notices.find(each => each.id === id)
      expect(font?.copyright).toMatch(/^Copyright \d{4} The .* Project Authors/)
      expect(font?.text).toContain('SIL OPEN FONT LICENSE Version 1.1')
    }
  })

  it('carry Sonner\'s MIT licence', () => {
    expect(notices.find(each => each.id === 'sonner')?.copyright).toBe('Copyright (c) 2023 Emil Kowalski')
  })

  it('refuse a file that is not the licence it should be', () => {
    expect(() => t3Notice('# Third-party notices\n')).toThrow(/T3 Code/)
    expect(() => fontNotice('x', 'X', 'not a licence')).toThrow(/Open Font Licence/)
  })
})
