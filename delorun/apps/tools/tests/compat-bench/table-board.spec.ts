import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { downloadsFor, rankCauses, renderBoard } from '../../src/compat-bench/board.ts'
import { CARD_SCHEMA, INDEPENDENCE_LINE, type Card, type StageResult } from '../../src/compat-bench/card.ts'
import { loadLatestCards } from '../../src/compat-bench/cards-dir.ts'
import { renderTable } from '../../src/compat-bench/table.ts'

const pass = (name: StageResult['name']): StageResult => ({ name, status: 'pass', durationMs: 1, failures: [] })
const fail = (name: StageResult['name'], cause: string, fixClass: 'delorun-fix' | 'delorun-shim' | 'upstream' = 'delorun-fix'): StageResult =>
  ({ name, status: 'fail', durationMs: 1, failures: [{ signature: 'x', evidence: [], cause, fixClass }] })

/** A card for a plugin on a host. */
function card(pluginName: string, host: 'delorun' | 'stock', stages: StageResult[], verdict: Card['verdict'], extra: Partial<Card> = {}): Card {
  return { schema: CARD_SCHEMA, runId: `${pluginName}-${host}`, startedAt: '2026-11-22T10:00:00.000Z', plugin: { package: pluginName }, host: { kind: host, version: host === 'stock' ? '0.2.2-rc.3' : '0.1.0-preview.3', shims: false }, stages, verdict, notes: [], ...extra }
}

const cards: Card[] = [
  card('alpha', 'delorun', [pass('install'), pass('start')], 'works'),
  card('alpha', 'stock', [pass('install'), pass('start')], 'works'),
  card('beta', 'delorun', [pass('install'), fail('clashes', 'studio-overlap', 'delorun-shim')], 'works-with-delorun-fix'),
  card('gamma', 'delorun', [fail('install', 'version-range'), fail('start', 'load-error', 'upstream')], 'blocked'),
  card('delta', 'delorun', [fail('install', 'version-range')], 'blocked'),
  card('held', 'delorun', [fail('install', 'load-error', 'upstream')], 'blocked', { embargo: '2026-12-22' }),
]

describe('the public table', () => {
  const table = renderTable(cards, new Date('2026-11-30T00:00:00Z'))

  it('starts with the A574 line and has a row per plugin and host', () => {
    expect(table).toContain(INDEPENDENCE_LINE)
    expect(table).toContain('| alpha |  | Delorun 0.1.0-preview.3 | Worked in the test | 2 of 2 stages passed |')
    expect(table).toContain('| alpha |  | stock DSH 0.2.2-rc.3 |')
    expect(table).toContain('| beta |  | Delorun 0.1.0-preview.3 | Works once a Delorun fix lands | 1 of 2 stages passed; clashes failed (studio-overlap) |')
  })

  it('has no row for a card under an active embargo, and never says can only or allowed', () => {
    expect(table).not.toContain('| held |')
    expect(renderTable(cards, new Date('2027-01-01T00:00:00Z'))).toContain('| held |')
    expect(table).not.toMatch(/can only|allowed/i)
  })
})

describe('the fix board', () => {
  const downloads = new Map([['beta', 300], ['gamma', 1000], ['delta', 500]])

  it('ranks causes by the downloads of the plugins each one alone blocks', () => {
    const rows = rankCauses(cards, downloads)
    expect(rows[0]).toMatchObject({ cause: 'version-range', unblocked: ['delta'], plugins: ['delta', 'gamma'], downloads: 500 })
    expect(rows.find(row => row.cause === 'studio-overlap')).toMatchObject({ unblocked: ['beta'], downloads: 300 })
    expect(rows.find(row => row.cause === 'load-error')?.unblocked).toEqual(['held'])
    expect(renderBoard(rows)).toContain('| version-range:')
  })

  it('leaves stock cards out of the ranking', () => {
    const rows = rankCauses([card('s', 'stock', [fail('install', 'version-range')], 'blocked')], new Map())
    expect(rows).toEqual([])
  })

  it('fetches downloads once, caches them for a day and prefers a card\'s own figure', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bench-board-'))
    const cache = join(dir, 'downloads.json')
    let calls = 0
    const fetch = (name: string): Promise<number | undefined> => { calls++; return Promise.resolve(name === 'unknown' ? undefined : 42) }
    const input = [card('a', 'delorun', [pass('install')], 'works'), card('own', 'delorun', [pass('install')], 'works', { plugin: { package: 'own', downloads: 7 } }), card('unknown', 'delorun', [pass('install')], 'works')]
    const first = await downloadsFor(input, { fetch, cache, now: 1_000 })
    expect(first.get('a')).toBe(42)
    expect(first.get('own')).toBe(7)
    expect(first.has('unknown')).toBe(false)
    const callsAfterFirst = calls
    await downloadsFor(input, { fetch, cache, now: 2_000 })
    expect(calls - callsAfterFirst).toBe(1)
    await downloadsFor(input, { fetch, cache, now: 1_000 + 25 * 3600 * 1000 })
    expect(calls - callsAfterFirst).toBe(3)
    expect(JSON.parse(readFileSync(cache, 'utf8')).a.downloads).toBe(42)
  })
})

describe('reading a folder of cards', () => {
  it('keeps the newest card of each plugin and host and reports an invalid file', () => {
    const root = mkdtempSync(join(tmpdir(), 'bench-cards-'))
    const write = (name: string, value: unknown): void => { mkdirSync(join(root, name), { recursive: true }); writeFileSync(join(root, name, 'card.json'), JSON.stringify(value)) }
    write('old', card('alpha', 'delorun', [pass('install')], 'works', { startedAt: '2026-11-01T00:00:00.000Z', runId: 'old' }))
    write('new', card('alpha', 'delorun', [pass('install')], 'works', { startedAt: '2026-11-02T00:00:00.000Z', runId: 'new' }))
    write('bad', { schema: 'nope' })
    const warnings: string[] = []
    const loaded = loadLatestCards(root, line => warnings.push(line))
    expect(loaded.map(each => each.card.runId)).toEqual(['new'])
    expect(warnings).toHaveLength(1)
  })
})
