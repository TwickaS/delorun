import { describe, expect, it } from 'vitest'
import { headlinesOnly, type ChangelogView, type ViewVersion } from '../src/changelog.ts'

const area = { area: 'Chat', items: [{ prefix: undefined, text: 'A change' }] }
const version = (number: string): ViewVersion => ({ version: number, date: '2026-01-01', areas: [area], fromUpstream: ['u'], previews: [{ version: `${number}-p`, date: '2025-12-01', areas: [area], fromUpstream: [] }], headlines: ['Headline'] })
const view: ChangelogView = { compared: { heading: 'H', intro: 'long intro', areas: [area] }, versions: [version('2'), version('1')] }

describe('the headlines-only changelog view', () => {
  it('keeps the latest version number, date and headlines and drops the rest of the record', () => {
    const slim = headlinesOnly(view)
    expect(slim?.versions).toHaveLength(1)
    expect(slim?.versions[0]).toMatchObject({ version: '2', date: '2026-01-01', headlines: ['Headline'], areas: [], fromUpstream: [], previews: [] })
    expect(slim?.compared.areas).toEqual([])
    expect(JSON.stringify(slim).length).toBeLessThan(JSON.stringify(view).length / 2)
  })

  it('passes through a missing record and an empty one', () => {
    expect(headlinesOnly(undefined)).toBeUndefined()
    const empty: ChangelogView = { compared: view.compared, versions: [] }
    expect(headlinesOnly(empty)).toBe(empty)
  })
})
