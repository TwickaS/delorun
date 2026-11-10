import { describe, expect, it } from 'vitest'
import { diffErrors, timeReferences } from '../../src/checks/gates/doc-times.ts'
import { gatePath, runTsx, scratchRepo } from './support.ts'

describe('calendar planning in documentation', () => {
  it('finds deadlines, quarters, estimates and words that promise timing', () => {
    expect(timeReferences('Ships in January 2027.')).toEqual(['a deadline'])
    expect(timeReferences('The relay is due by March 2027.')).toEqual(['a deadline'])
    expect(timeReferences('Planned for Q1 2027.')).toEqual(['a quarter'])
    expect(timeReferences('Shipped within about two weeks.')).toEqual(['a schedule estimate'])
    expect(timeReferences('This lands soon.')).toEqual(['a word that promises timing'])
  })

  it('allows dates as records, durations that define behaviour, and code spans and link targets', () => {
    expect(timeReferences('Decided on 2026-11-05.')).toEqual([])
    expect(timeReferences('Upstream tagged it in January 2026.')).toEqual([])
    expect(timeReferences('Escrow waits 72 hours; a name is not reused for 90 days.')).toEqual([])
    expect(timeReferences('Run `git log --since=2026-11-05` to see it.')).toEqual([])
    expect(timeReferences('Within a week, says [the plan](plan-within-a-week.md).')).toEqual(['a schedule estimate'])
  })

  it('reports added lines only, with their file and line', () => {
    const diff = ['+++ b/delo/docs/guide/a.md', '@@ -1,0 +4,2 @@', '+Fine text, recorded 2026-11-05.', '+Coming next week.', '-Removed soon.'].join('\n')
    expect(diffErrors(diff)).toEqual(['delo/docs/guide/a.md:5: a word that promises timing'])
  })

  it('exits 1 for a range that adds a deadline to a Delo page, and 0 for one that records a date', (test) => {
    const repo = scratchRepo(test)
    const base = repo.commit({ 'README.md': 'base\n' })
    repo.commit({ 'delo/docs/guide/plan.md': '# Plan\n\nThe relay ships in January 2027.\n' })
    const failed = runTsx(repo.root, gatePath('doc-times'), ['--base', base])
    expect(failed.status).toBe(1)
    expect(failed.output).toContain('delo/docs/guide/plan.md:3: a deadline')

    const clean = scratchRepo(test)
    const cleanBase = clean.commit({ 'README.md': 'base\n' })
    clean.commit({ 'delo/docs/guide/record.md': '# Record\n\nDecided on 2026-11-05.\n' })
    expect(runTsx(clean.root, gatePath('doc-times'), ['--base', cleanBase]).status).toBe(0)
  }, 60_000)
})
