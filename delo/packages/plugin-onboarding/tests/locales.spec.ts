import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { en, zh } from '../src/client/locales.ts'

describe('the copy', () => {
  it('has Chinese copy for every English key and no other', () => {
    expect(Object.keys(zh).toSorted()).toEqual(Object.keys(en).toSorted())
    expect(Object.values(zh).every(value => value.trim() !== '')).toBe(true)
  })

  it('keeps the same placeholders in both languages', () => {
    const placeholders = (text: string): string[] => [...text.matchAll(/\{(\w+)\}/g)].map(match => match[1] ?? '').toSorted()
    for (const key of Object.keys(en) as (keyof typeof en)[]) expect(placeholders(zh[key])).toEqual(placeholders(en[key]))
  })

  it('names the product Delo, and uses sentence case for a step\'s name', () => {
    for (const text of Object.values(en)) expect(text).not.toMatch(/\bDelo Run\b/)
    expect(en['step.look']).toBe('Language and look')
    expect(en['step.plugins']).toBe('Recommended plugins')
  })

  it('states the agents warning plainly and claims no per-workspace consent', () => {
    expect(en['agents.warning']).toContain('their own permissions, outside Delo\'s permission prompts')
    for (const text of Object.values(en)) expect(text).not.toMatch(/consent|each workspace/i)
  })

  it('keeps the Plugins page copy in both languages', () => {
    const directory = join(import.meta.dirname, '../locale')
    expect(readdirSync(directory).toSorted()).toEqual(['en.json', 'zh.json'])
    for (const file of ['en.json', 'zh.json']) {
      const meta = (JSON.parse(readFileSync(join(directory, file), 'utf8')) as { meta: { title: string; description: string } }).meta
      expect(meta.title.length).toBeGreaterThan(0)
      expect(meta.description.length).toBeGreaterThan(0)
    }
  })
})
