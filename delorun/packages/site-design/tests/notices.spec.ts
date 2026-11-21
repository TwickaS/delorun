import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { fontNotice, readNotices, t3Notice } from '../scripts/notices.ts'

const packages = fileURLToPath(new URL('../..', import.meta.url))
const pinned = (manifest: string): string | undefined => (JSON.parse(readFileSync(fileURLToPath(new URL(manifest, import.meta.url)), 'utf8')) as { dependencies?: Record<string, string> }).dependencies?.sonner

describe('the notices', () => {
  // The website installs on its own, so this reads the licence from the root workspace's copy in `packages/brand`;
  // the next test holds the website's pin to the same version, so the two copies hold the same text.
  const notices = readNotices({ packages, sonnerLicence: fileURLToPath(new URL('../../brand/node_modules/sonner/LICENSE.md', import.meta.url)) })

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

  it('read Sonner from the version the website bundles', () => {
    expect(pinned('../../brand/package.json')).toBeDefined()
    expect(pinned('../../../apps/website/package.json')).toBe(pinned('../../brand/package.json'))
  })

  it('refuse a file that is not the licence it should be', () => {
    expect(() => t3Notice('# Third-party notices\n')).toThrow(/T3 Code/)
    expect(() => fontNotice('x', 'X', 'not a licence')).toThrow(/Open Font Licence/)
  })
})
