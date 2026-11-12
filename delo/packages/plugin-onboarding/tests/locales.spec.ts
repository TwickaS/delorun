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
    expect(en['step.look']).toBe('Look')
    expect(en['step.plugins']).toBe('Recommended plugins')
    expect(en['step.reach']).toBe('Phone access')
  })

  it('says plainly what adding an agent means and claims no consent that is not built', () => {
    expect(en['agents.confirm.outside']).toBe('It runs outside Delo\'s sandbox and permission prompts.')
    expect(en['agents.confirm.handoff']).toContain('does not ask you before each run')
    for (const text of Object.values(en)) expect(text).not.toMatch(/consent|each workspace/i)
  })

  it('has a prompt set for each folder kind and the general one', () => {
    for (const set of ['general', 'empty', 'code', 'files']) for (const n of [1, 2, 3]) expect(Object.keys(en)).toEqual(expect.arrayContaining([`starter.${set}.${n}.label`, `starter.${set}.${n}.prompt`]))
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
